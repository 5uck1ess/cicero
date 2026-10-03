import type { TTSOptions, TTSProvider, TTSProviderConfig } from "./provider";
import { wavFromPcm } from "../wyoming/audio";
import {
  checkCloudSpeechKey,
  cloudSpeechApiKey,
  cloudSpeechBackend,
  scrubProviderText,
  type CloudSpeechBackend,
} from "../cloud-speech";
import {
  PROVIDER_RESPONSE_LIMIT_BYTES,
  PROVIDER_TIMEOUT_MS,
  providerSignal,
  readBoundedBytes,
  readErrorDetail,
  requestTimeout,
} from "../http-transfer";
import { log } from "../../logger";

export const SONIOX_TTS_URL = "https://tts-rt.soniox.com/tts";
const SAMPLE_RATE = 24_000;
/** Soniox rejects longer inputs; a voice-turn chunk is far below it. */
const MAX_TEXT_CHARS = 5_000;
/** Soniox accepts speed in this closed range. */
const MIN_SPEED = 0.7;
const MAX_SPEED = 1.3;

export interface SonioxTtsDeps {
  fetcher?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/**
 * Soniox text-to-speech over its one-shot REST endpoint: one sentence in,
 * raw 24 kHz PCM out, wrapped into Cicero's WAV contract. The REST form avoids
 * the websocket's connect-and-idle timers entirely, which matters because
 * Cicero synthesizes one sentence group per request.
 *
 * Voices are Soniox presets (for example "Iris"); `language` comes from the
 * config's `language` field and defaults to English.
 */
export class SonioxTTSProvider implements TTSProvider {
  readonly name = "soniox";
  private readonly entry: CloudSpeechBackend;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly language: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(config: TTSProviderConfig & { language?: string }, deps: SonioxTtsDeps = {}) {
    this.entry = cloudSpeechBackend("tts", "soniox")!;
    this.apiKey = cloudSpeechApiKey(this.entry, config.apiKey, deps.env);
    this.model = config.model ?? this.entry.defaultModel;
    this.voice = config.voice ?? this.entry.defaultVoice!;
    this.language = (config.language ?? "en").split("-", 1)[0]!.toLowerCase();
    this.timeoutMs = requestTimeout(config.timeout_ms, PROVIDER_TIMEOUT_MS.tts);
    this.fetcher = deps.fetcher ?? fetch;
  }

  async generateAudio(text: string, voice?: string, options?: TTSOptions): Promise<ArrayBuffer> {
    options?.signal?.throwIfAborted();
    if (!this.apiKey) throw new Error(`Soniox API key not found; set ${this.entry.apiKeyEnv}`);
    if (text.length > MAX_TEXT_CHARS) throw new Error(`Soniox TTS input exceeds ${MAX_TEXT_CHARS} characters`);
    const body: Record<string, unknown> = {
      model: this.model,
      language: this.language,
      voice: voice || this.voice,
      audio_format: "pcm_s16le",
      sample_rate: SAMPLE_RATE,
      text,
    };
    if (options?.speed !== undefined && Number.isFinite(options.speed)) {
      body.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, options.speed));
    }
    const response = await this.fetcher(SONIOX_TTS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: providerSignal(this.timeoutMs, options?.signal),
    });
    if (!response.ok) {
      const detail = scrubProviderText(await readErrorDetail(response), this.apiKey);
      throw new Error(`Soniox TTS returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const pcm = await readBoundedBytes(response, PROVIDER_RESPONSE_LIMIT_BYTES.audio, "Soniox audio response");
    options?.signal?.throwIfAborted();
    if (pcm.byteLength === 0) throw new Error("Soniox returned empty audio");
    // An odd trailing byte would misalign every later sample; drop it.
    const aligned = pcm.byteLength % 2 ? pcm.subarray(0, pcm.byteLength - 1) : pcm;
    return wavFromPcm(aligned, { rate: SAMPLE_RATE, width: 2, channels: 1 });
  }

  /**
   * Swap readiness: Soniox's model list covers recognition models only, so a
   * one-word synthesis is the check that the TTS model, voice and language are
   * accepted (an unknown model is an HTTP 400). Runs only on swap-in.
   */
  async warmup(): Promise<void> {
    await this.generateAudio("Hi.");
  }

  async health(): Promise<boolean> {
    const result = await checkCloudSpeechKey(this.entry, this.apiKey, { fetcher: this.fetcher });
    if (!result.ok) log("info", `Soniox TTS health: ${result.reason}`);
    return result.ok;
  }
}
