import type { Brain, BrainTurnOptions } from "../types";
import type { StreamingTTSSpeaker } from "./streaming-tts";
import { segmentSentences } from "./sentence-stream";
import { newTurnTimer } from "../timing";

/** True when the brain can stream its response token-by-token. */
export function canStreamBrain(brain: Brain): boolean {
  return typeof brain.sendStream === "function";
}

/** True when the brain can narrate its progress (what it's *doing*, not just the answer). */
export function canNarrateAgent(brain: Brain): boolean {
  return typeof brain.streamProgress === "function";
}

/**
 * Pipe a brain's streamed response through the sentence segmenter into the
 * streaming speaker, so the first sentence is spoken while later ones are still
 * being produced. Caller must have already confirmed `canStreamBrain(brain)`.
 */
export async function streamBrainToSpeaker(
  brain: Brain,
  speaker: StreamingTTSSpeaker,
  prompt: string,
  filler?: string,
  options?: BrainTurnOptions,
): Promise<void> {
  const sendStream = brain.sendStream;
  if (!sendStream) throw new Error("brain does not support streaming");
  await speakGuarded(speaker, () => sendStream.call(brain, prompt, options), filler);
}

/**
 * Like {@link streamBrainToSpeaker} but speaks the brain's *progress narration*
 * (its messages, the commands it runs, the final answer) — so Cicero says what
 * the agent is doing as it works. Caller must have confirmed `canNarrateAgent(brain)`.
 */
export async function streamAgentNarration(
  brain: Brain,
  speaker: StreamingTTSSpeaker,
  prompt: string,
  filler?: string,
  options?: BrainTurnOptions,
): Promise<void> {
  const streamProgress = brain.streamProgress;
  if (!streamProgress) throw new Error("brain does not support progress narration");
  await speakGuarded(speaker, () => streamProgress.call(brain, prompt, options), filler);
}

/**
 * Speak a text stream through the sentence segmenter. The streaming speaker stays
 * resilient to a single bad sentence by swallowing iterator errors; a *source*
 * failure (e.g. the agent subprocess exiting non-zero) must not be swallowed too,
 * so capture it and rethrow after the speaker drains — the daemon's handler then
 * runs (error earcon + spoken notice) instead of the turn dying silently.
 */
async function speakGuarded(
  speaker: StreamingTTSSpeaker,
  source: () => AsyncIterable<string>,
  filler?: string,
): Promise<void> {
  let streamError: unknown = null;
  const timer = newTurnTimer();
  let firstToken = false;
  let firstSentence = false;
  const guarded = async function* (): AsyncGenerator<string> {
    try {
      for await (const token of source()) {
        if (!firstToken) { firstToken = true; timer.mark("brain_first_token"); }
        yield token;
      }
    } catch (err) {
      streamError = err;
      throw err;
    }
  };
  // Prepend the filler as a complete first sentence: the speaker TTS-es and plays
  // it immediately while the agent's real response is still generating (the
  // speaker's generate-one-ahead drives `source()` during filler playback), so the
  // filler covers the latency instead of adding to it. The `first_sentence` mark
  // tracks the first *content* sentence (not the filler), so timing shows when the
  // real answer starts regardless of the filler.
  const withFiller = async function* (): AsyncGenerator<string> {
    if (filler) yield filler;
    for await (const sentence of segmentSentences(guarded())) {
      if (!firstSentence) { firstSentence = true; timer.mark("first_sentence"); }
      yield sentence;
    }
  };
  try {
    await speaker.speakStream(withFiller());
  } finally {
    timer.report("brain-turn");
  }
  if (streamError) throw streamError;
}
