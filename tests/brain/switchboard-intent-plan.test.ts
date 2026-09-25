import { expect, test } from "bun:test";
import { planSwitchboardIntent, SwitchboardBrain } from "../../src/brain/switchboard";
import type { SwitchboardIntent } from "../../src/brain/switchboard-intent";
import type { Brain, BrainTurnOptions } from "../../src/types";

const intent = (name: SwitchboardIntent["intent"], target: string | null = null): SwitchboardIntent =>
  ({ intent: name, target, request_now: true, confidence: 0.95 });
const state = {
  activeLane: null, hasPendingTransfer: false, lanes: ["coder"],
  unavailableTargets: new Set<string>(), canCall: true, minConfidence: 0.7,
};
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// State-only planning must not probe, start, cancel or otherwise invoke a provider.
test("intent x state plans distinguish concrete actions from fallthrough", () => {
  const cases: Array<[SwitchboardIntent, Partial<Parameters<typeof planSwitchboardIntent>[1]>, "act" | "fallthrough"]> = [
    [intent("none"), {}, "fallthrough"],
    [{ ...intent("rollcall"), request_now: false }, {}, "fallthrough"],
    [{ ...intent("rollcall"), confidence: 0.69 }, {}, "fallthrough"],
    [intent("release"), {}, "fallthrough"],
    [intent("release"), { activeLane: "coder" }, "act"],
    [intent("release"), { hasPendingTransfer: true }, "act"],
    [intent("transfer", "missing"), {}, "fallthrough"],
    [intent("transfer"), {}, "fallthrough"],
    [intent("transfer", "coder"), { activeLane: "coder" }, "fallthrough"],
    [intent("transfer", "coder"), { unavailableTargets: new Set(["coder"]) }, "fallthrough"],
    [intent("transfer", "coder"), {}, "act"],
    [intent("callme"), { canCall: false }, "fallthrough"],
    [intent("callme"), {}, "act"],
    [intent("callme", "coder"), {}, "act"],
    [intent("rollcall"), { lanes: [] }, "fallthrough"],
    [intent("standup"), { lanes: [] }, "fallthrough"],
    [intent("rollcall"), {}, "act"],
    [intent("standup"), {}, "act"],
  ];
  for (const [result, overrides, kind] of cases) {
    expect(planSwitchboardIntent(result, { ...state, ...overrides }).kind).toBe(kind);
  }
});

for (const mode of ["send", "sendStream", "streamProgress"] as const) {
  for (const scenario of [
    { name: "release with no pin or pending transfer", result: intent("release"), lanes: true },
    { name: "unknown transfer target", result: intent("transfer", "unknown"), lanes: true },
    { name: "already-pinned transfer target", result: intent("transfer", "coder"), lanes: true, pin: true },
    { name: "callme without handler", result: intent("callme"), lanes: true },
    { name: "rollcall without lanes", result: intent("rollcall"), lanes: false },
    { name: "standup without lanes", result: intent("standup"), lanes: false },
  ]) {
    test(`${mode}: ${scenario.name} adopts one unsettled provider turn`, async () => {
      const verdict = deferred<string>(), output = deferred<string>(), started = deferred<void>();
      let calls = 0;
      let ownedSignal: AbortSignal | undefined;
      const send = async (_message: string, options?: BrainTurnOptions): Promise<string> => {
        calls++;
        ownedSignal = options?.signal;
        started.resolve();
        return output.promise;
      };
      const stream = async function* (message: string, options?: BrainTurnOptions) { yield await send(message, options); };
      const brain: Brain = {
        start: async () => {}, stop: async () => {}, restart: async () => {}, health: async () => true,
        injectContext: () => {}, canHoldIntentOutput: () => true,
        send, sendStream: stream, streamProgress: stream,
      };
      const sb = new SwitchboardBrain(brain, scenario.lanes ? { coder: { brain } } : {}, () => verdict.promise);
      if (scenario.pin) await sb.transferTo("coder");
      const message = "I'm finished talking to the coder"; // classifier fallback, no exact command
      const reply = mode === "send" ? sb.send(message) : Array.fromAsync(sb[mode]!(message)).then((parts) => parts.join(""));
      // Observe failure immediately so a regression cannot cause an unhandled rejection.
      const settled = reply.then((value) => ({ value }), (error) => ({ error }));
      await started.promise;
      verdict.resolve(JSON.stringify(scenario.result));
      await flush();
      expect(calls).toBe(1);
      expect(ownedSignal?.aborted).toBe(false);
      output.resolve("ordinary output from the single provider turn");
      expect(await settled).toEqual({ value: "ordinary output from the single provider turn" });
      expect(calls).toBe(1);
      expect(sb.wasControlTurn()).toBe(false);
    });
  }
}

