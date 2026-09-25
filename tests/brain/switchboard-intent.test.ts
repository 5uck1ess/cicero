import { expect, test, spyOn } from "bun:test";
import { classifySwitchboardIntent, parseIntent, NONE, MAX_INTENT_BYTES } from "../../src/brain/switchboard-intent";
import { SwitchboardBrain } from "../../src/brain/switchboard";
import { summarizerClassifier } from "../../src/brain";
import type { Brain } from "../../src/types";

const roster = { coder: { aliases: ["Rick", "the coder"] }, reviewer: { aliases: ["Ada"] } };
const json = (extra = {}) => JSON.stringify({ intent: "rollcall", target: null, request_now: true, confidence: 0.9, ...extra });
const signal = () => new AbortController().signal;
const front = (): Brain => ({ start: async () => {}, stop: async () => {}, send: async () => "normal turn", injectContext: () => {}, restart: async () => {}, health: async () => true });

test("strict JSON rejects malformed, unknown, missing, additional and oversized fields", () => {
  for (const raw of ["rollcall", "```json\n" + json() + "\n```", "null", "[]", "{}", json({ intent: "dance" }), json({ confidence: 1.1 }), json({ confidence: "0.9" }), json({ request_now: 1 }), json({ target: 12 }), json({ extra: 1 }), json({ target: "x".repeat(129) }), " ".repeat(MAX_INTENT_BYTES) + json(), JSON.stringify({ intent: "none", target: null, confidence: 1 })]) {
    expect(parseIntent(raw, roster)).toEqual(NONE);
  }
  expect(parseIntent(json(), roster)).toMatchObject({ intent: "rollcall", confidence: 0.9 });
});

test("targets resolve exact roster names and aliases, never fuzzy guesses", () => {
  expect(parseIntent(json({ intent: "transfer", target: " RICK " }), roster).target).toBe("coder");
  for (const target of [null, "Rik", "nobody", "__proto__"]) expect(parseIntent(json({ intent: "transfer", target }), roster)).toEqual(NONE);
  expect(parseIntent(json({ intent: "callme", target: "nobody" }), roster)).toMatchObject({ intent: "callme", target: null });
  expect(parseIntent(json({ intent: "transfer", target: "Rick" }), { ...roster, other: { aliases: ["Rick"] } })).toEqual(NONE);
});

test("deadline aborts an uncooperative classifier and ignores its late result", async () => {
  let owned: AbortSignal | undefined;
  let late!: (s: string) => void;
  const start = performance.now();
  const result = await classifySwitchboardIntent((_p, s) => { owned = s; return new Promise((resolve) => { late = resolve; }); }, "gather the gang", roster, signal(), 10);
  expect(result).toEqual(NONE);
  expect(owned?.aborted).toBe(true);
  expect(performance.now() - start).toBeLessThan(500);
  late(json());
});

test("provider errors become none but caller cancellation remains cancellation", async () => {
  expect(await classifySwitchboardIntent(async () => { throw new Error("synthetic-secret"); }, "hi", roster, signal())).toEqual(NONE);
  const controller = new AbortController();
  const task = classifySwitchboardIntent(async () => { controller.abort(new Error("caller stopped")); return json(); }, "hi", roster, controller.signal);
  await expect(task).rejects.toThrow("caller stopped");
});

test("confidence and request_now gate action; exact boundary acts and records duration", async () => {
  for (const [confidence, request_now, acts] of [[0.69, true, false], [0.7, true, true], [0.99, false, false]] as const) {
    const sb = new SwitchboardBrain(front(), { coder: { brain: front() } }, async () => json({ confidence, request_now }));
    const durations: number[] = [];
    const answer = await sb.send("let's do a quick roll call", { onIntentMs: (ms) => durations.push(ms) });
    expect(answer.includes("checking in")).toBe(acts);
    expect(durations.length).toBe(1);
    expect(durations[0]).toBeGreaterThanOrEqual(0);
    await sb.stop();
  }
  const sb = new SwitchboardBrain(front(), { coder: { brain: front() } }, async () => json(), { intentMinConfidence: 0.95 });
  expect(await sb.send("gather the gang")).toBe("normal turn");
  await sb.stop();
});

test("timeout proceeds with the normal brain and cannot publish a late action", async () => {
  let resolve!: (s: string) => void;
  const sb = new SwitchboardBrain(front(), { coder: { brain: front() } }, () => new Promise((r) => { resolve = r; }), { intentTimeoutMs: 5 });
  expect(await sb.send("gather the gang")).toBe("normal turn");
  resolve(json());
  await Promise.resolve();
  expect(sb.wasControlTurn()).toBe(false);
  await sb.stop();
});

