import type { TTSOptions, TTSProvider, TTSProviderConfig } from "./provider";
import { wavFromPcm } from "../wyoming/audio";
import { resolveLibraryVoice } from "../../voice/library-resolve";
import {
  PROVIDER_TIMEOUT_MS,
  PROVIDER_RESPONSE_LIMIT_BYTES,
  providerSignal,
  readBoundedBytes,
  readBoundedJson,
  readErrorDetail,
  requestTimeout,
  responseIsOk,
} from "../http-transfer";

export const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
const OUTPUT_FORMAT = "pcm_24000";
/** How many offered models a rejection names, and how much of each it quotes. */
const MAX_QUOTED_MODEL_IDS = 12;
const MAX_MODEL_ID_CHARS = 64;

/**
 * Round 11 (Codex): a model_id is remote input, and quoting it raw put ESC and
 * BEL bytes into the terminal log and dashboard history — where an OSC sequence
 * executes as a terminal command rather than printing. Strip C0/C1 and bound
 * each id (and the count) before any of it is echoed. Matching still compares
 * the RAW value: this bounds what is DISPLAYED, never what is checked.
 */
/**
 * Round 12 (Codex): the same body is REFLECTIVE. This provider sends its key in
 * `xi-api-key`, and a remote (or spoofed) endpoint answering with that key as a
 * `model_id` had it quoted back verbatim into the rejection — which travels out
 * through the swap path to the operator's terminal and dashboard history.
 * Shape rules cannot help here; a key is whatever the operator configured. The
 * provider knows its own credential, so it removes that value by literal match.
 * `secret` is passed separately rather than read from a field so this stays a
 * pure function, and a blank key disables the check instead of matching "".
 */
function safeModelId(value: string, secret?: string): string {
  const withoutSecret = secret && secret.length > 0 && value.includes(secret)
    ? value.split(secret).join("<redacted>")
    : value;
  const stripped = withoutSecret.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").trim();
  return stripped.length > MAX_MODEL_ID_CHARS
    ? `${stripped.slice(0, MAX_MODEL_ID_CHARS)}…`
    : stripped;
}

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

  /**
   * Round 10 (Codex): verify the configured model, which health() structurally
   * cannot — `/voices/{id}` validates the VOICE, and `model_id` is first sent on
   * synthesis. So a swap to an invalid model passed the readiness gate, was
   * persisted, and left the newly active provider unusable on its first real
   * request. This is a list lookup, not a synthesis: checking a name spends no
   * synthesis credits.
   */
  async warmup(): Promise<void> {
    this.requireReady(this.voiceId ?? "");
    const response = await fetch(`${ELEVENLABS_API_BASE}/models`, {
      headers: { "xi-api-key": this.apiKey },
      signal: providerSignal(this.timeoutMs),
    });
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`ElevenLabs model lookup returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const models = await readBoundedJson<unknown>(response, PROVIDER_RESPONSE_LIMIT_BYTES.json, "ElevenLabs model list");
    if (!Array.isArray(models)) throw new Error("ElevenLabs model list was not a list");
    // Untrusted body: read only the one field, and never echo the rest.
    const known = models.flatMap((entry) =>
      typeof entry === "object" && entry !== null && typeof (entry as { model_id?: unknown }).model_id === "string"
        ? [(entry as { model_id: string }).model_id]
        : []);
    if (!known.includes(this.model)) {
      const quoted = known.slice(0, MAX_QUOTED_MODEL_IDS)
        .map((id) => safeModelId(id, this.apiKey))
        .filter((id) => id.length > 0);
      throw new Error(
        `ElevenLabs does not offer model '${safeModelId(this.model, this.apiKey)}'`
        + (quoted.length > 0 ? ` — available: ${quoted.join(", ")}` : "")
        + (known.length > quoted.length ? ` (+${known.length - quoted.length} more)` : ""),
      );
    }
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
