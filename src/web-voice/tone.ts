import type { ToneResult } from "../backends/ser/provider";
import { log } from "../logger";

/**
 * Input-side tone: turn an SER verdict into the parenthetical tag that rides
 * along with the transcript into the brain — or into nothing at all. The tag
 * only exists when it's INFORMATIVE: a confident, non-neutral emotion. Most
 * turns are neutral, and a brain told "the user sounds neutral" forty times a
 * day starts commenting on it; silence is the right default.
 *
 * The phrasing is self-explanatory on purpose, so lane personas need no
 * prompt changes to make sense of it.
 */

/** Catch-all labels that tell the brain nothing worth reading. */
const UNINFORMATIVE = new Set(["neutral", "other", "unknown", "unk", "<unk>"]);

/**
 * Utterance length from the WAV header (byte rate at offset 28). SER is
 * confidently WRONG on short clips — the same neutral speech scores
 * "angry 1.000" at 0.6s and only settles to neutral by ~4s — so callers gate
 * on duration BEFORE classifying. Returns 0 for anything that isn't a
 * parseable WAV (the gate then skips it, which is the safe direction).
 */
export function wavDurationMs(wav: ArrayBuffer | Uint8Array): number {
  const bytes = wav instanceof Uint8Array ? wav : new Uint8Array(wav);
  if (bytes.length < 44) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x52494646) return 0; // "RIFF"
  const byteRate = view.getUint32(28, true);
  if (!byteRate) return 0;
  return ((bytes.length - 44) / byteRate) * 1000;
}

export const TONE_MIN_MS = 1500;

export function toneTag(result: ToneResult | null, minScore = 0.5): string | null {
  if (!result) return null;
  // FunASR labels arrive bilingual ("中立/neutral") — keep the English half.
  const label = (result.label.split("/").pop() ?? "").trim().toLowerCase();
  if (!label || UNINFORMATIVE.has(label)) return null;
  if (result.score < minScore) return null;
  return `(Voice analysis: the user's tone of voice sounds ${label}.)`;
}

/**
 * How a turn pipeline consumes tone: `tag` is kicked off on the utterance WAV
 * in parallel with STT, and the brain input waits for it at most `graceMs`
 * past the transcript — SER on CPU is normally faster than the STT pass, so
 * the wait is almost always zero, and a slow verdict is simply dropped.
 */
export interface ToneOptions {
  /** Brain-ready tone tag for this utterance WAV, or null. Must never reject. */
  tag: (wav: ArrayBuffer | Uint8Array) => Promise<string | null>;
  /** Max wait for the tag once the transcript is ready (default 150ms). */
  graceMs?: number;
}

export const TONE_GRACE_MS = 150;

/** A classifier promise with an always-observed, drainable lifetime. */
export interface OwnedTone {
  result: Promise<string | null>;
  drain: Promise<void>;
  settled: () => boolean;
}

/**
 * Start tone work without allowing a rejecting embedder or a grace-window loss
 * to become an unhandled continuation. Transport callers retain `drain` until
 * the classifier has actually returned.
 */
export function beginOwnedTone(
  tone: ToneOptions | undefined,
  wav: ArrayBuffer | Uint8Array,
  label = "tone classification",
): OwnedTone | null {
  if (!tone) return null;
  let done = false;
  const result = Promise.resolve()
    .then(() => tone.tag(wav))
    .catch((error: unknown) => {
      log("warn", `${label} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    })
    .finally(() => { done = true; });
  return {
    result,
    drain: result.then(() => undefined),
    settled: () => done,
  };
}

/** Resolve a pending tone tag, giving up after the grace window. */
export async function settleTone(pending: Promise<string | null> | null, graceMs = TONE_GRACE_MS): Promise<string | null> {
  if (!pending) return null;
  return Promise.race([pending, Bun.sleep(graceMs).then(() => null)]);
}
