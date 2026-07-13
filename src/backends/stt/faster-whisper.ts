import {
  STT_DEFAULT_PORTS,
  type STTProvider,
  type STTProviderConfig,
  type STTTranscriptionResult,
} from "./provider";
import { startManagedServer, stopManagedServer, type ManagedProcess } from "../managed-server";
import { SerializedLifecycle } from "../serialized-lifecycle";
import { httpBase, isLocalHost } from "../net";
import { log } from "../../logger";
import { join, dirname } from "path";
import { resolveVenvPython } from "../../platform/python";
import {
  PROVIDER_TIMEOUT_MS,
  discardResponseBody,
  providerSignal,
  readBoundedJson,
  requestTimeout,
  responseIsOk,
  sidecarInferenceTimeoutSeconds,
} from "../http-transfer";

/**
 * faster-whisper (CTranslate2) STT — the CUDA/CPU sibling of mlx-whisper. CT2 is
 * the fastest practical Whisper engine on an NVIDIA GPU (custom kernels, FP16),
 * ahead of raw PyTorch and whisper.cpp/ggml for the short single-utterance turns
 * a voice loop transcribes, and runs the SAME model as the Mac path
 * (`large-v3-turbo` == the CT2 build of MLX's `whisper-large-v3-turbo`).
 * Launches servers/stt_faster_whisper_server.py from a
 * dedicated `.venv-stt` (same pattern as kokoro's `.venv-kokoro`); the server
 * pre-warms on silence so the first real utterance is warm.
 */
export class FasterWhisperProvider implements STTProvider {
  readonly name = "faster-whisper";
  private host?: string;
  private port: number;
  private model: string;
  private computeType?: string;
  private readonly timeoutMs: number;
  private managed: ManagedProcess | null = null;
  private active = false;
  private cleanupFailure: Error | null = null;
  private readonly lifecycle = new SerializedLifecycle();

  constructor(config: STTProviderConfig) {
    this.host = config.host;
    this.port = config.port ?? STT_DEFAULT_PORTS["faster-whisper"]!;
    this.model = config.model ?? "large-v3-turbo";
    this.computeType = config.compute_type;
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
      const message = `faster-whisper transcription failed: ${err instanceof Error ? err.message : String(err)}`;
      log("warn", message);
      return null;
    });
  }

  async transcribeResult(audioFile: string): Promise<STTTranscriptionResult> {
    try {
      const file = Bun.file(audioFile);
      const formData = new FormData();
      formData.append("file", file, "audio.wav");
      formData.append("model", this.model);
      formData.append("response_format", "json");

      const res = await fetch(`${httpBase(this.host, this.port)}/v1/audio/transcriptions`, {
        method: "POST",
        body: formData,
        signal: providerSignal(this.timeoutMs),
      });

      if (!res.ok) {
        await discardResponseBody(res);
        return { kind: "failure", reason: `faster-whisper returned ${res.status}` };
      }

      const data = await readBoundedJson<{ text?: string }>(res);
      const text = (data.text ?? "").trim();
      if (!text || text.length < 2) return { kind: "empty" };
      return { kind: "transcript", text };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: "failure", reason: `faster-whisper transcription failed: ${msg}` };
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${httpBase(this.host, this.port)}/health`, {
        signal: providerSignal(PROVIDER_TIMEOUT_MS.health),
      });
      return await responseIsOk(res);
    } catch (err: unknown) {
      log("info", `faster-whisper health check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  start(): Promise<void> {
    return this.lifecycle.run("start", () => {
      if (this.cleanupFailure) {
        throw new Error(
          `faster-whisper restart is blocked because prior cleanup failed: ${this.cleanupFailure.message.slice(0, 120)}`,
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
        log("info", `faster-whisper: using remote server at ${httpBase(this.host, this.port)}`);
        this.active = true;
        return;
      }
      const projectRoot = join(dirname(dirname(dirname(import.meta.dir))));
      const python = resolveVenvPython(join(projectRoot, ".venv-stt"));
      const server = join(projectRoot, "servers", "stt_faster_whisper_server.py");

      this.managed = await startManagedServer({
        name: "faster-whisper",
        port: this.port,
        command: [python, server, "--host", "127.0.0.1", "--port", this.port.toString(), "--model", this.model,
          "--inference-timeout", sidecarInferenceTimeoutSeconds(this.timeoutMs).toString(),
          // int8_float16 halves VRAM on GPUs with INT8 tensor cores (Ampere+) at
          // negligible WER cost — the knob that lets STT share the card politely.
          ...(this.computeType ? ["--compute-type", this.computeType] : [])],
        // The server loads the model + pre-warms on silence before health goes
        // green; the first GPU pass is slow, and a cold model download slower, so
        // allow generous headroom.
        healthUrl: `${httpBase(this.host, this.port)}/health`,
        timeoutMs: 300000,
        supervise: true,
      });
      this.active = this.managed !== null;
    } catch (error: unknown) {
      throw error;
    }
  }

  stop(): Promise<void> {
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
