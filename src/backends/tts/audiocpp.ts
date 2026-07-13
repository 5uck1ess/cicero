import { existsSync } from "node:fs";
import { TTS_DEFAULT_PORTS, type TTSProvider, type TTSProviderConfig, type TTSOptions } from "./provider";
import { startManagedServer, stopManagedServer, type ManagedProcess } from "../managed-server";
import { httpBase, isLocalHost } from "../net";
import { join, dirname, resolve } from "path";
import { requireLibraryReference, resolveLibraryVoice } from "../../voice/library-resolve";
import {
  acquireAudioCppSafeReference,
  type AudioCppReferenceLease,
} from "../../voice/audio-reference";
import {
  PROVIDER_TIMEOUT_MS,
  abortableDelay,
  providerSignal,
  readBoundedArrayBuffer,
  readErrorDetail,
  requestTimeout,
  responseIsOk,
} from "../http-transfer";

export interface AudioCppLocalRuntimePaths {
  binary: string;
  serverConfig: string;
}

const MAX_HELD_REFERENCE_LEASES = 16;

interface AudioCppReferenceUse {
  path: string;
  release(): void;
}

export function audioCppLocalRuntimePaths(
  root: string = dirname(dirname(dirname(import.meta.dir))),
): AudioCppLocalRuntimePaths {
  return {
    binary: join(root, "vendor", "audio.cpp", "build", "linux-cuda-release", "bin", "audiocpp_server"),
    serverConfig: join(root, "servers", "audiocpp_server.local.json"),
  };
}

/**
 * audio.cpp (ggml) TTS server — the local voice-cloning seat. On the 3090 the
 * pocket-tts family clones a voice from a reference WAV at kokoro-class speed
 * (~36-46ms warm short sentence, 72ms medium — measured 2026-07-05), because
 * the server caches the prepared voice state after the first utterance. Point
 * `refAudio` at any reference clip for zero-shot cloning, or `voice` at a
 * packaged voice id. Requires the untracked CUDA build under vendor/audio.cpp
 * and the machine-local model config servers/audiocpp_server.local.json.
 */
export class AudioCppProvider implements TTSProvider {
  readonly name = "audiocpp";
  private host?: string;
  private port: number;
  private model: string;
  private voice?: string;
  private refAudio?: string;
  private voiceLibraryRoot?: string;
  private referenceCacheRoot?: string;
  private readonly timeoutMs: number;
  private managed: ManagedProcess | null = null;
  private acceptingRenders = true;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private lifecycleIntent = 0;
  private lifecycleTailKind: "start" | "stop" | null = null;
  private stopTask: Promise<void> | null = null;
  /**
   * Provider-local LRU of live immutable leases. Sequential streaming
   * sentences pay only stat validation; source copy/hash/fsync runs on first
   * use or after the selected source fingerprint changes.
   */
  private heldReferences = new Map<string, AudioCppReferenceLease>();

  constructor(config: TTSProviderConfig) {
    this.host = config.host;
    this.port = config.port ?? TTS_DEFAULT_PORTS.audiocpp!;
    this.model = config.model ?? "pocket-tts";
    this.voice = config.voice;
    this.refAudio = config.refAudio;
    this.voiceLibraryRoot = config.voiceLibraryRoot;
    this.referenceCacheRoot = config.referenceCacheRoot;
    this.timeoutMs = requestTimeout(config.timeout_ms, PROVIDER_TIMEOUT_MS.tts);
  }

  /** Renders are SERIALIZED: two concurrent requests where one is a cold
   * voice prep make overlapping transient GPU allocations and SIGABRT the
   * server (seen live 2026-07-11: transfer greeting + filler clip → exit
   * 134). Warm renders take ~50ms, so queueing costs nothing audible. */
  private queue: Promise<unknown> = Promise.resolve();

  generateAudio(text: string, voice?: string, options?: TTSOptions): Promise<ArrayBuffer> {
    if (!this.acceptingRenders) {
      return Promise.reject(new Error("audio.cpp provider is stopped"));
    }
    const run = this.queue.then(() => this.render(text, voice, options));
    this.queue = run.catch(() => {}); // a failed render must not poison the chain
    return run;
  }

  private async render(text: string, voice?: string, options?: TTSOptions): Promise<ArrayBuffer> {
    const payload: Record<string, unknown> = { model: this.model, input: text };
    if (options?.speed !== undefined) payload.speed = options.speed;
    const reference = await this.acquireReference(voice);
    try {
      if (reference) payload.voice_ref = reference.path;
      else if (this.voice) payload.voice = this.voice;

      const url = `${httpBase(this.host, this.port)}/v1/audio/speech`;
      const signal = providerSignal(this.timeoutMs);
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      };
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (err: unknown) {
        // The FIRST cold prep of a brand-new reference can SIGABRT the server
        // mid-request (reproduced 3x provisioning a new voice, 2026-07-10); the
        // supervisor revives it within seconds and the same request then
        // succeeds. Retry once — but only on a reset (server died talking to
        // us). A dead server refuses the connection instead, and that must
        // keep failing fast so the fallback engine takes the sentence.
        if ((err as { code?: string })?.code !== "ECONNRESET") throw err;
        await abortableDelay(10_000, signal);
        response = await fetch(url, init);
      }

      if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new Error(`audio.cpp returned ${response.status}${detail ? `: ${detail}` : ""}`);
      }

