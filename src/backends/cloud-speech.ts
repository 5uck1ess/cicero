import { redactSecrets } from "../redact";
import { PROVIDER_TIMEOUT_MS, discardResponseBody, providerSignal } from "./http-transfer";

/**
 * The one table of paid/cloud speech backends. Every surface that has to know
 * "this backend sends audio or text off the machine and needs a key" — config
 * validation, the secret inventory, doctor, status, the privacy checks, the
 * setup page, and the docs — reads it from here, so a new provider is one row
 * plus a provider class instead of a hunt through a dozen hardcoded names.
 *
 * None of these backends own a local port: they must stay out of
 * STT_DEFAULT_PORTS / TTS_DEFAULT_PORTS and the managed-server lists, which is
 * what keeps the fallback endpoint-collision check from treating two cloud
 * services as one seat.
 */
export type CloudSpeechRole = "stt" | "tts";

export interface CloudSpeechBackend {
  /** Config value for `stt.backend` / `tts.backend`. */
  id: string;
  role: CloudSpeechRole;
  label: string;
  /** One line for the setup page and docs. */
  note: string;
  /** Environment variable read when the config block has no `apiKey`. */
  apiKeyEnv: string;
  /** Host the audio or text is sent to, for the privacy and data-flow surfaces. */
  egressHost: string;
  /** Where an operator creates or checks a key; named in key failures. */
  consoleUrl: string;
  defaultModel: string;
  /** Suggested models for the setup page; any string the provider accepts still works. */
  models: readonly string[];
  /** TTS only: the voice used when the config names none. */
  defaultVoice?: string;
  /** True when the backend can transcribe live microphone PCM during speech. */
  liveStream?: boolean;
  /** A read-only request that proves a key without spending credits. */
  keyProbe: { url: string; headers: (key: string) => Record<string, string> };
}

