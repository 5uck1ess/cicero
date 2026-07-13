import { TTS_DEFAULT_PORTS, type TTSProvider, type TTSProviderConfig, type TTSOptions } from "./provider";
import { startManagedServer, stopManagedServer, type ManagedProcess } from "../managed-server";
import { httpBase, isLocalHost } from "../net";
import { join, dirname, isAbsolute, resolve } from "path";
import { resolveVenvPython } from "../../platform/python";
import { ciceroPath } from "../../platform/paths";
import { requireLibraryReference } from "../../voice/library-resolve";
import {
  PROVIDER_TIMEOUT_MS,
  providerSignal,
  readBoundedArrayBuffer,
  readErrorDetail,
  requestTimeout,
  responseIsOk,
  sidecarInferenceTimeoutSeconds,
} from "../http-transfer";

export function pocketTtsServerCommand(
  python: string,
  server: string,
  port: number,
  voice: string,
  voiceRoot: string,
  inferenceTimeoutSeconds: number,
): string[] {
  const command = [
    python,
    server,
    "--host", "127.0.0.1",
    "--port", port.toString(),
    "--voice", voice,
    "--voice-root", voiceRoot,
    "--inference-timeout", inferenceTimeoutSeconds.toString(),
  ];
  if (isAbsolute(voice)) {
    command.push("--allow-voice-reference", resolve(voice));
  }
  return command;
}

/**
 * Pocket-TTS (Kyutai, Apache-2.0) — the lowest-latency local voice on Apple
 * Silicon per the on-device bench (~30-50ms TTFA, ~9x realtime on an M4) and
 * zero-shot cloning capable. CPU-only.
 *
 * Pocket-TTS pins its own torch build, so it runs from a dedicated `.venv-pocket`
 * (Python 3.11) rather than the main `.venv` MLX stack. The HTTP surface matches
 * the other TTS backends, so this provider is a drop-in sibling of mlx-audio /
 * kokoro. A `voice` is either a predefined name ("anna") or a path to a reference
 * wav for cloning.
 */
export class PocketTtsProvider implements TTSProvider {
  readonly name = "pocket-tts";
  private host?: string;
  private port: number;
  private voice: string;
  private refAudio?: string;
  private voiceLibraryRoot?: string;
  private readonly timeoutMs: number;
  private managed: ManagedProcess | null = null;

  constructor(config: TTSProviderConfig) {
    this.host = config.host;
    this.port = config.port ?? TTS_DEFAULT_PORTS["pocket-tts"]!;
    this.voice = config.voice && isAbsolute(config.voice)
      ? resolve(config.voice)
      : (config.voice ?? "anna");
    this.refAudio = config.refAudio ? resolve(config.refAudio) : undefined;
    this.voiceLibraryRoot = config.voiceLibraryRoot ? resolve(config.voiceLibraryRoot) : undefined;
    this.timeoutMs = requestTimeout(config.timeout_ms, PROVIDER_TIMEOUT_MS.tts);
  }

  async generateAudio(text: string, voice?: string, options?: TTSOptions): Promise<ArrayBuffer> {
    let voiceArg = this.refAudio ?? this.voice;
    if (voice && voice !== this.voice) {
      // Per-call override (lane switchboard): names a provisioned clone in the
      // voice library. Unknown names throw so a fallback engine (kokoro
      // presets) can take the call — same contract as the audiocpp provider.
      voiceArg = requireLibraryReference("pocket-tts", voice, this.voiceLibraryRoot).reference;
    }
    const response = await fetch(`${httpBase(this.host, this.port)}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: text,
        voice: voiceArg,
        response_format: "wav",
        speed: options?.speed ?? 1.0,
      }),
      signal: providerSignal(this.timeoutMs),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`Pocket-TTS returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    return await readBoundedArrayBuffer(response, undefined, "Pocket-TTS audio response");
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${httpBase(this.host, this.port)}/v1/models`, {
        signal: providerSignal(PROVIDER_TIMEOUT_MS.health),
      });
      return await responseIsOk(res);
    } catch (err: unknown) {
      const { log } = await import("../../logger");
      log("info", `pocket-tts health check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async start(): Promise<void> {
    if (!isLocalHost(this.host)) {
      const { log } = await import("../../logger");
      log("info", `pocket-tts: using remote server at ${httpBase(this.host, this.port)}`);
      return;
    }
    const projectRoot = join(dirname(dirname(dirname(import.meta.dir))));
    const python = resolveVenvPython(join(projectRoot, ".venv-pocket"));
    const server = join(projectRoot, "servers", "tts_pocket_server.py");
    const voiceRoot = this.voiceLibraryRoot ?? ciceroPath("voices");
    const serverVoice = this.refAudio ?? this.voice;

    this.managed = await startManagedServer({
      name: "pocket-tts",
      port: this.port,
      command: pocketTtsServerCommand(
        python,
        server,
        this.port,
        serverVoice,
        voiceRoot,
        sidecarInferenceTimeoutSeconds(this.timeoutMs),
      ),
      healthUrl: `${httpBase(this.host, this.port)}/v1/models`,
      timeoutMs: 60000,
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
    // One short throwaway generation so the model is resident and the voice
    // state is built before the first real utterance. Result is discarded.
    await this.generateAudio("Ready.");
  }
}