test("HTTP classifier negotiates JSON schema once and bounds output without changing bare-label callers", async () => {
  const bodies: any[] = [];
  const mock = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    if (bodies.length === 1) return new Response("unsupported format", { status: 400 });
    return Response.json({ choices: [{ message: { content: json() } }] });
  });
  try {
    const classifier = summarizerClassifier({ summarizer_url: "http://synthetic.invalid/v1" }, true)!;
    expect(parseIntent(await classifier("prompt", signal()), roster).intent).toBe("rollcall");
    await classifier("next", signal());
    expect(bodies[0].response_format.type).toBe("json_schema");
    expect(bodies[0].max_tokens).toBe(160);
    expect(bodies[1].response_format).toBeUndefined();
    expect(bodies[2].response_format).toBeUndefined();
    await summarizerClassifier({ summarizer_url: "http://synthetic.invalid/v1" })!("legacy", signal());
    expect(bodies[3].max_tokens).toBe(12);
    mock.mockImplementation(async () => Response.json({ choices: [{ message: { content: "x".repeat(1025) } }] }));
    expect(await classifier("large", signal())).toBe("");
    mock.mockImplementation(async () => new Response("x".repeat(16_385)));
    await expect(classifier("huge", signal())).rejects.toThrow("limit");
  } finally { mock.mockRestore(); }
});