test("transfer to a known retiring target adopts the held front-desk output", async () => {
  let frontCalls = 0, laneCalls = 0;
  let frontSignal: AbortSignal | undefined;
  let verdict = intent("none");
  const output = deferred<string>();
  let holdOutput = false;
  const front: Brain = {
    start: async () => {}, stop: async () => {}, restart: async () => {}, health: async () => true,
    injectContext: () => {}, canHoldIntentOutput: () => true,
    send: async (_m, options) => { frontCalls++; frontSignal = options?.signal; return holdOutput ? output.promise : "front response"; },
  };
  const lane: Brain = { ...front, send: () => { laneCalls++; return new Promise(() => {}); } };
  const sb = new SwitchboardBrain(front, { coder: { brain: lane } }, async () => JSON.stringify(verdict));
  await sb.transferTo("coder");
  const old = sb.send("ordinary work").catch((error) => error);
  await flush();
  expect(laneCalls).toBe(1);
  expect(await sb.send("back to Cicero")).toBe("Back with you.");
  expect(await old).toBeInstanceOf(Error);
  await sb.send("ordinary work after returning"); // consume the release memo
  frontCalls = 0;
  holdOutput = true;
  verdict = intent("transfer", "coder");
  const reply = sb.send("I'd like our other colleague's ear");
  await flush();
  expect(frontCalls).toBe(1);
  expect(frontSignal?.aborted).toBe(false);
  output.resolve("ordinary held front response");
  expect(await reply).toBe("ordinary held front response");
  expect(frontCalls).toBe(1);
  expect(laneCalls).toBe(1);
  expect(sb.activeLane()).toBeNull();
});

test("an available cold transfer still acts; later startup failure is not redispatched", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const front: Brain = {
    start: async () => {}, stop: async () => {}, restart: async () => {}, health: async () => true,
    injectContext: () => {}, canHoldIntentOutput: () => true,
    send: async (_m, options) => { calls++; signal = options?.signal; return "discard this draft"; },
  };
  const lane: Brain = { ...front, start: async () => { throw new Error("synthetic start failure"); } };
  const sb = new SwitchboardBrain(front, { coder: { brain: lane } }, async () => JSON.stringify(intent("transfer", "coder")));
  expect(await sb.send("I'd like our other colleague's ear")).toContain("couldn't reach coder");
  expect(calls).toBe(1);
  expect(signal?.aborted).toBe(true);
  expect(sb.wasControlTurn()).toBe(true);
});

for (const action of ["release", "rollcall", "standup", "callme", "transfer"] as const) {
  test(`${action}: concrete plan discards the held draft and runs the action`, async () => {
    let calls = 0;
    let signal: AbortSignal | undefined;
    const base: Brain = {
      start: async () => {}, stop: async () => {}, restart: async () => {}, health: async () => true,
      injectContext: () => {}, send: async () => "lane response",
    };
    const actor: Brain = { ...base, canHoldIntentOutput: () => true,
      send: async (_m, options) => { calls++; signal = options?.signal; return "discarded draft"; },
    };
    const sb = new SwitchboardBrain(action === "release" ? base : actor, {
      coder: { brain: action === "release" ? actor : base },
    }, async () => JSON.stringify(intent(action, action === "transfer" ? "coder" : null)));
    if (action === "release") await sb.transferTo("coder");
    if (action === "callme") sb.setCallMeHandler(async () => "Ringing.");
    const reply = await sb.send("please handle this for me");
    const expected = {
      release: "Back with you.", rollcall: "checking in", standup: "Getting status from the team.",
      callme: "Ringing.", transfer: "Coder here.",
    }[action];
    expect(reply).toContain(expected);
    expect(reply).not.toContain("discarded draft");
    expect(calls).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(sb.wasControlTurn()).toBe(true);
  });
}
