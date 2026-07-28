import { describe, expect, test } from "bun:test";
import { coalesceSentences, CLOSE_CONFIRM_MS, MAX_QUEUED_CHARS } from "../../src/speaker/coalesce";

/** Yield each item immediately — everything is "already available". */
async function* immediate(items: string[]): AsyncGenerator<string> {
  for (const item of items) yield item;
}

/** Yield each item only after the previous one has been consumed and a tick passes. */
async function* paced(items: string[], gapMs = 5): AsyncGenerator<string> {
  for (const item of items) {
    await Bun.sleep(gapMs);
    yield item;
  }
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of source) out.push(chunk);
  return out;
}

describe("sentence coalescing", () => {
  test("merges adjacent sentences that are already available", async () => {
    const out = await collect(coalesceSentences(
      immediate(["One.", "Two.", "Three.", "Four."]),
      { passthroughFirst: 1, maxChars: 1_000 },
    ));
    // First goes out alone; the rest arrive together and merge.
    expect(out[0]).toBe("One.");
    expect(out.slice(1).join(" ")).toBe("Two. Three. Four.");
    expect(out.length).toBeLessThan(4);
  });

  // The whole point: time-to-first-audio is set by how fast sentence one
  // reaches the engine, and nothing may sit in front of it.
  test("the first sentence is never held back or merged", async () => {
    const out = await collect(coalesceSentences(
      immediate(["First.", "Second.", "Third."]),
      { passthroughFirst: 1, maxChars: 1_000 },
    ));
    expect(out[0]).toBe("First.");
  });

  test("passthroughFirst can protect more than one sentence", async () => {
    const out = await collect(coalesceSentences(
      immediate(["A.", "B.", "C.", "D."]),
      { passthroughFirst: 2, maxChars: 1_000 },
    ));
    expect(out[0]).toBe("A.");
    expect(out[1]).toBe("B.");
  });

  // Coalescing that waits for a second sentence would trade first-audio
  // latency for throughput, which is the wrong trade.
  test("never waits: a slow producer is emitted one sentence at a time", async () => {
    const out = await collect(coalesceSentences(
      paced(["One.", "Two.", "Three."]),
      { passthroughFirst: 1, maxChars: 1_000 },
    ));
    expect(out).toEqual(["One.", "Two.", "Three."]);
  });

  test("respects the character cap", async () => {
    const long = "x".repeat(100);
    const out = await collect(coalesceSentences(
      immediate([`${long}1.`, `${long}2.`, `${long}3.`]),
      { passthroughFirst: 0, maxChars: 240 },
    ));
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(240);
  });

  // Splitting is the segmenter's job; we must not silently drop or cut one.
  test("a single sentence longer than the cap still goes out whole", async () => {
    const huge = `${"y".repeat(500)}.`;
    const out = await collect(coalesceSentences(
      immediate([huge]),
      { passthroughFirst: 0, maxChars: 240 },
    ));
    expect(out).toEqual([huge]);
  });

  // Coalescing must be lossless: same words, same order, different packaging.
  test("preserves every sentence and its order", async () => {
    const input = Array.from({ length: 25 }, (_, i) => `Sentence ${i}.`);
    const out = await collect(coalesceSentences(immediate(input), { passthroughFirst: 1, maxChars: 60 }));
    expect(out.join(" ")).toBe(input.join(" "));
  });

  test("an empty stream yields nothing", async () => {
    expect(await collect(coalesceSentences(immediate([]), {}))).toEqual([]);
  });

  test("a single sentence is passed straight through", async () => {
    expect(await collect(coalesceSentences(immediate(["Only one."]), {}))).toEqual(["Only one."]);
  });

  // A trailing partial merge must not be swallowed when the stream ends.
  test("flushes a pending merge when the producer finishes", async () => {
    const out = await collect(coalesceSentences(
      immediate(["A.", "B."]),
      { passthroughFirst: 0, maxChars: 1_000 },
    ));
    expect(out.join(" ")).toBe("A. B.");
  });

  test("a producer error surfaces rather than truncating the reply silently", async () => {
    async function* failing(): AsyncGenerator<string> {
      yield "First.";
      throw new Error("brain stream died");
    }
    await expect(collect(coalesceSentences(failing(), {}))).rejects.toThrow(/brain stream died/);
  });
});

test("abandoning the coalescer closes the source and stops the drain", async () => {
  let closed = false;
  let produced = 0;
  // An unbounded producer: if nothing closes it, it keeps generating forever.
  async function* endless(): AsyncGenerator<string> {
    try {
      for (;;) {
        produced += 1;
        yield `Sentence ${produced}.`;
      }
    } finally {
      closed = true;
    }
  }

  const merged = coalesceSentences(endless(), { maxChars: 240, passthroughFirst: 1 });
  await merged.next();
  await merged.return(undefined);

  expect(closed).toBe(true);
  const producedAtClose = produced;
  // The drain is a background loop; if close() only requested a stop without
  // awaiting it, the producer would keep running past this point.
  await Bun.sleep(20);
  expect(produced).toBe(producedAtClose);
});

test("read-ahead stops at the queue cap instead of buffering an unbounded reply", async () => {
  let produced = 0;
  async function* endless(): AsyncGenerator<string> {
    for (;;) {
      produced += 1;
      yield "x".repeat(1_000);
    }
  }

  const merged = coalesceSentences(endless(), { maxChars: 240, passthroughFirst: 1 });
  await merged.next();
  await Bun.sleep(20);
  const parked = produced;
  await Bun.sleep(20);
  // Backpressure: nothing has been taken since, so the drain must be parked.
  expect(produced).toBe(parked);
  expect(produced * 1_000).toBeLessThanOrEqual(MAX_QUEUED_CHARS + 1_000);
  await merged.return(undefined);
});

test("a falsy producer failure still propagates instead of ending the reply", async () => {
  async function* throwsNull(): AsyncGenerator<string> {
    yield "First.";
    // Legal, and the reason failure is tracked by a flag rather than truthiness:
    // treating this as a clean end would silently truncate the reply.
    throw null;
  }

  const merged = coalesceSentences(throwsNull(), { maxChars: 240, passthroughFirst: 1 });
  const first = await merged.next();
  expect(first.value).toBe("First.");
  await expect(merged.next()).rejects.toBeNull();
});

test("closing settles promptly even when the producer is parked mid-read", async () => {
  // Never yields again: a brain stream stalled on the network. Async iterators
  // serialize next()/return(), so return() cannot overtake this read — cleanup
  // must not wait on it.
  async function* stalls(): AsyncGenerator<string> {
    yield "First.";
    await new Promise<void>(() => { /* never resolves */ });
  }

  const merged = coalesceSentences(stalls(), { maxChars: 240, passthroughFirst: 1 });
  expect((await merged.next()).value).toBe("First.");

  const start = performance.now();
  await merged.return(undefined);
  const elapsed = performance.now() - start;
  // Bounded by CLOSE_CONFIRM_MS, not by the producer. Without the bound this
  // never returns and the test times out.
  expect(elapsed).toBeLessThan(CLOSE_CONFIRM_MS * 4);
});
