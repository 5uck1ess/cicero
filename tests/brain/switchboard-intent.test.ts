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


for (const failure of ["timeout", "error"] as const) {
  test(`${failure} dispatches one ordinary turn; a late verdict cannot act`, async () => {
    const pending = deferred<string>();
    let calls = 0;
    const brain: Brain = { ...front(), send: async () => { calls++; return "normal turn"; } };
    const sb = new SwitchboardBrain(brain, { coder: { brain: front() } },
      failure === "error" ? async () => { throw new Error("synthetic failure"); } : () => pending.promise,
      { intentTimeoutMs: 5 });
    expect(await sb.send("gather the gang")).toBe("normal turn");
    pending.resolve(json());
    await tick();
    expect(calls).toBe(1);
    expect(sb.wasControlTurn()).toBe(false);
  });
}

for (const mode of ["send", "sendStream", "streamProgress"] as const) {
  for (const action of ["rollcall", "release", "transfer"] as const) {
    test(`${mode}: superseded classification cannot execute a late actionable ${action}`, async () => {
      const pending = deferred<string>();
      const entered = deferred<void>();
      const returned = deferred<string>();
      let classifications = 0;
      const messages: string[] = [];
      const published: string[] = [];
      const brain: Brain = {
        ...front(), send: async (m) => { messages.push(m); return "fresh answer"; },
        streamProgress: async function* (m) { messages.push(m); yield "fresh answer"; },
      };
      const lanes = { coder: { brain, voice: "coder-voice" }, reviewer: { brain: front(), voice: "reviewer-voice" } };
      const sb = new SwitchboardBrain(brain, lanes, async () => {
        if (++classifications === 1) {
          entered.resolve();
          const raw = await pending.promise;
          returned.resolve(raw); // evidence that the provider actually returned the actionable verdict
          return raw;
        }
        return json({ intent: "none", request_now: false });
      });
      await sb.transferTo("coder"); // release must have something to release; transfer must change lanes
      const state = sb as unknown as {
        rollcall: unknown;
        actOnIntent: (...args: any[]) => Promise<unknown>;
        doRollcall: (...args: any[]) => unknown;
        doRelease: (...args: any[]) => unknown;
        pinLane: (...args: any[]) => Promise<unknown>;
      };
      // Call-through spies: retain every downstream guard. Side-effect assertions
      // alone could pass even if stale work reached these guarded action handlers.
      const act = spyOn(state, "actOnIntent");
      const rollcall = spyOn(state, "doRollcall");
      const release = spyOn(state, "doRelease");
      const transfer = spyOn(state, "pinLane");
      try {
        const old = (mode === "send" ? sb.send("old ordinary request").then((s) => { published.push(s); })
          : (async () => { for await (const s of sb[mode]!("old ordinary request")) published.push(s); })())
          .then(() => null, (error) => error);
        await entered.promise;
        expect(messages).toEqual([]);
        expect(await sb.send("new ordinary request")).toBe("fresh answer");
        // Resolve BEFORE awaiting old: otherwise disabling cancellation lets the
        // classifier deadline win, silently testing NONE instead of this action.
        const late = json({ intent: action, target: action === "transfer" ? "reviewer" : null });
        pending.resolve(late);
        expect(parseIntent(await returned.promise, lanes)).toMatchObject({
          intent: action, target: action === "transfer" ? "reviewer" : null,
          request_now: true, confidence: 0.9,
        });
        expect(await old).toBeInstanceOf(Error);
        await tick();
        expect(messages).toEqual(["new ordinary request"]);
        expect(published).toEqual([]); // no stale roster reply or acknowledgment
        expect(sb.activeLane()).toBe("coder"); // no transfer or release
        expect(state.rollcall).toBeNull(); // inspect without consuming a queued voice
        expect(sb.activeLaneVoice()).toBe("coder-voice");
        expect(sb.wasControlTurn()).toBe(false);
        expect(act).not.toHaveBeenCalled();
        expect(rollcall).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(transfer).not.toHaveBeenCalled();
      } finally {
        act.mockRestore(); rollcall.mockRestore(); release.mockRestore(); transfer.mockRestore();
      }
    });
  }
}
