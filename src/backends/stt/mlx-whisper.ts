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
import { encodeSilentWav } from "../../platform/wav";
import { unlink } from "node:fs/promises";
import { writeSecureTempAudio } from "../../platform/secure-temp-audio";
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

export class MlxWhisperProvider implements STTProvider {
  readonly name = "mlx-whisper";
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
    this.port = config.port ?? STT_DEFAULT_PORTS["mlx-whisper"]!;
    this.model = config.model ?? "mlx-community/whisper-large-v3-turbo";
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
      const message = `Transcription failed: ${err instanceof Error ? err.message : String(err)}`;
      log("warn", message);
      return null;
    });
  }

  async transcribeResult(audioFile: string): Promise<STTTranscriptionResult> {
    try {
      const file = Bun.file(audioFile);
      const formData = new FormData();
      formData.append("file", file, "audio.wav");
      formData.append("response_format", "json");

      const res = await fetch(`${httpBase(this.host, this.port)}/inference`, {
        method: "POST",
        body: formData,
        signal: providerSignal(this.timeoutMs),
      });

      if (!res.ok) {
        await discardResponseBody(res);
        return { kind: "failure", reason: `Whisper server returned ${res.status}` };
      }

      const data = await readBoundedJson<{ text?: string }>(res);
      const raw = data.text ?? "";

      const text = raw
        .replace(/\[.*?\]/g, "")
        .replace(/\(.*?\)/g, "")
        .trim();

      if (!text || text.length < 2) return { kind: "empty" };
      return { kind: "transcript", text };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: "failure", reason: `Transcription failed: ${msg}` };
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${httpBase(this.host, this.port)}/`, {
        signal: providerSignal(PROVIDER_TIMEOUT_MS.health),
      });
      return await responseIsOk(res);
    } catch (err: unknown) {
      log("info", `mlx-whisper health check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** One silent inference at boot so the first real utterance isn't a cold load. */
  async warmup(): Promise<void> {
    let tmp: string | undefined;
    try {
      tmp = await writeSecureTempAudio(encodeSilentWav(), { prefix: "cicero-stt-warm" });
      await this.transcribe(tmp);
      log("ok", "STT model warmed");
    } catch (err: unknown) {
      log("info", `mlx-whisper warmup skipped: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (tmp) await unlink(tmp).catch(() => { /* best-effort cleanup */ });
    }
  }

  start(): Promise<void> {
    return this.lifecycle.run("start", () => {
      if (this.cleanupFailure) {
        throw new Error(
          `mlx-whisper restart is blocked because prior cleanup failed: ${this.cleanupFailure.message.slice(0, 120)}`,
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
        log("info", `mlx-whisper: using remote server at ${httpBase(this.host, this.port)}`);
        this.active = true;
        return;
      }
      const projectRoot = join(dirname(dirname(dirname(import.meta.dir))));
      const python = resolveVenvPython(join(projectRoot, ".venv"));
      const sttScript = join(projectRoot, "servers", "stt_server.py");

      this.managed = await startManagedServer({
        name: "mlx-whisper",
        port: this.port,
        command: [
          python,
          sttScript,
          "--port", this.port.toString(),
          "--host", "127.0.0.1",
          "--model", this.model,
          "--inference-timeout", sidecarInferenceTimeoutSeconds(this.timeoutMs).toString(),
        ],
        healthUrl: `${httpBase(this.host, this.port)}/`,
        timeoutMs: 60000,
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
