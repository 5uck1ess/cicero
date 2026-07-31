import { TTS_DEFAULT_PORTS, type TTSProvider, type TTSProviderConfig, type TTSOptions } from "./provider";
import { startManagedServer, stopManagedServer, type ManagedProcess } from "../managed-server";
import { httpBase, isLocalHost } from "../net";
import { join, dirname } from "path";
import { resolveVenvPython } from "../../platform/python";
import {
  PROVIDER_TIMEOUT_MS,
  providerSignal,
  readBoundedArrayBuffer,
  readErrorDetail,
  requestTimeout,
  responseIsOk,
} from "../http-transfer";

export class MlxAudioProvider implements TTSProvider {
  readonly name = "mlx-audio";
  private host?: string;
  private port: number;
  private model: string;
  private voice: string;
  private refAudio?: string;
  private refText?: string;
  private readonly timeoutMs: number;
  /** Fresh cancellation scope for one startup; replaces any settled predecessor. */
  private beginStartup(): AbortSignal {
    const abort = new AbortController();
    this.startAbort = abort;
    return abort.signal;
  }

  /**
   * Latch synchronously, BEFORE any await, so a launch in flight sees it and
   * reaps the child it already spawned. Public because an owner holding a
   * candidate (see ProviderSlot) must be able to cancel a minutes-long startup
   * without waiting it out first. Safe to call at any time, including twice.
   */
  cancelStartup(): void {
    this.startAbort?.abort(new Error("mlx-audio" + " is stopping"));
    this.startAbort = null;
  }

  private managed: ManagedProcess | null = null;
  /** Cancels a startup still in flight, so stop() can reach a child that
   *  start() has not published yet. Set synchronously by stop(). */
  private startAbort: AbortController | null = null;

  constructor(config: TTSProviderConfig) {
    this.host = config.host;
    this.port = config.port ?? TTS_DEFAULT_PORTS["mlx-audio"]!;
    this.model = config.model ?? "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16";
    this.voice = config.voice ?? "Ryan";
    this.refAudio = config.refAudio;
    this.refText = config.refText;
    this.timeoutMs = requestTimeout(config.timeout_ms, PROVIDER_TIMEOUT_MS.tts);
  }

  async generateAudio(text: string, voice?: string, options?: TTSOptions): Promise<ArrayBuffer> {
    const overridesConfiguredClone = Boolean(voice && voice !== this.voice);
    const payload: Record<string, unknown> = {
      model: this.model,
      input: text,
      voice: voice ?? this.voice,
      response_format: "wav",
      speed: options?.speed ?? 1.0,
      lang_code: "en",
    };

    if (this.refAudio && !overridesConfiguredClone) {
      payload.ref_audio = this.refAudio;
      if (this.refText) {
        payload.ref_text = this.refText;
      }
    }

    const response = await fetch(`${httpBase(this.host, this.port)}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: providerSignal(this.timeoutMs),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`TTS server returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    return await readBoundedArrayBuffer(response, undefined, "MLX audio response");
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${httpBase(this.host, this.port)}/v1/models`, {
        signal: providerSignal(PROVIDER_TIMEOUT_MS.health),
      });
      return await responseIsOk(res);
    } catch (err: unknown) {
      const { log } = await import("../../logger");
      log("info", `mlx-audio health check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async start(): Promise<void> {
    if (!isLocalHost(this.host)) {
      const { log } = await import("../../logger");
      log("info", `mlx-audio: using remote server at ${httpBase(this.host, this.port)}`);
      return;
    }
    const projectRoot = join(dirname(dirname(dirname(import.meta.dir))));
    const python = resolveVenvPython(join(projectRoot, ".venv"));

    this.managed = await startManagedServer({
      signal: this.beginStartup(),
      name: "mlx-audio",
      port: this.port,
      command: [python, "-m", "mlx_audio.server", "--host", "127.0.0.1", "--port", this.port.toString()],
      healthUrl: `${httpBase(this.host, this.port)}/v1/models`,
      timeoutMs: 60000,
    });
  }

  async stop(): Promise<void> {
    // Synchronous, before any await: a startup still in flight must see this.
    this.cancelStartup();
    if (this.managed) {
      const managed = this.managed;
      try {
        await stopManagedServer(managed);
      } finally {
        if (this.managed === managed) this.managed = null;
      }
    }
  }

  async warmup(): Promise<void> {
    // One short throwaway generation forces model load into VRAM so the first
    // real utterance is fast. Result is discarded.
    await this.generateAudio("Ready.");
  }
}
