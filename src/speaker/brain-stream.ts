import type { Brain, BrainTurnOptions } from "../types";
import type { StreamingTTSSpeaker } from "./streaming-tts";
import { segmentSentences } from "./sentence-stream";
import { shouldSpeakToolStartNotice } from "./thinking-filler";
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
  toolStartNotice = true,
): Promise<void> {
  const sendStream = brain.sendStream;
  if (!sendStream) throw new Error("brain does not support streaming");
  await speakGuarded(speaker, (turnOptions) => sendStream.call(brain, prompt, turnOptions), filler, options, toolStartNotice);
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
  toolStartNotice = true,
): Promise<void> {
  const streamProgress = brain.streamProgress;
  if (!streamProgress) throw new Error("brain does not support progress narration");
  await speakGuarded(speaker, (turnOptions) => streamProgress.call(brain, prompt, turnOptions), filler, options, toolStartNotice);
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
  source: (options: BrainTurnOptions) => AsyncIterable<string>,
  filler?: string,
  options: BrainTurnOptions = {},
  toolStartNotice = true,
): Promise<void> {
  // One controller per turn: aborted by the caller's signal, and handed to the
  // speaker so an interrupt during playback also cancels in-flight inference.
  const turnAbort = new AbortController();
  const outerSignal = options.signal;
  const onOuterAbort = () => turnAbort.abort(outerSignal?.reason);
  if (outerSignal?.aborted) onOuterAbort();
  else outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  const turnOptions: BrainTurnOptions = { ...options, signal: turnAbort.signal };
  let streamError: unknown = null;
  const timer = newTurnTimer();
  let firstToken = false;
  let firstSentence = false;
  let replyStarted = false;
  let toolNoticeSent = false;
  let closed = false;
  const notices: string[] = [];
  let wake: (() => void) | undefined;
  const onNotice: NonNullable<BrainTurnOptions["onNotice"]> = (notice) => {
    const snapshot = filler ? speaker.getSnapshot?.() : undefined;
    const fillerActive = !!filler && (!snapshot || snapshot.pending.includes(filler) || !snapshot.spoken.includes(filler));
    if (closed || turnAbort.signal.aborted || (notice.type === "tool" && (toolNoticeSent || !shouldSpeakToolStartNotice(toolStartNotice, replyStarted, fillerActive)))) return;
    if (notices.length >= 32) return;
    if (notice.type === "tool") toolNoticeSent = true;
    notices.push(notice.text);
    wake?.();
  };
  const guarded = async function* (): AsyncGenerator<string> {
    try {
      const iterator = source({ ...turnOptions, onNotice })[Symbol.asyncIterator]();
      let next = iterator.next();
      while (true) {
        while (notices.length) yield `${notices.shift()!} `;
        let release!: () => void;
        const notified = new Promise<"notice">((resolve) => { release = () => resolve("notice"); });
        wake = release;
        const result = await Promise.race([next.then((value) => ({ value })), notified]);
        wake = undefined;
        if (result === "notice") continue;
        if (result.value.done) break;
        replyStarted = true;
        if (!firstToken) { firstToken = true; timer.mark("brain_first_token"); }
        yield result.value.value;
        next = iterator.next();
      }
      while (notices.length) yield `${notices.shift()!} `;
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
    await speaker.speakStream(withFiller(), turnAbort);
  } finally {
    outerSignal?.removeEventListener("abort", onOuterAbort);
    closed = true;
    wake?.();
    timer.report("brain-turn");
  }
  if (streamError) throw streamError;
}
