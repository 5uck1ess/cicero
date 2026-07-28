/** A thing the bench can compare: anything that turns a WAV into text. */
export type Candidate = ProviderCandidate | CommandCandidate | StreamCandidate;

/** An integrated Cicero STT backend, exercised through its real provider. */
export interface ProviderCandidate {
  name: string; // display label
  kind: "provider";
  backend: "mlx-whisper" | "faster-whisper";
  host?: string;
  port?: number;
  model?: string;
}

/**
 * Any external CLI model not yet wired into Cicero (Kyutai, parakeet-mlx,
 * Moonshine, …). The command must print ONLY the transcript to stdout. `{audio}`
 * is replaced with the absolute path to the WAV under test.
 */
export interface CommandCandidate {
  name: string;
  kind: "command";
  command: string; // e.g. "parakeet-mlx transcribe {audio}"
}

/**
 * An audio.cpp model driven over `POST /v1/audio/transcriptions/live` — PCM fed
 * at real-time pace up a chunked request body, SSE deltas timed as they come
 * back. This is the only candidate kind that measures streaming time-to-final;
 * the other two are whole-clip transcribes. The model must be `mode: "streaming"`
 * server-side, and each run costs at least the clip's own duration in wall-clock.
 */
export interface StreamCandidate {
  name: string;
  kind: "stream";
  model: string; // audio.cpp model id, e.g. "voxtral-realtime"
  port: number;
  host?: string; // default 127.0.0.1
  path?: string; // default /v1/audio/transcriptions/live
  language?: string;
  chunkMs?: number; // PCM sent per write; default 100
  /** "fast" uploads as quickly as the socket takes it — useful to check a model
   *  responds at all, but the resulting timings are NOT streaming latencies. */
  pace?: "realtime" | "fast";
}

/** One clip to transcribe, paired with its ground-truth transcript. */
export interface Clip {
  name: string;
  path: string;
  reference: string;
  durationSec: number;
}
