import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
  STT_DEFAULT_PORTS,
  type STTProvider,
  type STTProviderConfig,
  type STTTranscriptionResult,
} from "./provider";
import { startManagedServer, stopManagedServer, type ManagedProcess } from "../managed-server";
import { SerializedLifecycle } from "../serialized-lifecycle";
import { audioCppLocalRuntimePaths } from "../tts/audiocpp";
import { httpBase, isLocalHost } from "../net";
import { log } from "../../logger";
import {
  PROVIDER_TIMEOUT_MS,
  discardResponseBody,
  providerSignal,
  readBoundedJson,
  requestTimeout,
  responseIsOk,
} from "../http-transfer";

/**
 * audio.cpp (ggml) ASR — STT on the SAME native CUDA runtime that already
 * serves TTS, instead of the Python faster-whisper venv. The audio.cpp server
 * loads several models at once and exposes the OpenAI-compatible
 * `/v1/audio/transcriptions` endpoint (multipart, identical wire shape to
 * faster-whisper), so this provider is the faster-whisper transcribe path
 * pointed at the audiocpp server; add an ASR model (e.g. `qwen3-asr`) to the
 * `models` array in servers/audiocpp_server.local.json alongside the TTS entry.
 *
 * This does NOT replace faster-whisper — it is an additional, opt-in backend
 * (`stt.backend: "audiocpp"`). faster-whisper stays the Python default; pick
 * audiocpp when you want the whole voice stack on one runtime and no venv.
 *
 * Shared-server ownership: when TTS is ALSO audiocpp, both seats point at the
 * same server (port 8092). ServerManager always starts TTS before STT, so TTS
 * brings the server up (managed) and STT reuses the healthy port — its handle
 * is `managed:false`, so STT.stop() never kills a server the TTS seat is using
 * (see startManagedServer's already-running reuse). STT only owns the server
 * when TTS is a different backend, in which case it is the sole user.
 */
export class AudioCppSTTProvider implements STTProvider {
  readonly name = "audiocpp";
  private host?: string;
  private port: number;
  private model: string;
  private readonly timeoutMs: number;
  private managed: ManagedProcess | null = null;
  private active = false;
  private cleanupFailure: Error | null = null;
  private readonly lifecycle = new SerializedLifecycle();

  constructor(config: STTProviderConfig) {
    this.host = config.host;
    this.port = config.port ?? STT_DEFAULT_PORTS.audiocpp!; // beside the audio.cpp TTS seat
    this.model = config.model ?? "qwen3-asr";
    this.timeoutMs = requestTimeout(config.timeout_ms, PROVIDER_TIMEOUT_MS.stt);
  }

  transcribe(audioFile: string): Promise<string | null> {
    return this.transcribeResult(audioFile).then((result) => {
      if (result.kind === "failure") {
        log("warn", result.reason);
        return null;
      }
      return result.kind === "transcript" ? result.text : null;
    }).catch((err: unknown) => {
      const message = `audiocpp STT transcription failed: ${err instanceof Error ? err.message : String(err)}`;
      log("warn", message);
      return null;
    });
  }

  async transcribeResult(audioFile: string): Promise<STTTranscriptionResult> {
    try {
      const file = Bun.file(audioFile);
      const formData = new FormData();
      // Keep the real extension — the server may pick a decoder by filename.
      formData.append("file", file, basename(audioFile) || "audio.wav");
      formData.append("model", this.model);
      formData.append("response_format", "json");

      const res = await fetch(`${httpBase(this.host, this.port)}/v1/audio/transcriptions`, {
        method: "POST",
        body: formData,
        signal: providerSignal(this.timeoutMs),
      });

      if (!res.ok) {
        await discardResponseBody(res);
        return { kind: "failure", reason: `audiocpp STT returned ${res.status}` };
      }

      const data = await readBoundedJson<{ text?: string }>(res);
      const text = (data.text ?? "").trim();
      if (!text || text.length < 2) return { kind: "empty" };
      return { kind: "transcript", text };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: "failure", reason: `audiocpp STT transcription failed: ${msg}` };
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${httpBase(this.host, this.port)}/v1/models`, {
        signal: providerSignal(PROVIDER_TIMEOUT_MS.health),
      });
      return await responseIsOk(res);
    } catch (err: unknown) {
      log("info", `audiocpp STT health check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  start(): Promise<void> {
    // Idempotent: a live handle means we're already up (a second start() must
    // not overwrite it and orphan the managed process). Concurrent starts
    // coalesce onto one launch, so two callers can't both spawn/reuse; the
    // in-flight promise clears once settled, after which `managed` guards.
    return this.lifecycle.run("start", () => {
      if (this.cleanupFailure) {
        throw new Error(
          `audiocpp STT restart is blocked because prior cleanup failed: ${this.cleanupFailure.message.slice(0, 120)}`,
          { cause: this.cleanupFailure },
        );
      }
      if (this.active) return Promise.resolve();
      return this.doStart();
    });
  }

  private async doStart(): Promise<void> {
    try {
      if (!isLocalHost(this.host)) {
        log("info", `audiocpp STT: using remote server at ${httpBase(this.host, this.port)}`);
        this.active = true;
        return;
      }
      const { binary, serverConfig } = audioCppLocalRuntimePaths();
      // Both are machine-local (vendor build + model paths) — fail with a pointer, not a spawn error.
      if (!existsSync(binary)) {
        throw new Error(`audiocpp binary not found at ${binary} — build vendor/audio.cpp (cmake preset linux-cuda-release)`);
      }
      if (!existsSync(serverConfig)) {
        throw new Error(`audiocpp server config not found at ${serverConfig} — add a task:"asr" model to servers/audiocpp_server.local.json`);
      }

      this.managed = await startManagedServer({
        name: "audiocpp-stt",
        port: this.port,
        command: [binary, "--config", serverConfig, "--host", "127.0.0.1", "--port", this.port.toString()],
        // Reuses the seat if TTS already brought it up healthy on this port.
        healthUrl: `${httpBase(this.host, this.port)}/v1/models`,
        timeoutMs: 90000,
        supervise: true,
      });
      this.active = this.managed !== null;
    } catch (error: unknown) {
      throw error;
    }
  }

  stop(): Promise<void> {
    // A stop() racing an in-flight start() must let the launch settle first,
    // else it returns before `managed` is assigned and orphans the server.
    return this.lifecycle.run("stop", async () => {
      try {
        await this.doStop();
        this.cleanupFailure = null;
      } catch (error: unknown) {
        this.cleanupFailure = error instanceof Error ? error : new Error(String(error));
        throw this.cleanupFailure;
      }
    });
  }

  private async doStop(): Promise<void> {
    try {
      const managed = this.managed;
      if (!managed) return;
      await stopManagedServer(managed);
      if (this.managed === managed) this.managed = null;
    } catch (error: unknown) {
      throw error;
    } finally {
      this.active = false;
    }
  }
}
