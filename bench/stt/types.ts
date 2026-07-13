/** A thing the bench can compare: anything that turns a WAV into text. */
export type Candidate = ProviderCandidate | CommandCandidate;

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

/** One clip to transcribe, paired with its ground-truth transcript. */
export interface Clip {
  name: string;
  path: string;
  reference: string;
  durationSec: number;
}
