/** Speech-emotion recognition (SER): the input side of tone. */

export interface ToneResult {
  /** English emotion label, lowercase ("happy", "angry", "neutral", …). */
  label: string;
  /** Softmax confidence in [0, 1]. */
  score: number;
}

/**
 * Classifies an utterance's emotional tone from the raw waveform. Acoustic
 * only — the transcript carries none of this signal, so the provider eats the
 * same WAV the STT pass gets, not its text output.
 */
export interface SerProvider {
  readonly name: string;
  /** Tone of one utterance WAV; null on ANY failure — tone must never block a turn. */
  classify(wav: ArrayBuffer | Uint8Array): Promise<ToneResult | null>;
  health(): Promise<boolean>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface SerProviderConfig {
  host?: string;
  port?: number;
  model?: string;
  /** Absolute per-classification deadline in milliseconds (default 5 seconds). */
  timeout_ms?: number;
}
