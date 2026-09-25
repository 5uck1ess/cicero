import { expect, test } from "bun:test";
import { planSwitchboardIntent, SwitchboardBrain } from "../../src/brain/switchboard";
import type { SwitchboardIntent } from "../../src/brain/switchboard-intent";
import type { Brain } from "../../src/types";

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

const brain = (): Brain => ({
  start: async () => {}, stop: async () => {}, restart: async () => {}, health: async () => true,
  injectContext: () => {}, send: async () => "ordinary response",
});

for (const mode of ["send", "sendStream", "streamProgress"] as const) {
  for (const scenario of [
    { name: "none", result: intent("none"), lanes: true },
    { name: "release with no pin", result: intent("release"), lanes: true },
    { name: "unknown transfer", result: intent("transfer", "unknown"), lanes: true },
    { name: "already-pinned transfer", result: intent("transfer", "coder"), lanes: true, pin: true },
    { name: "unavailable callme", result: intent("callme"), lanes: true },
    { name: "rollcall without lanes", result: intent("rollcall"), lanes: false },
    { name: "standup without lanes", result: intent("standup"), lanes: false },
  ]) {
    test(`${mode}: classify first, then ${scenario.name} dispatches exactly once`, async () => {
      const verdict = deferred<string>();
      let calls = 0;
      const destination: Brain = {
        ...brain(), send: async () => { calls++; return "ordinary response"; },
        sendStream: async function* () { calls++; yield "ordinary "; yield "response"; },
        streamProgress: async function* () { calls++; yield "ordinary "; yield "response"; },
      };
      const sb = new SwitchboardBrain(destination, scenario.lanes ? { coder: { brain: destination } } : {}, () => verdict.promise);
      if (scenario.pin) await sb.transferTo("coder");
      const published: string[] = [];
      const task = mode === "send" ? sb.send("a synthetic routing request").then((s) => { published.push(s); })
        : (async () => { for await (const s of sb[mode]!("a synthetic routing request")) published.push(s); })();
      await flush();
      expect(calls).toBe(0);
      expect(published).toEqual([]);
      verdict.resolve(JSON.stringify(scenario.result));
      await task;
      expect(calls).toBe(1);
      expect(published.join("")).toBe("ordinary response");
    });
  }
}

for (const action of ["release", "rollcall", "standup", "transfer", "callme"] as const) {
  test(`${action}: actionable classification never dispatches the ordinary message`, async () => {
    const verdict = deferred<string>();
    const messages: string[] = [];
    const destination: Brain = { ...brain(), send: async (m) => { messages.push(m); return "status"; } };
    const sb = new SwitchboardBrain(destination, { coder: { brain: destination } }, () => verdict.promise);
    if (action === "release") await sb.transferTo("coder");
    if (action === "callme") sb.setCallMeHandler(async () => "calling");
    const task = sb.send("a synthetic routing request");
    await flush();
    expect(messages).toEqual([]);
    verdict.resolve(JSON.stringify(intent(action, action === "transfer" ? "coder" : null)));
    await task;
    expect(messages).toEqual([]); // standup's cold lane is reported without starting it
    expect(sb.wasControlTurn()).toBe(true);
  });
}

test("cancelled background work never dispatches to the front desk or an already-warm lane", async () => {
  let calls = 0;
  const destination = { ...brain(), send: async () => { calls++; return "wrong"; } };
  const sb = new SwitchboardBrain(destination, { coder: { brain: destination } });
  await sb.transferTo("coder");
  const controller = new AbortController();
  controller.abort(new Error("cancelled background work"));
  await expect(sb.sendBackground("work", { lane: "coder", signal: controller.signal })).rejects.toThrow("cancelled background work");
  await expect(sb.sendBackground("work", { signal: controller.signal })).rejects.toThrow("cancelled background work");
  expect(calls).toBe(0);
});
