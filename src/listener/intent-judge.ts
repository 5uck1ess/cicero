import { log } from "../logger";
import type { ChatMessage, LLMProvider } from "../backends/llm/provider";

/**
 * Deciding whether speech was addressed to Cicero.
 *
 * Once the conversational listener is active, every intelligible non-echo
 * utterance is treated as a command. In a room with other people talking, or
 * with a podcast playing, that is too eager — but requiring the wake word on
 * every single turn is the other extreme.
 *
 * This asks a small model. It is strictly a **veto**: it can decline a turn the
 * listener would otherwise have taken, and it can never cause one to be taken
 * that would not have been. Every failure path therefore ends in "accept",
 * which is exactly today's behavior — the feature can make Cicero deafer, never
 * more indiscriminate.
 */

/** What the judge is shown. All of it is already in the listener's hands. */
export interface IntentJudgeInput {
  /** The utterance being decided. */
  utterance: string;
  /** Earlier utterances, oldest first. Context disambiguates "yeah, do that". */
  recentUtterances: readonly string[];
  /** What Cicero itself recently said, oldest first. */
  recentAssistantSpeech: readonly string[];
  /** Milliseconds since Cicero last finished speaking, or null if it has not. */
  msSinceAssistantSpoke: number | null;
}

export interface IntentVerdict {
  directed: boolean;
  /** 0..1. Below the configured floor the verdict is not acted on. */
  confidence: number;
}

export interface IntentJudgeOptions {
  /**
   * Follow-ups within this long of Cicero speaking skip the judge entirely.
   * A direct reply to Cicero's own question is the case a judge is most likely
   * to get wrong, and it is the case we are most sure about.
   */
  hotWindowMs: number;
  /** Verdicts below this confidence are not acted on; the turn is accepted. */
  minConfidence: number;
  /** How many earlier utterances and assistant lines to show. */
  contextTurns: number;
  /** Absolute deadline for one verdict. */
  timeoutMs: number;
}

export const DEFAULT_INTENT_JUDGE_OPTIONS: IntentJudgeOptions = {
  hotWindowMs: 15_000,
  minConfidence: 0.6,
  contextTurns: 4,
  timeoutMs: 1_500,
};

/** Per-field bounds on what is sent up. Transcripts are untrusted input. */
const MAX_UTTERANCE_CHARS = 500;
const MAX_CONTEXT_LINE_CHARS = 200;
/** Bound on the model's reply before parsing. */
const MAX_VERDICT_CHARS = 2_000;

