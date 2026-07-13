export interface TurnPrediction {
  /** True when the model judges the buffered speech a complete turn. */
  complete: boolean;
  /** Model confidence in [0,1] that the turn is complete. */
  probability: number;
}

export interface TurnDetectorConfig {
  backend?: "smart-turn";
  host?: string; // remote model server (defaults to localhost)
  port?: number;
  model?: string;
  /** Probability at/above which a `complete` prediction ends the turn. */
  threshold?: number;
  /** Absolute per-prediction deadline in milliseconds (default 10 seconds). */
  timeout_ms?: number;
}

export interface TurnDetector {
  readonly name: string;
  /**
   * Predict whether a buffered speech segment is a complete turn.
   * `samples` is mono PCM in [-1, 1] at `sampleRate`; the model resamples as needed.
   */
  predict(samples: Float32Array, sampleRate: number): Promise<TurnPrediction>;
  health(): Promise<boolean>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
