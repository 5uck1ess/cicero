import type { TTSOptions, TTSProvider, TTSProviderConfig } from "./provider";
import { wavFromPcm } from "../wyoming/audio";
import { resolveLibraryVoice } from "../../voice/library-resolve";
import {
  PROVIDER_TIMEOUT_MS,
  PROVIDER_RESPONSE_LIMIT_BYTES,
  providerSignal,
  readBoundedBytes,
  readErrorDetail,
  requestTimeout,
  responseIsOk,
} from "../http-transfer";

export const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
const OUTPUT_FORMAT = "pcm_24000";

/** ElevenLabs HTTP TTS using raw 24 kHz PCM wrapped into Cicero's WAV contract. */
export class ElevenLabsProvider implements TTSProvider {
  readonly name = "elevenlabs";
  private readonly apiKey: string;
  private readonly voiceId?: string;
  private readonly model: string;
  private readonly voiceLibraryRoot?: string;
  private readonly timeoutMs: number;

  constructor(config: TTSProviderConfig) {
    this.apiKey = config.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "";
    this.voiceId = config.voice;
    this.model = config.model ?? "eleven_multilingual_v2";
    this.voiceLibraryRoot = config.voiceLibraryRoot;
    this.timeoutMs = requestTimeout(config.timeout_ms, PROVIDER_TIMEOUT_MS.tts);
  }

  async generateAudio(text: string, voice?: string, options?: TTSOptions): Promise<ArrayBuffer> {
    const voiceId = this.resolveVoiceId(voice);
    this.requireReady(voiceId);
    const body: Record<string, unknown> = { text, model_id: this.model };
    if (options?.speed !== undefined) body.voice_settings = { speed: options.speed };

    const response = await fetch(
      `${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: providerSignal(this.timeoutMs),
      },
    );
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`ElevenLabs returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    const pcm = await readBoundedBytes(
      response,
      PROVIDER_RESPONSE_LIMIT_BYTES.audio,
      "ElevenLabs audio response",
    );
    if (pcm.byteLength === 0) throw new Error("ElevenLabs returned empty audio");
    return wavFromPcm(pcm, { rate: 24_000, width: 2, channels: 1 });
  }

  async health(timeoutMs: number = PROVIDER_TIMEOUT_MS.health): Promise<boolean> {
    const voiceId = this.voiceId;
    if (!this.apiKey || !voiceId) return false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`ElevenLabs health check timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const probe = (async (): Promise<boolean> => {
        const response = await fetch(`${ELEVENLABS_API_BASE}/voices/${encodeURIComponent(voiceId)}`, {
          headers: { "xi-api-key": this.apiKey },
          signal: providerSignal(timeoutMs, controller.signal),
        });
        return await responseIsOk(response);
      })();
      return await Promise.race([probe, deadline]);
    } catch {
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private resolveVoiceId(voice?: string): string {
    if (!voice || voice === this.voiceId) return this.voiceId ?? "";
    const libraryVoice = resolveLibraryVoice("elevenlabs", voice, this.voiceLibraryRoot);
    // An unknown value may be an opaque provider-native ElevenLabs ID rather
    // than a Cicero library label. Preserve it for server-side validation; the
    // resulting network request and warning are an intentional compatibility
    // tradeoff, not an accidental missing-library fallback.
    return libraryVoice?.voiceId ?? voice;
  }

  private requireReady(voiceId: string): void {
    if (!this.apiKey) {
      throw new Error("ElevenLabs API key not found; set ELEVENLABS_API_KEY");
    }
    if (!voiceId) {
      throw new Error("ElevenLabs provider requires a voice ID; run `cicero voice add ... --provider elevenlabs`");
    }
  }
}