const VERDICT_SCHEMA = {
  name: "intent_verdict",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["directed", "confidence"],
    properties: {
      directed: { type: "boolean" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
} as const;

function bounded(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max);
}

/**
 * Parse a verdict out of untrusted model output.
 *
 * Returns null for anything not exactly a well-formed verdict — a missing
 * field, a non-boolean, a confidence outside 0..1, prose wrapped around the
 * JSON. The caller treats null as "no opinion", which accepts the turn.
 */
export function parseVerdict(raw: unknown): IntentVerdict | null {
  // A provider returning undefined or an object breaks its TypeScript contract,
  // but a runtime that does so must not throw out of decide() -- that would
  // turn the one guaranteed fail-OPEN path into a dropped utterance.
  if (typeof raw !== "string") return null;
  if (raw.length > MAX_VERDICT_CHARS) return null;
  let parsed: unknown;
  try {
    // A model that answered cleanly gets taken at its word — including when
    // that word is an array or a string, which is a definite non-verdict.
    parsed = JSON.parse(raw.trim());
  } catch {
    // Small models like to wrap JSON in prose or a code fence. Only now is it
    // worth digging an object out of the surrounding text.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const { directed, confidence } = record;
  if (typeof directed !== "boolean") return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  if (confidence < 0 || confidence > 1) return null;
  return { directed, confidence };
}

export function buildJudgePrompt(input: IntentJudgeInput, contextTurns: number): ChatMessage[] {
  // slice(-0) is slice(0) -- the whole array. Zero must mean no context at all,
  // or turning context off would instead send everything retained.
  const take = <T,>(lines: readonly T[]): T[] => (contextTurns <= 0 ? [] : lines.slice(-contextTurns));
  const recent = take(input.recentUtterances).map((line) => bounded(line, MAX_CONTEXT_LINE_CHARS));
  const spoken = take(input.recentAssistantSpeech).map((line) => bounded(line, MAX_CONTEXT_LINE_CHARS));
  const sections = [
    "You decide whether the final utterance was addressed to the voice assistant, or was other people talking, background media, or thinking aloud.",
    "Reply to the assistant, short commands, and follow-ups that continue the assistant's last reply all count as addressed to it. Speech about the assistant in the third person does not.",
  ];
  if (spoken.length > 0) sections.push(`What the assistant recently said:\n${spoken.map((l) => `- ${l}`).join("\n")}`);
  if (recent.length > 0) sections.push(`Earlier speech in the room:\n${recent.map((l) => `- ${l}`).join("\n")}`);
  sections.push(`Utterance to decide:\n${bounded(input.utterance, MAX_UTTERANCE_CHARS)}`);
  sections.push('Answer with JSON only: {"directed": true|false, "confidence": 0.0-1.0}');
  return [{ role: "user", content: sections.join("\n\n") }];
}

/** Why a turn was accepted or declined — logged, so a false negative is diagnosable. */
export type IntentDecision =
  | { accept: true; reason: "hot-window" | "judged-directed" | "low-confidence" | "unavailable" }
  | { accept: false; reason: "judged-undirected"; confidence: number };

export interface IntentJudge {
  decide(input: IntentJudgeInput, signal?: AbortSignal): Promise<IntentDecision>;
}

/**
 * The judge over a classification-only model.
 *
 * `provider` must be the classifier role, never the reply model — this runs on
 * every utterance. Absence of a classifier is why this returns null rather than
 * quietly borrowing something more expensive.
 */
export function createIntentJudge(
  provider: LLMProvider | undefined,
  options: Partial<IntentJudgeOptions> = {},
): IntentJudge | null {
  if (!provider) return null;
  const opts = { ...DEFAULT_INTENT_JUDGE_OPTIONS, ...options };

  return {
    async decide(input, signal): Promise<IntentDecision> {
      // A follow-up moments after Cicero spoke is the case a judge is most
      // likely to get wrong and the one we are surest about. Skip the call.
      if (input.msSinceAssistantSpoke !== null && input.msSinceAssistantSpoke <= opts.hotWindowMs) {
        return { accept: true, reason: "hot-window" };
      }

      // Already cancelled: do not start a request whose only outcome is to be
      // thrown away after the full deadline.
      if (signal?.aborted) return { accept: true, reason: "unavailable" };

      const controller = new AbortController();
      let expire!: (reason: Error) => void;
      // Aborting only asks. This judge sits in the audio path: a classifier that
      // ignores its signal would block every utterance forever, so the wait is
      // settled here rather than trusting the provider to cooperate.
      const deadline = new Promise<never>((_resolve, reject) => { expire = reject; });
      const timer = setTimeout(() => {
        controller.abort();
        expire(new Error(`intent judge exceeded ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
      const abortOnCaller = (): void => {
        controller.abort();
        expire(new Error("intent judge cancelled"));
      };
      signal?.addEventListener("abort", abortOnCaller, { once: true });
      let raw: string;
      try {
        // race() subscribes to both, so a provider rejecting after the deadline
        // already won is handled and ignored, not unhandled.
        raw = await Promise.race([
          provider.chatCompletion(buildJudgePrompt(input, opts.contextTurns), {
            max_tokens: 32,
            temperature: 0,
            responseFormat: { type: "json_schema", json_schema: VERDICT_SCHEMA as unknown as Record<string, unknown> },
            signal: controller.signal,
          }),
          deadline,
        ]);
      } catch (error: unknown) {
        // Down, slow, or cancelled. Accept — the listener behaves exactly as it
        // did before this feature existed.
        log("info", `Intent judge unavailable, accepting the turn: ${error instanceof Error ? error.message : String(error)}`);
        return { accept: true, reason: "unavailable" };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortOnCaller);
      }

      let verdict: IntentVerdict | null;
      try {
        verdict = parseVerdict(raw);
      } catch {
        // parseVerdict is defensive, but this is the invariant the whole
        // feature rests on: decide() resolves, never rejects.
        verdict = null;
      }
      if (!verdict) {
        log("info", "Intent judge returned an unusable verdict, accepting the turn");
        return { accept: true, reason: "unavailable" };
      }
      if (verdict.directed) return { accept: true, reason: "judged-directed" };
      if (verdict.confidence < opts.minConfidence) {
        // It thinks not, but not confidently. Being deaf is worse than being
        // eager, so an unsure "no" does not get to decline the turn.
        return { accept: true, reason: "low-confidence" };
      }
      return { accept: false, reason: "judged-undirected", confidence: verdict.confidence };
    },
  };
}
