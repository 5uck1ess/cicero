/**
 * Merge adjacent sentences that are ALREADY available before handing them to
 * synthesis, cutting per-call overhead on multi-sentence replies.
 *
 * Two properties make this safe to put in front of the speaker:
 *
 * 1. **It never waits.** Sentences are drained into a queue as fast as the
 *    producer yields them; each emission takes whatever is queued *right now*.
 *    If nothing has arrived yet, one sentence goes out alone. Coalescing that
 *    waited for a second sentence would trade the thing Cicero is tuned for —
 *    time to first audio — for a throughput win, which is the wrong trade.
 *
 * 2. **The first sentences are never merged.** Time-to-first-audio is a
 *    headline property of the streaming speaker, and it is set entirely by how
 *    fast sentence one reaches the TTS engine. `passthroughFirst` emits that
 *    many sentences verbatim before any merging begins.
 *
 * Whether this is a net win is a measurement, not an opinion — see
 * `bench/tts-coalesce-bench.ts`. It is off by default.
 */

export interface CoalesceOptions {
  /** Upper bound on a merged chunk. Beyond this, engines lose their latency edge. */
  maxChars: number;
  /** Sentences emitted alone before merging starts. Protects first-audio latency. */
  passthroughFirst: number;
}

export const DEFAULT_COALESCE_OPTIONS: CoalesceOptions = {
  maxChars: 240,
  passthroughFirst: 1,
};

/**
 * Drain `source` into a queue eagerly, so the consumer can always ask "what has
 * arrived so far?" without awaiting anything it does not already have.
 */
function eagerQueue<T>(source: AsyncIterable<T>): {
  take: () => Promise<T[] | null>;
} {
  const queued: T[] = [];
  let done = false;
  let failure: unknown = null;
  let wake: (() => void) | undefined;

  const drain = (async () => {
    try {
      for await (const item of source) {
        queued.push(item);
        wake?.();
      }
    } catch (error: unknown) {
      failure = error;
    } finally {
      done = true;
      wake?.();
    }
  })();
  // The consumer observes completion through take(); this keeps a producer
  // error from surfacing as an unhandled rejection in the meantime.
  void drain.catch(() => { /* surfaced by take() */ });

  return {
    /** Everything available now, awaiting only when the queue is empty. */
    async take(): Promise<T[] | null> {
      while (queued.length === 0 && !done) {
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
      if (queued.length === 0) {
        if (failure) throw failure;
        return null;
      }
      return queued.splice(0, queued.length);
    },
  };
}

export async function* coalesceSentences(
  sentences: AsyncIterable<string>,
  options: Partial<CoalesceOptions> = {},
): AsyncGenerator<string> {
  const { maxChars, passthroughFirst } = { ...DEFAULT_COALESCE_OPTIONS, ...options };
  const queue = eagerQueue(sentences);
  let emitted = 0;
  /** Carried across take() calls so a partial merge is not flushed early. */
  let pending = "";

  const flush = function* (): Generator<string> {
    if (pending) {
      yield pending;
      pending = "";
      emitted += 1;
    }
  };

  for (;;) {
    const batch = await queue.take();
    if (batch === null) break;

    for (const sentence of batch) {
      // Early sentences go out untouched, and cannot be held back by a pending
      // merge either — nothing may sit in front of first audio.
      if (emitted < passthroughFirst && !pending) {
        yield sentence;
        emitted += 1;
        continue;
      }
      if (!pending) {
        pending = sentence;
        continue;
      }
      const merged = `${pending} ${sentence}`;
      if (merged.length > maxChars) {
        // Emitting `pending` rather than the oversized merge keeps every chunk
        // under the cap; an already-oversized single sentence still goes out
        // whole, since splitting it is the segmenter's job, not ours.
        yield* flush();
        pending = sentence;
        continue;
      }
      pending = merged;
    }

    // Nothing more has arrived, so holding `pending` back would be pure added
    // latency. This is the line that makes coalescing free.
    yield* flush();
  }

  yield* flush();
}
