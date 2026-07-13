// Short spoken "fillers" that cover an agent's thinking latency — the voice
// equivalent of Claude Code's working verbs. A brain/agent turn can take a few
// seconds (model reasoning + tool calls + network for a remote agent like
// Hermes); speaking one of these immediately keeps the conversation feeling
// alive instead of dropping into dead air.
//
// Fillers are CONTEXTUAL: a command gets "On it.", a status request gets
// "Let me check.", a question gets "Hmm, good question." — matched against
// the user's transcript so the acknowledgment sounds like a human who heard
// you, not a canned loop. Lines are varied and never repeat back-to-back.

export type FillerBucket = "connect" | "task" | "lookup" | "question" | "default";

export const FILLER_LINES: Record<FillerBucket, readonly string[]> = {
  // The user asked to be put through to someone.
  connect: ["One moment.", "Connecting you now.", "Patching you through.", "One second."],
  // The user told us to DO something.
  task: ["On it.", "Working on it.", "Right away.", "Getting that going."],
  // The user asked us to look something up / report state.
  lookup: ["Let me check.", "Checking now.", "One sec — pulling that up.", "Let me have a look."],
  // The user asked a thinking question.
  question: ["Hmm, good question.", "Let me think about that.", "Let me see.", "Hmm, thinking."],
  // Anything else.
  default: ["One moment.", "One sec.", "Hold on.", "Give me a second."],
};

const TASK_RE = /^(?:please\s+|hey\s+|ok(?:ay)?\s+|go\s+)*(?:fix|build|write|create|make|run|deploy|add|update|refactor|implement|generate|install|remove|delete|move|rename|push|commit|merge|revert|set\s?up|start|stop|restart|kill|open|close|change|clean|test|ship)\b/i;
const LOOKUP_RE = /\b(?:status|check|look\s?(?:up|at|into)|find|search|any\s+news|latest|progress|did\s+(?:\w+\s+){1,3}(?:finish|pass|fail|land)|how(?:'s| is)\s+(?:the|that|it))\b/i;
const QUESTION_RE = /^(?:what|why|how|who|where|when|which|is|are|was|were|does|do|did|can|could|should|would|will|am)\b|\?\s*$/i;

const CONNECT_RE = /\b(?:patch(?:ing)?\s+me|put\s+me\s+through|connect\s+me|transfer(?:\s+me)?|switch(?:\s+me)?(?:\s+over)?\s+to|(?:talk|speak)\s+(?:to|with)|get\s+me\s+the|bring\s+(?:in|me)|on\s+the\s+line)\b/i;

// A bare acknowledgment ("sounds good", "okay cool", "yeah thanks") warrants
// NO filler at all — "One moment." in reply to "sounds good" reads as a
// non-sequitur, and the lane's real reply follows soon anyway. Whole-utterance
// match, up to a few stacked ack words with punctuation between.
const ACK_RE = /^(?:(?:ok(?:ay)?|k|yeah|yep|yes|nah|no|cool|nice|great|perfect|awesome|sweet|sounds (?:good|great|right)|got it|understood|thanks(?: a lot)?|thank you|cheers|alright|all right|sure|fine|good|love it|good job|well done|makes sense|fair enough|noted|roger|copy that|right|exactly|agreed|works for me)[,.!\s]*){1,4}$/i;

/** Which kind of acknowledgment fits this utterance — "none" = stay silent. */
export function classifyFillerBucket(transcript?: string): FillerBucket | "none" {
  const t = transcript?.trim() ?? "";
  if (!t) return "default";
  if (ACK_RE.test(t)) return "none";
  if (CONNECT_RE.test(t)) return "connect";
  if (TASK_RE.test(t)) return "task";
  if (LOOKUP_RE.test(t)) return "lookup";
  if (QUESTION_RE.test(t)) return "question";
  return "default";
}

/** Flat list of every default line (the bank primes all of them). */
export const THINKING_FILLERS: readonly string[] = Object.values(FILLER_LINES).flat();

/**
 * Pick a filler for an utterance, never returning `last` so the same line
 * can't play twice in a row. Pass the previously-spoken filler to keep it varied.
 */
export function pickThinkingFiller(last?: string, transcript?: string): string {
  const bucket = classifyFillerBucket(transcript);
  // The host path calls this without a transcript and always speaks SOMETHING;
  // "none" only means silence where the caller can stay silent (FillerBank).
  const lines = FILLER_LINES[bucket === "none" ? "default" : bucket];
  const pool = last ? lines.filter((f) => f !== last) : [...lines];
  const choices = pool.length > 0 ? pool : lines;
  return choices[Math.floor(Math.random() * choices.length)] ?? lines[0]!;
}
