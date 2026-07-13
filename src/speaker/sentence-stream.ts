/**
 * Consume a stream of text tokens and yield complete sentences as soon as a
 * boundary appears, flushing any trailing partial sentence when the stream ends.
 *
 * Boundary: `.`, `!`, or `?` followed by whitespace — unless the text before the
 * period ends in a known abbreviation ("Dr.", "e.g.", "a.m."), which would
 * otherwise split mid-phrase and produce a jarring TTS pause. This mirrors the
 * splitter inlined in
 * ActionExecutor.executeLocalLLMStreaming so the local-llm path and the brain
 * path can converge on one implementation.
 *
 * Input tokens must already be free of provider control markup (e.g. <think>
 * blocks) — stripping that is the producer's responsibility.
 */

// Common abbreviations that end in a period but don't end a sentence.
// Single-letter initials ("J. Smith") are deliberately NOT guarded: the guard
// would also buffer legitimate one-letter sentences ("A.") indefinitely, and a
// mis-split initial costs one ~40ms TTS blip while a held sentence costs
// streaming latency.
const ABBREV =
  /(?:\b(?:mr|mrs|ms|dr|prof|st|vs|etc|jr|sr|inc|ltd|co|no|fig|dept|est|approx)|\be\.g|\bi\.e|\ba\.m|\bp\.m)\.$/i;

/** Index just past the next real sentence boundary at/after `from`, or -1. */
function findBoundary(buffer: string, from: number): number {
  const re = /[.!?](?=\s)/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer))) {
    const end = m.index + 1;
    if (!ABBREV.test(buffer.slice(0, end))) return end;
  }
  return -1;
}

export async function* segmentSentences(
  tokens: AsyncIterable<string>,
): AsyncGenerator<string> {
  let buffer = "";
  for await (const token of tokens) {
    buffer += token;
    let end = findBoundary(buffer, 0);
    while (end !== -1) {
      const sentence = buffer.slice(0, end).trim();
      buffer = buffer.slice(end).replace(/^\s+/, "");
      if (sentence) yield sentence;
      end = findBoundary(buffer, 0);
    }
  }
  const remaining = buffer.trim();
  if (remaining) yield remaining;
}
