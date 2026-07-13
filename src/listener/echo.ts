/**
 * Self-echo rejection: through open speakers, the mic can capture Cicero's own
 * TTS and transcribe it as a new command. We discard a transcript that is mostly
 * made of the words just spoken.
 */

export function normalizeForEcho(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// True only when the transcript looks like a near-verbatim echo of what was just
// spoken: at least MIN_ECHO_WORDS distinct words AND a high fraction of them also
// appear in the spoken text. Deliberately conservative — dropping a genuine reply
// is worse than missing an echo, so short conversational replies always pass.
const MIN_ECHO_WORDS = 4;

export function isSelfEcho(transcript: string, spoken: string, threshold = 0.75): boolean {
  const t = normalizeForEcho(transcript);
  const s = normalizeForEcho(spoken);
  if (!t || !s) return false;

  const transcriptWords = [...new Set(t.split(" "))];
  if (transcriptWords.length < MIN_ECHO_WORDS) return false;

  const spokenWords = new Set(s.split(" "));
  const overlap = transcriptWords.filter((w) => spokenWords.has(w)).length / transcriptWords.length;
  return overlap >= threshold;
}
