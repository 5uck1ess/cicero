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
 * How much unspoken text may sit in the queue before the drain stops pulling.
 *
 * Reading ahead is the whole point, but it also removes the backpressure the
 * speaker used to apply by pulling exactly one sentence at a time: a brain that
 * generates faster than the engine speaks would otherwise buffer an entire
 * unbounded reply in memory.
 *
 * A batch that ends at the cap does flush a merge early, so one chunk per 16k
 * characters can come out shorter than it strictly had to. That is a rounding
 * error against a 240-char chunk, and it costs a fraction of a call rather than
 * any correctness: no sentence is lost, reordered, or split.
 */
export const MAX_QUEUED_CHARS = 16_000;

/**
 * How long close() waits for the drain to confirm it stopped.
 *
 * Async iterators serialize next() and return(), so return() cannot overtake an
 * in-flight read — a producer parked mid-read cannot be made to stop now, only
 * asked to stop next. Waiting for confirmation without a bound would hand a
 * stalled brain stream the power to block barge-in cleanup, which is the
 * opposite of what cancellation is for. So: ask, wait briefly, move on.
 *
 * An abandoned drain cannot resurrect — `closed` is re-checked immediately after
 * the read, so it exits on first resumption and publishes nothing. Until then it
 * does keep its source and whatever was already queued alive, which is the price
 * of not blocking: a producer that never resumes is a producer nothing can
 * collect.
 */
export const CLOSE_CONFIRM_MS = 250;

/** Bounded wait that never leaves a timer holding the event loop open. */
function settleWithin<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Drain `source` into a queue eagerly, so the consumer can always ask "what has
 * arrived so far?" without awaiting anything it does not already have.
 *
 * The drain is a background loop, so it needs an owner: `close()` stops it and
 * returns the source iterator, and the coalescer calls it on every exit path.
 * Without that, an interrupted turn would leave the previous reply's producer
 * running and buffering into a queue nobody reads.
 */
function eagerQueue(
  source: AsyncIterable<string>,
  maxQueuedChars: number,
  cancel?: AbortSignal,
): {
  take: () => Promise<string[] | null>;
  close: () => Promise<void>;
} {
  const queued: string[] = [];
  let queuedChars = 0;
  let done = false;
  // Tracked separately from the value: `throw null` is legal, and treating a
  // falsy failure as a clean end would truncate the reply silently.
  let failed = false;
  let failure: unknown = null;
  let closed = false;
  let wakeConsumer: (() => void) | undefined;
  let wakeProducer: (() => void) | undefined;

  const iterator = source[Symbol.asyncIterator]();

  // A consumer parked in take() cannot observe a return() — the language queues
  // it behind the pending next(). So cancellation has to arrive out of band:
  // aborting wakes the consumer, take() reports the end, and the generator
  // unwinds into its finally on its own.
  let cancelled = cancel?.aborted ?? false;
  const onCancel = (): void => {
    cancelled = true;
    wakeConsumer?.();
    wakeProducer?.();
  };
  cancel?.addEventListener("abort", onCancel, { once: true });

  const drain = (async () => {
    try {
      for (;;) {
        while (!closed && !cancelled && queuedChars >= maxQueuedChars) {
          await new Promise<void>((resolve) => { wakeProducer = resolve; });
          wakeProducer = undefined;
        }
        if (closed || cancelled) break;
        const next = await iterator.next();
        // Re-checked after the read: close() may have landed while it was in
        // flight, and a closed queue must not retain one last sentence.
        if (next.done || closed || cancelled) break;
        queued.push(next.value);
        queuedChars += next.value.length;
        wakeConsumer?.();
      }
    } catch (error: unknown) {
      failed = true;
      failure = error;
    } finally {
      done = true;
      wakeConsumer?.();
    }
  })();
  // The consumer observes completion through take(); this keeps a producer
  // error from surfacing as an unhandled rejection in the meantime.
  void drain.catch(() => { /* surfaced by take() */ });

  return {
    /** Everything available now, awaiting only when the queue is empty. */
    async take(): Promise<string[] | null> {
      while (queued.length === 0 && !done && !cancelled) {
        await new Promise<void>((resolve) => { wakeConsumer = resolve; });
        wakeConsumer = undefined;
      }
      // A cancelled turn is being torn down; its remaining text is not going to
      // be spoken, and reporting the end is what lets the generator unwind.
      if (cancelled) return null;
      if (queued.length === 0) {
        if (failed) throw failure;
        return null;
      }
      const batch = queued.splice(0, queued.length);
      queuedChars = 0;
      wakeProducer?.();
      return batch;
    },

    /** Stop the drain and release the source, bounded so cleanup cannot hang. */
    async close(): Promise<void> {
      closed = true;
      // A drain parked on backpressure stops immediately; this is the one park
      // we own and can release ourselves.
      wakeProducer?.();
      // Closes a generator source, running its finally blocks. Not awaited: if
      // the drain is mid-next(), this queues behind that read and would inherit
      // however long the producer takes.
      void Promise.resolve(iterator.return?.()).catch(() => { /* being abandoned */ });
      cancel?.removeEventListener("abort", onCancel);
      await settleWithin(drain, CLOSE_CONFIRM_MS);
    },
  };
}

export async function* coalesceSentences(
  sentences: AsyncIterable<string>,
  options: Partial<CoalesceOptions> = {},
  cancel?: AbortSignal,
): AsyncGenerator<string> {
  const { maxChars, passthroughFirst } = { ...DEFAULT_COALESCE_OPTIONS, ...options };
  const queue = eagerQueue(sentences, MAX_QUEUED_CHARS, cancel);
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

  try {
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
  } finally {
    // Reached on normal completion, on a producer error, and — the case that
    // matters — when the speaker abandons this generator mid-reply after a
    // barge-in. The drain owns a live iterator; nothing else will stop it.
    await queue.close();
  }
}
