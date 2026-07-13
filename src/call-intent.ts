/**
 * "call me" — the dial-back intent, shared by every text/voice surface.
 *
 * Optionally names who picks up: "have ada call me", "ask quinn to call me",
 * "nova, ring me". The name is one or two plain words so ordinary sentences
 * ("call me when it's done") still fall through to a normal chat turn.
 *
 * Questions are never commands: aux/wh words and pronouns are excluded from
 * the name position, so "did you call me?" (STT drops the "?") is answered,
 * not dialed. That also rejects modal requests ("would you call me") —
 * deliberately conservative; the canonical "call me" always works.
 */
const NOT_A_NAME =
  "to|did|do|does|am|is|are|was|were|have|has|had|why|when|who|whom|whose|what|where|which|how|i|it|he|she|we|they|that|this";
export const CALL_ME_RE = new RegExp(
  "^(?:(?:hey|ok(?:ay)?|please|cicero|jarvis)[,\\s]+){0,2}" +
    "(?:(?:have|get|tell|ask)\\s+)?(?:the\\s+)?" +
    `(?:((?!(?:${NOT_A_NAME})\\b)[a-z][a-z0-9_-]{1,23}` +
    "(?:\\s+(?!to\\b|call\\b|ring\\b|you\\b|me\\b)[a-z][a-z0-9_-]{1,23})?)[,\\s]+)?" +
    "(?:to\\s+)?(?:call me(?: back)?|ring me)\\s*(?:please\\s*)?[.!]*$",
  "i",
);

/** Captured "names" that mean nobody in particular — ring as usual. */
export const CALL_ANYONE = new Set(["someone", "somebody", "anyone", "anybody", "you", "cicero", "jarvis"]);

/**
 * Match a dial-back request. Returns `{}` for "call me", `{who}` when a
 * specific employee should pick up, and null when the text is not a
 * dial-back request at all.
 */
export function matchCallMe(text: string): { who?: string } | null {
  const m = CALL_ME_RE.exec(text);
  if (!m) return null;
  const rawWho = m[1]?.trim().toLowerCase();
  return rawWho && !CALL_ANYONE.has(rawWho) ? { who: rawWho } : {};
}

export type CallIntentClassifier = (prompt: string, signal?: AbortSignal) => Promise<string>;

// Only call-ish utterances are worth a classifier round trip. Telephony verbs
// plus the common idioms keep unrelated chat on the normal zero-latency path.
const CALLISH_RE = /\b(?:call|ring|phone|dial|horn|buzz)\b|\bon the line\b/i;

/**
 * Semantic fallback for dial-back phrasings the lexical pattern misses.
 * Returns a strict intent value; a failed, slow, or ambiguous classifier leaves
 * the utterance as an ordinary brain turn. Caller cancellation is never
 * downgraded to a classifier miss.
 */
export async function classifyCallIntent(
  text: string,
  classify: CallIntentClassifier,
  roster: readonly string[],
  signal?: AbortSignal,
): Promise<{ who?: string } | null> {
  if (!CALLISH_RE.test(text)) return null;
  signal?.throwIfAborted();
  const prompt =
    `You route utterances for a voice assistant that can phone the user. Employees: ${roster.join(", ") || "(none)"}.\n` +
    "Reply with EXACTLY one label and nothing else:\n" +
    "call = the user asks to be phoned right now\n" +
    "call:<employee> = the user asks that ONE employee phone them right now\n" +
    "none = anything else: questions, chat, instructions, mentions of past calls, or a call at a future time ('call me tomorrow', 'call me when it\'s done')\n" +
    "When in doubt, reply none.\n" +
    `Utterance: "${text}"`;
  try {
    const label = (await classify(prompt, signal)).trim().toLowerCase().split(/\s/)[0] ?? "";
    signal?.throwIfAborted();
    if (label === "call") return {};
    const match = /^call:([a-z0-9_-]{1,24})$/.exec(label);
    if (match) return { who: match[1] };
  } catch {
    signal?.throwIfAborted();
  }
  return null;
}

/**
 * One-shot context for the brain after the control plane rang the user's
 * phone outside its view. Recipient-neutral facts only: the memo rides a
 * "whoever answers the next turn" channel, so it must stay true no matter
 * which persona reads it (live incident 2026-07-13: the persona denied a
 * call the user had just watched happen).
 */
export function dialBackMemo(who?: string): string {
  return `System note: the user asked for a phone call${who ? ` from ${who}` : ""} and their phone was rung moments ago. If they ask whether anyone called them: yes, just now.`;
}