const bearer = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}` });

export const CLOUD_SPEECH_BACKENDS: readonly CloudSpeechBackend[] = Object.freeze([
  {
    id: "soniox",
    role: "stt",
    label: "Soniox",
    note: "Cloud speech recognition that transcribes while you talk. Needs an API key.",
    apiKeyEnv: "SONIOX_API_KEY",
    egressHost: "stt-rt.soniox.com",
    consoleUrl: "https://console.soniox.com",
    defaultModel: "stt-rt-v5",
    models: ["stt-rt-v5"],
    liveStream: true,
    keyProbe: { url: "https://api.soniox.com/v1/models", headers: bearer },
  },
  {
    id: "deepgram",
    role: "stt",
    label: "Deepgram",
    note: "Cloud speech recognition (Nova-3), sent after each utterance. Needs an API key.",
    apiKeyEnv: "DEEPGRAM_API_KEY",
    egressHost: "api.deepgram.com",
    consoleUrl: "https://console.deepgram.com",
    defaultModel: "nova-3",
    models: ["nova-3", "nova-3-medical", "nova-2"],
    keyProbe: { url: "https://api.deepgram.com/v1/projects", headers: (key) => ({ Authorization: `Token ${key}` }) },
  },
  {
    id: "openai",
    role: "stt",
    label: "OpenAI",
    note: "OpenAI transcription, sent after each utterance. Needs an API key.",
    apiKeyEnv: "OPENAI_API_KEY",
    egressHost: "api.openai.com",
    consoleUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-4o-mini-transcribe",
    models: ["gpt-4o-mini-transcribe", "gpt-transcribe", "gpt-4o-transcribe", "whisper-1"],
    keyProbe: { url: "https://api.openai.com/v1/models", headers: bearer },
  },
  {
    id: "groq",
    role: "stt",
    label: "Groq",
    note: "Whisper on Groq, sent after each utterance. Needs an API key.",
    apiKeyEnv: "GROQ_API_KEY",
    egressHost: "api.groq.com",
    consoleUrl: "https://console.groq.com/keys",
    defaultModel: "whisper-large-v3-turbo",
    models: ["whisper-large-v3-turbo", "whisper-large-v3"],
    keyProbe: { url: "https://api.groq.com/openai/v1/models", headers: bearer },
  },
  {
    id: "mistral",
    role: "stt",
    label: "Mistral Voxtral",
    note: "Voxtral transcription on Mistral, sent after each utterance. Needs an API key.",
    apiKeyEnv: "MISTRAL_API_KEY",
    egressHost: "api.mistral.ai",
    consoleUrl: "https://console.mistral.ai/api-keys",
    defaultModel: "voxtral-mini-latest",
    models: ["voxtral-mini-latest"],
    keyProbe: { url: "https://api.mistral.ai/v1/models", headers: bearer },
  },
  {
    id: "elevenlabs",
    role: "tts",
    label: "ElevenLabs",
    note: "Cloud voices, including your own cloned voice. Needs an API key.",
    apiKeyEnv: "ELEVENLABS_API_KEY",
    egressHost: "api.elevenlabs.io",
    consoleUrl: "https://elevenlabs.io/app/settings/api-keys",
    defaultModel: "eleven_multilingual_v2",
    models: ["eleven_flash_v2_5", "eleven_v4_turbo", "eleven_multilingual_v2", "eleven_v4"],
    keyProbe: { url: "https://api.elevenlabs.io/v1/models", headers: (key) => ({ "xi-api-key": key }) },
  },
  {
    id: "soniox",
    role: "tts",
    label: "Soniox",
    note: "Fast, inexpensive cloud voices (preset per language). Needs an API key.",
    apiKeyEnv: "SONIOX_API_KEY",
    egressHost: "tts-rt.soniox.com",
    consoleUrl: "https://console.soniox.com",
    defaultModel: "tts-rt-v2",
    models: ["tts-rt-v2"],
    defaultVoice: "Iris",
    keyProbe: { url: "https://api.soniox.com/v1/models", headers: bearer },
  },
] satisfies CloudSpeechBackend[]);

/** Backend ids of one role, in table order. */
export function cloudSpeechIds(role: CloudSpeechRole): string[] {
  return CLOUD_SPEECH_BACKENDS.filter((entry) => entry.role === role).map((entry) => entry.id);
}

export const CLOUD_STT_BACKENDS: readonly string[] = Object.freeze(cloudSpeechIds("stt"));
export const CLOUD_TTS_BACKENDS: readonly string[] = Object.freeze(cloudSpeechIds("tts"));

/** Accepts `stt_fallback` / `tts_fallback` as their base role. */
function baseRole(role: string): CloudSpeechRole | null {
  if (role === "stt" || role === "stt_fallback") return "stt";
  if (role === "tts" || role === "tts_fallback") return "tts";
  return null;
}

export function cloudSpeechBackend(role: string, backend: string | undefined): CloudSpeechBackend | null {
  const kind = baseRole(role);
  if (!kind || !backend) return null;
  return CLOUD_SPEECH_BACKENDS.find((entry) => entry.role === kind && entry.id === backend) ?? null;
}

/** Every key variable a cloud speech backend may read, deduplicated. */
export const CLOUD_SPEECH_KEY_VARIABLES: readonly string[] = Object.freeze(
  [...new Set(CLOUD_SPEECH_BACKENDS.map((entry) => entry.apiKeyEnv))],
);

/** The configured key, else the backend's environment variable; "" when neither is set. */
export function cloudSpeechApiKey(
  entry: Pick<CloudSpeechBackend, "apiKeyEnv">,
  configured: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  if (typeof configured === "string" && configured.length > 0) return configured;
  const fromEnv = env[entry.apiKeyEnv];
  return typeof fromEnv === "string" ? fromEnv : "";
}

const MAX_PROVIDER_TEXT = 200;

/**
 * Bound and sanitize provider-supplied text (an error_message, err_msg, …)
 * before it reaches a thrown error. The body is untrusted and can be
 * reflective, so the provider's own key is removed by literal value on top of
 * the shape rules, and control bytes are stripped so a terminal escape cannot
 * ride along into logs or the dashboard.
 */
export function scrubProviderText(text: unknown, key?: string): string {
  if (typeof text !== "string") return "";
  const withoutKey = key && key.length > 0 ? text.split(key).join("<redacted>") : text;
  const clean = redactSecrets(withoutKey).replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").trim();
  return clean.length > MAX_PROVIDER_TEXT ? `${clean.slice(0, MAX_PROVIDER_TEXT)}…` : clean;
}

export type CloudKeyCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Prove a key with the backend's free, read-only probe. Only the status code is
 * read — the body is discarded unseen — so nothing the provider says can echo
 * the key back. Used by `doctor` and the setup page's "Test key" button.
 */
export async function checkCloudSpeechKey(
  entry: CloudSpeechBackend,
  key: string,
  options: { fetcher?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CloudKeyCheck> {
  if (!key) return { ok: false, reason: `No ${entry.label} API key; set ${entry.apiKeyEnv} or enter one` };
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(entry.keyProbe.url, {
      headers: entry.keyProbe.headers(key),
      signal: providerSignal(options.timeoutMs ?? PROVIDER_TIMEOUT_MS.health, options.signal),
    });
  } catch (error: unknown) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, reason: timedOut ? `${entry.label} did not answer in time` : `Could not reach ${entry.egressHost}` };
  }
  await discardResponseBody(response).catch(() => {});
  if (response.ok) return { ok: true };
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: `${entry.label} rejected the key (HTTP ${response.status}); check it at ${entry.consoleUrl}` };
  }
  if (response.status === 402) return { ok: false, reason: `${entry.label} account is out of credit (HTTP 402); see ${entry.consoleUrl}` };
  if (response.status === 429) return { ok: false, reason: `${entry.label} is rate-limiting this key (HTTP 429)` };
  return { ok: false, reason: `${entry.label} key check returned HTTP ${response.status}` };
}
