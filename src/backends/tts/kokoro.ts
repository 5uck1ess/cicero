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
  sidecarInferenceTimeoutSeconds,
} from "../http-transfer";

/**
 * Kokoro-82M (hexgrad, Apache-2.0) — Cicero's cross-platform voice. Real-time on
 * CUDA (~33-83ms/sentence warm, 38-141x realtime on a 3090 in the local bench),
 * CPU, and Apple MPS, with ~50 preset voices. PyTorch-CUDA was the lowest-latency
 * kokoro engine across short->long sentences in the bench (beat ONNX-CUDA on
 * medium/long), so this launches the PyTorch `KPipeline` path via a dedicated
 * `.venv-kokoro` (same pattern as pocket-tts's `.venv-pocket`). The server
 * pre-warms with a dummy generation so the first real utterance is warm.
 */
export class KokoroProvider implements TTSProvider {
  readonly name = "kokoro";
  private host?: string;
  private port: number;
  private voice: string;
  private managed: ManagedProcess | null = null;
  private device: string;
  private readonly timeoutMs: number;

  constructor(config: TTSProviderConfig) {
    this.host = config.host;
    this.port = config.port ?? TTS_DEFAULT_PORTS.kokoro!;
    this.voice = config.voice ?? "am_echo"; // Cicero persona voice
    this.device = config.device ?? "auto";
    this.timeoutMs = requestTimeout(config.timeout_ms, PROVIDER_TIMEOUT_MS.tts);
  }

  async generateAudio(text: string, voice?: string, options?: TTSOptions): Promise<ArrayBuffer> {
    const response = await fetch(`${httpBase(this.host, this.port)}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: text,
        voice: voice ?? this.voice,
        response_format: "wav",
        speed: options?.speed ?? 1.0,
      }),
      signal: providerSignal(this.timeoutMs),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`Kokoro returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    return await readBoundedArrayBuffer(response, undefined, "Kokoro audio response");
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${httpBase(this.host, this.port)}/v1/models`, {
        signal: providerSignal(PROVIDER_TIMEOUT_MS.health),
      });
      return await responseIsOk(res);
    } catch (err: unknown) {
      const { log } = await import("../../logger");
      log("info", `kokoro health check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async start(): Promise<void> {
    if (!isLocalHost(this.host)) {
      const { log } = await import("../../logger");
      log("info", `kokoro: using remote server at ${httpBase(this.host, this.port)}`);
      return;
    }
    const projectRoot = join(dirname(dirname(dirname(import.meta.dir))));
    const python = resolveVenvPython(join(projectRoot, ".venv-kokoro"));
    const server = join(projectRoot, "servers", "tts_kokoro_server.py");

    this.managed = await startManagedServer({
      name: "kokoro",
      port: this.port,
      command: [
        python,
        server,
        "--host", "127.0.0.1",
        "--port", this.port.toString(),
        "--voice", this.voice,
        "--device", this.device,
        "--inference-timeout", sidecarInferenceTimeoutSeconds(this.timeoutMs).toString(),
      ],
      // The server pre-warms with a dummy generation before health goes green;
      // on the GPU path that first inference is slow (~670ms), so allow headroom.
      healthUrl: `${httpBase(this.host, this.port)}/v1/models`,
      timeoutMs: 90000,
      supervise: true,
    });
  }

  async stop(): Promise<void> {
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
