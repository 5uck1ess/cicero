import { TTS_DEFAULT_PORTS, type TTSProvider, type TTSProviderConfig, type TTSOptions } from "./provider";
import { startManagedServer, stopManagedServer, type ManagedProcess } from "../managed-server";
import { httpBase, isLocalHost } from "../net";
import { join, dirname } from "node:path";
import { resolveVenvPython } from "../../platform/python";
import { requireLibraryReference } from "../../voice/library-resolve";
import {
  PROVIDER_TIMEOUT_MS,
  providerSignal,
  readBoundedArrayBuffer,
  readErrorDetail,
  requestTimeout,
  responseIsOk,
} from "../http-transfer";

export const VIBEVOICE_HEALTH_PATH = "/v1/health";
export const DEFAULT_VIBEVOICE_MODEL = "vibevoice/VibeVoice-1.5B";

/** Command exposed for portability tests without starting or downloading a model. */
export function vibeVoiceServerCommand(python: string, port: number, model: string): string[] {
  return [
    python,
    "-m",
    "vibevoice_api.server",
    "--host",
    "127.0.0.1",
    "--port",
    port.toString(),
    "--model_path",
    model,
  ];
}

export class VibeVoiceProvider implements TTSProvider {
  readonly name = "vibevoice";
  private host?: string;
  private port: number;
  private model: string;
  private voice: string;
  private refAudio?: string;
  private voiceLibraryRoot?: string;
  private readonly timeoutMs: number;
  private managed: ManagedProcess | null = null;

  constructor(config: TTSProviderConfig) {
    this.host = config.host;
    this.port = config.port ?? TTS_DEFAULT_PORTS.vibevoice!;
    this.model = config.model ?? DEFAULT_VIBEVOICE_MODEL;
    this.voice = config.voice ?? "default";
    this.refAudio = config.refAudio;
    this.voiceLibraryRoot = config.voiceLibraryRoot;
    this.timeoutMs = requestTimeout(config.timeout_ms, PROVIDER_TIMEOUT_MS.tts);
  }

  async generateAudio(text: string, voice?: string, options?: TTSOptions): Promise<ArrayBuffer> {
    let selectedVoice = this.voice;
    let reference = this.refAudio;
    if (voice && voice !== this.voice) {
      const resolved = requireLibraryReference("vibevoice", voice, this.voiceLibraryRoot);
      selectedVoice = voice;
      reference = resolved.reference;
    }
    const payload: Record<string, unknown> = {
      input: text,
      model: this.model,
      voice: selectedVoice,
      response_format: "wav",
    };
    if (options?.speed !== undefined) payload.speed = options.speed;

    if (reference) {
      // The pinned vibevoice_api.server SpeechRequest uses voice_path. Keep
      // this wire name tied to its native contract test; ref_audio/ref_text are
      // fields from a different, incompatible VibeVoice HTTP implementation.
      payload.voice_path = reference;
    }

    const response = await fetch(`${httpBase(this.host, this.port)}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: providerSignal(this.timeoutMs),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`VibeVoice returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    return await readBoundedArrayBuffer(response, undefined, "VibeVoice audio response");
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${httpBase(this.host, this.port)}${VIBEVOICE_HEALTH_PATH}`, {
        signal: providerSignal(PROVIDER_TIMEOUT_MS.health),
      });
      return await responseIsOk(res);
    } catch (err: unknown) {
      const { log } = await import("../../logger");
      log("info", `vibevoice health check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async start(): Promise<void> {
    if (!isLocalHost(this.host)) {
      const { log } = await import("../../logger");
      log("info", `vibevoice: using remote server at ${httpBase(this.host, this.port)}`);
      return;
    }
    const projectRoot = dirname(dirname(dirname(import.meta.dir)));
    const python = resolveVenvPython(join(projectRoot, ".venv-vibevoice"));
    this.managed = await startManagedServer({
      name: "vibevoice",
      port: this.port,
      command: vibeVoiceServerCommand(python, this.port, this.model),
      healthUrl: `${httpBase(this.host, this.port)}${VIBEVOICE_HEALTH_PATH}`,
      // First launch may fetch and initialize the selected model.
      timeoutMs: 300000,
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
