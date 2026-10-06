/**
 * Backchannels: the short "I'm following, keep going" noises a listener makes
 * while someone else talks — "mm-hmm", "yeah", "right", "uh-huh". Heard over
 * Cicero's own reply they are not an interruption, so barge-in paths that
 * already have a transcript ignore them and let the reply keep playing.
 *
 * Deliberately excluded: "yes"/"no" (direct answers), "uh"/"um" (a hesitation
 * usually means the speaker is taking the floor), "huh?" (confusion), and every
 * bare stop-class word ("wait", "hold on"), which must always interrupt.
 */

/** Longer captures are real speech, never a backchannel; also bounds the work on untrusted text. */
const MAX_BACKCHANNEL_CHARS = 48;
const MAX_BACKCHANNEL_TOKENS = 4;

const BACKCHANNEL_WORDS: ReadonlySet<string> = new Set([
  "yeah", "yep", "yup", "ya", "yea",
  "right", "ok", "okay", "sure", "true",
  "cool", "nice", "great", "wow", "oh", "ah", "aha", "ahh", "ooh",
  "mhm", "hm", "hmm", "mm",
  "exactly", "totally", "indeed", "gotcha", "interesting",
]);

/** Multi-word backchannels, matched as whole token runs. */
const BACKCHANNEL_PHRASES: readonly (readonly string[])[] = [
  ["i", "see"],
  ["got", "it"],
  ["makes", "sense"],
  ["go", "on"],
  ["uh", "huh"],
  ["oh", "really"],
  ["for", "sure"],
  ["of", "course"],
];

/** STT spellings of the nasal hums: "mmm", "mmhmm", "mhmm", "mmhm", "hmmm". */
const HUM = /^(?:m+h*m+|m+h+m+|h+m+|m+)$/;

function isBackchannelWord(token: string): boolean {
  return BACKCHANNEL_WORDS.has(token) || HUM.test(token);
}

/** Lowercase, drop punctuation, split "mm-hmm" / "uh-huh" into tokens. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‐-―-]/g, " ")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/'/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * True when a transcript is only backchannel tokens ("Mm-hmm.", "Yeah, yeah.",
 * "Oh, I see.", "Right."). Anything with real content — "yeah but use the
 * other one" — is speech and returns false.
 */
export function isBackchannel(text: string | null | undefined): boolean {
  const raw = (text ?? "").trim();
  if (!raw || raw.length > MAX_BACKCHANNEL_CHARS) return false;
  const tokens = tokenize(raw);
  if (tokens.length === 0 || tokens.length > MAX_BACKCHANNEL_TOKENS) return false;
  let i = 0;
  while (i < tokens.length) {
    const phrase = BACKCHANNEL_PHRASES.find((p) => p.every((word, k) => tokens[i + k] === word));
    if (phrase) { i += phrase.length; continue; }
    if (!isBackchannelWord(tokens[i]!)) return false;
    i += 1;
  }
  return true;
}
