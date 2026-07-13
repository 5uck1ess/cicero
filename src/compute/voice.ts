import type { AgentAction } from "./actions";
import { describeActionForConfirmation } from "./actions";

const AFFIRMATIVE = /\b(yes|yeah|yep|yup|sure|okay|ok|confirm|affirmative|go ahead|do it)\b/i;
// Any negation present makes the whole reply non-affirmative. Checked FIRST so
// phrases like "not ok", "no, that's okay", "don't do it" can never approve an
// action — the safety boundary must fail closed on ambiguity.
const NEGATIVE = /\b(no|not|nope|nah|never|cancel|stop|negative|don'?t|do not)\b/i;

/** True when a spoken reply unambiguously means "go ahead". Pure + unit-testable (no audio). */
export function parseAffirmative(transcript: string): boolean {
  const reply = transcript.trim();
  if (!reply) return false;
  if (NEGATIVE.test(reply)) return false;
  return AFFIRMATIVE.test(reply);
}

export interface VoiceConfirmDeps {
  speak: (text: string) => Promise<void>;
  listenOnce: () => Promise<string>;
}

/**
 * A spoken confirmation gate for the agent loop: announces the pending action,
 * captures one STT turn, and allows it only on an affirmative reply.
 */
export function makeVoiceConfirm(deps: VoiceConfirmDeps): (action: AgentAction) => Promise<boolean> {
  return async (action) => {
    await deps.speak(`About to ${describeActionForConfirmation(action)}. Say yes to continue.`);
    const reply = await deps.listenOnce();
    return parseAffirmative(reply);
  };
}

/**
 * A narrator for the agent loop's `log`: speaks each step through the existing
 * streaming TTS. Fire-and-forget so narration never blocks the loop.
 */
export function makeVoiceNarrator(deps: { speak: (text: string) => Promise<void> }): (message: string) => void {
  return (message) => { void deps.speak(message); };
}