      return await readBoundedArrayBuffer(response, undefined, "audio.cpp audio response");
    } finally {
      reference?.release();
    }
  }

  private async acquireReference(voice?: string): Promise<AudioCppReferenceUse | null> {
    let input: string | null = null;
    let preferProvisionedDerivative = false;
    if (voice && voice !== this.voice) {
      // A per-call override names a provisioned clone in the voice library.
      // The owned lease survives until the external request has completed.
      const resolved = requireLibraryReference("audiocpp", voice, this.voiceLibraryRoot);
      input = resolved.reference;
      preferProvisionedDerivative = true;
    } else if (this.refAudio) {
      input = this.refAudio;
      preferProvisionedDerivative = this.isConfiguredLibraryReference(this.refAudio);
    }
    if (!input) return null;

    const key = `${resolve(input)}\0${preferProvisionedDerivative}`;
    const cached = this.heldReferences.get(key);
    if (cached) {
      if (await cached.isCurrent()) {
        this.heldReferences.delete(key);
        this.heldReferences.set(key, cached);
        return { path: cached.path, release() {} };
      }
      this.heldReferences.delete(key);
      cached.release();
    }

    // Never retain a rejected acquisition. A temporarily missing or malformed
    // source is retried on the next sentence after the operator repairs it.
    const lease = await acquireAudioCppSafeReference(input, {
      preferProvisionedDerivative,
      cacheRoot: this.referenceCacheRoot,
    });
    this.heldReferences.set(key, lease);
    while (this.heldReferences.size > MAX_HELD_REFERENCE_LEASES) {
      const oldestKey = this.heldReferences.keys().next().value as string | undefined;
      if (!oldestKey || oldestKey === key) break;
      const oldest = this.heldReferences.get(oldestKey);
      this.heldReferences.delete(oldestKey);
      oldest?.release();
    }
    return { path: lease.path, release() {} };
  }

  private isConfiguredLibraryReference(reference: string): boolean {
    if (!this.voice) return false;
    try {
      return resolveLibraryVoice("audiocpp", this.voice, this.voiceLibraryRoot)?.reference === reference;
    } catch {
      // A direct refAudio remains valid even if its optional voice label is not
      // an audio.cpp library entry. Only a matching manifest grants provenance.
      return false;
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${httpBase(this.host, this.port)}/v1/models`, {
        signal: providerSignal(PROVIDER_TIMEOUT_MS.health),
      });
      return await responseIsOk(res);
    } catch (err: unknown) {
      const { log } = await import("../../logger");
      log("info", `audiocpp health check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  start(): Promise<void> {
    const intent = ++this.lifecycleIntent;
    this.lifecycleTailKind = "start";
    const task = this.lifecycleTail.then(async () => {
      if (!isLocalHost(this.host)) {
        const { log } = await import("../../logger");
        log("info", `audiocpp: using remote server at ${httpBase(this.host, this.port)}`);
      } else if (!this.managed) {
        const { binary, serverConfig } = audioCppLocalRuntimePaths();
        // Both are machine-local (vendor build + model paths) — fail with a pointer, not a spawn error.
        if (!existsSync(binary)) {
          throw new Error(`audiocpp binary not found at ${binary} — build vendor/audio.cpp (cmake preset linux-cuda-release)`);
        }
        if (!existsSync(serverConfig)) {
          throw new Error(`audiocpp server config not found at ${serverConfig} — see servers/audiocpp_server.local.json on the 3090 box`);
        }

        this.managed = await startManagedServer({
          name: "audiocpp",
          port: this.port,
          command: [binary, "--config", serverConfig, "--host", "127.0.0.1", "--port", this.port.toString()],
          healthUrl: `${httpBase(this.host, this.port)}/v1/models`,
          timeoutMs: 90000,
          // The cloned-voice seat dies quietly under VRAM pressure and every clip
          // then falls back to kokoro presets — revive it instead (2026-07-06).
          supervise: true,
        });
      }
      // Calls are ordered by the lifecycle tail, but a later stop closes
      // admission synchronously. A superseded start must not reopen it while
      // that stop is waiting behind this launch to reap the new handle.
      if (this.lifecycleIntent === intent) this.acceptingRenders = true;
    });
    this.lifecycleTail = task.catch(() => { /* later lifecycle calls still run */ });
    return task;
  }

  stop(): Promise<void> {
    this.acceptingRenders = false;
    this.lifecycleIntent += 1;
    if (this.lifecycleTailKind === "stop" && this.stopTask) return this.stopTask;
    this.lifecycleTailKind = "stop";
    const task = this.lifecycleTail.then(() => this.stopAndReleaseReferences());
    const tracked = task.finally(() => {
      if (this.stopTask === tracked) this.stopTask = null;
    });
    this.stopTask = tracked;
    this.lifecycleTail = tracked.catch(() => { /* later lifecycle calls still run */ });
    return tracked;
  }

  private async stopAndReleaseReferences(): Promise<void> {
    // The serialized queue owns every active external open/read window. Drain
    // it before unpinning held leases or stopping the shared server.
    await this.queue;
    try {
      if (this.managed) {
        const managed = this.managed;
        try {
          await stopManagedServer(managed);
        } finally {
          if (this.managed === managed) this.managed = null;
        }
      }
    } finally {
      for (const lease of this.heldReferences.values()) lease.release();
      this.heldReferences.clear();
    }
  }

  async warmup(): Promise<void> {
    // One short throwaway generation loads the model AND prepares/caches the
    // cloned voice state, so the first real utterance runs at warm speed.
    await this.generateAudio("Ready.");
  }
}
