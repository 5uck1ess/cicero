import { SUPPORTED_VOICE_PROVIDERS } from "../voice/provider-contract";
import { OPENAI_COMPATIBLE_BACKENDS } from "./llm/openai";

/** Backends the built-in registry can construct today. */
export const SUPPORTED_STT_BACKENDS = [
  "mlx-whisper",
  "faster-whisper",
  "audiocpp",
  "wyoming",
] as const;

/** Backends the built-in registry can construct today. */
export const SUPPORTED_TTS_BACKENDS = [
  "mlx-audio",
  "kokoro",
  "wyoming",
  ...SUPPORTED_VOICE_PROVIDERS,
] as const;

/** Backends the built-in LLM registry can construct today. */
export const SUPPORTED_LLM_BACKENDS = [
  "mlx-lm",
  "ollama",
  "llama-cpp",
  ...OPENAI_COMPATIBLE_BACKENDS,
] as const;

export function supportedBackendsForRole(
  role: string,
): readonly string[] | undefined {
  if (role === "stt" || role === "stt_fallback") return SUPPORTED_STT_BACKENDS;
  if (role === "tts" || role === "tts_fallback") return SUPPORTED_TTS_BACKENDS;
  if (role === "llm") return SUPPORTED_LLM_BACKENDS;
  return undefined;
}

export function backendConfigKey(role: string): string | undefined {
  if (role === "stt" || role === "stt_fallback" || role === "tts" || role === "tts_fallback" || role === "llm") {
    return `${role}.backend`;
  }
  return undefined;
}

export function supportedBackendHint(configKey: string, values: readonly string[]): string {
  return `valid values for ${configKey}: ${values.join(", ")}`;
}
