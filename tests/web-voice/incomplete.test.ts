import { expect, test } from "bun:test";
import { IncompleteTurnFilter, type IncompleteClock } from "../../src/web-voice/incomplete";

export class Clock implements IncompleteClock {
  time = 0;
  next = 0;
  timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  };
  clearTimeout = (id: unknown) => { this.timers.delete(id as number); };
  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const entry = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry || entry[1].at > end) break;
      this.time = entry[1].at;
      this.timers.delete(entry[0]);
      entry[1].fn();
    }
    this.time = end;
  }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("incomplete waits silently then answers at the bounded deadline", async () => {
  const clock = new Clock();
  const filter = new IncompleteTurnFilter(async () => "incomplete", {}, clock);
  let settled = false;
  const result = filter.resolve("so what I want is").then((t) => { settled = true; return t; });
  await flush();
  clock.advance(2999);
  expect(settled).toBe(false);
  clock.advance(1);
  expect(await result).toBe("so what I want is");
  expect(clock.timers.size).toBe(0);
});

test("barge-in cancels old output but joins the next utterance once", async () => {
  const clock = new Clock();
  const inputs: string[] = [];
  const filter = new IncompleteTurnFilter(async (text) => {
    inputs.push(text);
    return text.endsWith("is") ? "incomplete" : "complete";
  }, {}, clock);
  const abort = new AbortController();
  const first = filter.resolve("what I want is", abort.signal);
  await flush();
  abort.abort();
  expect(await first).toBeNull();
  expect(await filter.resolve("a test")).toBe("what I want is a test");
  expect(await filter.resolve("hello")).toBe("hello");
  expect(inputs).toEqual(["what I want is", "what I want is a test", "hello"]);
  expect(clock.timers.size).toBe(0);
});

test("repeated incomplete continuations cannot extend the original deadline", async () => {
  const clock = new Clock();
  const filter = new IncompleteTurnFilter(async () => "incomplete", {}, clock);
  const abort = new AbortController();
  const first = filter.resolve("I want", abort.signal);
  await flush();
  clock.advance(2000);
  abort.abort();
  await first;
  const second = filter.resolve("um");
  await flush();
  clock.advance(1000);
  expect(await second).toBe("I want um");
  expect(clock.timers.size).toBe(0);
});

test("classifier timeout aborts and quarantines late work; failure accepts", async () => {
  const clock = new Clock();
  let late!: (value: string) => void;
  let signal!: AbortSignal;
  let calls = 0;
  const filter = new IncompleteTurnFilter((_, s) => {
    calls++; signal = s;
    return new Promise((resolve) => { late = resolve; });
  }, {}, clock);
  const first = filter.resolve("hello");
  clock.advance(250);
  expect(await first).toBe("hello");
  expect(signal.aborted).toBe(true);
  expect(await filter.resolve("next")).toBe("next");
  expect(calls).toBe(1);
  late("incomplete");
  await flush();
  expect(clock.timers.size).toBe(0);
  const failed = new IncompleteTurnFilter(async () => { throw new Error("synthetic"); }, {}, clock);
  expect(await failed.resolve("hi")).toBe("hi");
  expect(clock.timers.size).toBe(0);
});

test("reset/disconnect cancels active output and forgets retained words", async () => {
  const clock = new Clock();
  let verdict = "incomplete";
  const filter = new IncompleteTurnFilter(async () => verdict, {}, clock);
  const first = filter.resolve("old words");
  await flush();
  filter.reset();
  expect(await first).toBeNull();
  expect(clock.timers.size).toBe(0);
  verdict = "complete";
  expect(await filter.resolve("fresh")).toBe("fresh");
});

test("combined input is bounded and overflow discards its prefix", async () => {
  const clock = new Clock();
  const filter = new IncompleteTurnFilter(async () => "incomplete", {}, clock);
  const abort = new AbortController();
  const first = filter.resolve("x".repeat(16_384), abort.signal);
  await flush(); abort.abort(); await first;
  await expect(filter.resolve("more")).rejects.toThrow("transcript too long");
  expect(clock.timers.size).toBe(0);
});

test("complete turns pay only classifier latency, never the silence window", async () => {
  const clock = new Clock();
  const filter = new IncompleteTurnFilter(() => new Promise((resolve) => {
    clock.setTimeout(() => resolve("complete"), 12);
  }), {}, clock);
  const start = clock.now();
  const result = filter.resolve("run the tests");
  clock.advance(12);
  expect(await result).toBe("run the tests");
  expect(clock.now() - start).toBe(12);
  expect(clock.timers.size).toBe(0);
});

for (const marker of ["complete", "", "incomplete please", "x".repeat(10000)]) {
  test(`non-marker output accepts immediately (${marker.slice(0, 20)})`, async () => {
    const clock = new Clock();
    const filter = new IncompleteTurnFilter(async () => marker, {}, clock);
    expect(await filter.resolve("hi")).toBe("hi");
    expect(clock.timers.size).toBe(0);
  });
}

test("speech onset retains a long continuation, but abandoned captures expire", async () => {
  const clock = new Clock();
  const filter = new IncompleteTurnFilter(async () => "incomplete", {}, clock);
  const abort = new AbortController();
  const first = filter.resolve("please change", abort.signal);
  await flush(); abort.abort(); await first;
  clock.advance(5000);
  expect(await filter.resolve("the tests in the parser")).toBe("please change the tests in the parser");
  expect(clock.timers.size).toBe(0);
  const abandoned = new AbortController();
  const second = filter.resolve("discard me", abandoned.signal);
  await flush(); abandoned.abort(); await second;
  clock.advance(120_000);
  const fresh = filter.resolve("new input");
  await flush(); clock.advance(3000);
  expect(await fresh).toBe("new input");
  expect(clock.timers.size).toBe(0);
});
