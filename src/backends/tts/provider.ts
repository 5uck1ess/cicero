export interface TTSProviderConfig {
  backend?: string;
  host?: string; // for network backends (e.g. wyoming)
  port?: number;
  model?: string;
  voice?: string;
  device?: string; // cuda | cpu | mps | auto — backends that spawn a local server pass it through
  refAudio?: string;
  refText?: string;
  apiKey?: string;
  /** Alternate voice-library root for embedded runtimes and contract tests. */
  voiceLibraryRoot?: string;
  /** Alternate private audio.cpp reference cache for embedded runtimes/tests. */
  referenceCacheRoot?: string;
  /** Absolute per-synthesis deadline in milliseconds (default 60 seconds). */
  timeout_ms?: number;
  /** Wyoming: absolute synthesis response deadline. Defaults to 60 seconds. */
  responseTimeoutMs?: number;
  /** Wyoming: maximum accumulated PCM response. Defaults to 64 MiB. */
  maxAudioBytes?: number;
}

export interface TTSOptions {
  /** Speech speed/rate multiplier when the backend supports OpenAI-compatible speed. */
  speed?: number;
}

export interface TTSProvider {
  readonly name: string;
  /**
   * Render text to WAV. `voice` optionally overrides the configured voice for
   * this one call (lane switchboard: employees sound different). Providers
   * interpret it their own way — kokoro as a preset name, audio.cpp as a
   * provisioned clone from the voice library — and throw on voices they don't
   * know, so a fallback chain can try the next engine.
   */
  generateAudio(text: string, voice?: string, options?: TTSOptions): Promise<ArrayBuffer>;
  health(): Promise<boolean>;
  /**
   * Health of the configured primary when this provider composes fallbacks.
   * Startup policy uses this instead of aggregate health so a live fallback
   * cannot hide an explicitly configured primary that never came online.
   */
  requiredHealth?(): Promise<boolean>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  /**
   * Optional: perform a throwaway generation so the model is resident before
   * the first real utterance. Best-effort — callers ignore failures.
   */
  warmup?(): Promise<void>;
}

export const TTS_DEFAULT_PORTS: Readonly<Record<string, number>> = Object.freeze({
  "mlx-audio": 8082,
  kokoro: 8082,
  wyoming: 10200,
  audiocpp: 8092,
  "pocket-tts": 8082,
  vibevoice: 8082,
});

export function ttsDefaultPort(backend: string | undefined): number | undefined {
  return backend ? TTS_DEFAULT_PORTS[backend] : undefined;
}