test("classifier failures log only a debug duration, never provider text", async () => {
  const previous = process.env.CICERO_DEBUG;
  const output: string[] = [];
  const mock = spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  try {
    process.env.CICERO_DEBUG = "1";
    await classifySwitchboardIntent(async () => { throw new Error("synthetic-secret-provider-body"); }, "synthetic-private-utterance", roster, signal());
    expect(output.join("\n")).toMatch(/intent timeout\/error after \d+ms/);
    expect(output.join("\n")).not.toContain("synthetic-secret");
    expect(output.join("\n")).not.toContain("synthetic-private");
    delete process.env.CICERO_DEBUG;
    output.length = 0;
    await classifySwitchboardIntent(async () => { throw new Error("synthetic-secret"); }, "hi", roster, signal());
    expect(output).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.CICERO_DEBUG;
    else process.env.CICERO_DEBUG = previous;
    mock.mockRestore();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

test("concurrent action discards held text and notices, aborts the brain, then acts", async () => {
  const verdict = deferred<string>();
  const started = deferred<void>();
  let owned: AbortSignal | undefined;
  let closed = false;
  const notices: string[] = [];
  const brain: Brain = {
    ...front(), canHoldIntentOutput: () => true,
    sendStream: async function* (_m, options) {
      owned = options?.signal;
      options?.onNotice?.({ type: "tool", text: "must not be spoken" });
      started.resolve();
      try { yield "private draft that must never reach the speaker"; }
      finally { closed = true; }
    },
  };
  const sb = new SwitchboardBrain(brain, { coder: { brain: front() } }, () => verdict.promise);
  const iterator = sb.sendStream("gather the gang", { onNotice: (n) => notices.push(n.text) })[Symbol.asyncIterator]();
  let delivered = false;
  const output = iterator.next().then((value) => { delivered = true; return value; });
  await started.promise;
  await tick();
  expect(delivered).toBe(false);
  expect(notices).toEqual([]);
  verdict.resolve(json());
  expect((await output).value).toContain("checking in");
  expect(owned?.aborted).toBe(true);
  expect(closed).toBe(true);
  expect(notices).toEqual([]);
  await iterator.return?.();
});

test("none releases held output in order without restarting the normal turn", async () => {
  const verdict = deferred<string>();
  const started = deferred<void>();
  let invocations = 0;
  const chunks = ["A".repeat(45), "second", "third"];
  const brain: Brain = { ...front(), canHoldIntentOutput: () => true,
    sendStream: async function* () { invocations++; started.resolve(); yield* chunks; },
  };
  const sb = new SwitchboardBrain(brain, {}, () => verdict.promise);
  const out: string[] = [], held: number[] = [];
  const running = (async () => { for await (const c of sb.sendStream("ordinary words", { onIntentHeldMs: (ms) => held.push(ms) })) out.push(c); })();
  await started.promise;
  await tick();
  expect(out).toEqual([]);
  verdict.resolve(json({ intent: "none", request_now: false }));
  await running;
  expect(out).toEqual(chunks);
  expect(invocations).toBe(1);
  expect(held).toHaveLength(1);
  expect(held[0]).toBeGreaterThanOrEqual(0);
});

test("slow classifier holds fast brain output until deadline, then lets it flow", async () => {
  let classifierSignal: AbortSignal | undefined;
  const started = deferred<void>();
  const brain: Brain = { ...front(), canHoldIntentOutput: () => true,
    send: async () => { started.resolve(); return "normal turn"; },
  };
  const sb = new SwitchboardBrain(brain, {}, (_p, s) => { classifierSignal = s; return new Promise(() => {}); }, { intentTimeoutMs: 25 });
  let delivered = false;
  const held: number[] = [];
  const pending = sb.send("ordinary words", { onIntentHeldMs: (ms) => held.push(ms) }).then((v) => { delivered = true; return v; });
  await started.promise;
  await tick();
  expect(delivered).toBe(false);
  expect(await pending).toBe("normal turn");
  expect(classifierSignal?.aborted).toBe(true);
  expect(held[0]).toBeGreaterThan(0);
});

test("a brain without a safe-hold capability classifies before executing", async () => {
  const verdict = deferred<string>();
  let invocations = 0;
  const brain: Brain = { ...front(), send: async () => { invocations++; return "normal"; } };
  const sb = new SwitchboardBrain(brain, {}, () => verdict.promise);
  const pending = sb.send("ordinary words");
  await tick();
  expect(invocations).toBe(0);
  verdict.resolve(json({ intent: "none" }));
  expect(await pending).toBe("normal");
  expect(invocations).toBe(1);
});

test("classifier finishes before the brain: no output hold time", async () => {
  const output = deferred<string>();
  const brain: Brain = { ...front(), canHoldIntentOutput: () => true, send: () => output.promise };
  const held: number[] = [];
  const sb = new SwitchboardBrain(brain, {}, async () => json({ intent: "none" }));
  const pending = sb.send("ordinary words", { onIntentHeldMs: (ms) => held.push(ms) });
  await tick();
  expect(held).toEqual([0]);
  output.resolve("normal");
  expect(await pending).toBe("normal");
});

test("timeout telemetry distinguishes the deadline from a provider error", async () => {
  const observed: any[] = [];
  await classifySwitchboardIntent(() => new Promise(() => {}), "hi", roster, signal(), 5, (a) => observed.push(a));
  await classifySwitchboardIntent(async () => { throw new Error("failed"); }, "hi", roster, signal(), 50, (a) => observed.push(a));
  expect(observed[0]).toMatchObject({ timedOut: true, failed: false });
  expect(observed[1]).toMatchObject({ timedOut: false, failed: true });
});

test("discarded uncooperative brain is quarantined, then retryable after settlement", async () => {
  const late = deferred<string>();
  let count = 0;
  const brain: Brain = { ...front(), canHoldIntentOutput: () => true,
    send: () => { count++; return count === 1 ? late.promise : Promise.resolve("recovered"); },
  };
  let verdicts = 0;
  const sb = new SwitchboardBrain(brain, { coder: { brain: front() } }, async () => json({ intent: verdicts++ === 0 ? "rollcall" : "none" }), { intentDrainTimeoutMs: 10 });
  expect(await sb.send("gather the gang")).toContain("checking in");
  // The control did not dispatch to the retiring brain; ordinary work does.
  await expect(sb.send("ordinary work while retiring")).rejects.toThrow("still settling");
  expect(count).toBe(1);
  late.resolve("discarded late text");
  await tick();
  expect(await sb.send("ordinary words")).toBe("recovered");
  expect(count).toBe(2);
});

test("caller cancellation cancels the held brain and never releases its notices", async () => {
  const started = deferred<void>();
  let owned: AbortSignal | undefined;
  const controller = new AbortController();
  const notices: string[] = [];
  const brain: Brain = { ...front(), canHoldIntentOutput: () => true,
    send: async (_m, options) => {
      owned = options?.signal;
      options?.onNotice?.({ type: "tool", text: "held" });
      started.resolve();
      return "draft";
    },
  };
  const sb = new SwitchboardBrain(brain, {}, () => new Promise(() => {}));
  const result = sb.send("ordinary words", { signal: controller.signal, onNotice: (n) => notices.push(n.text) });
  await started.promise;
  controller.abort(new Error("cancelled by caller"));
  await expect(result).rejects.toThrow("cancelled by caller");
  expect(owned?.aborted).toBe(true);
  expect(notices).toEqual([]);
});

test("held first output has a hard size bound", async () => {
  const brain: Brain = { ...front(), canHoldIntentOutput: () => true, send: async () => "x".repeat(65537) };
  const sb = new SwitchboardBrain(brain, {}, async () => json({ intent: "none" }));
  await expect(sb.send("ordinary words")).rejects.toThrow("held intent output exceeds limit");
});
