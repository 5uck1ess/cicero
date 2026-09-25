import { afterEach, expect, jest, test } from "bun:test";
import { SwitchboardBrain } from "../../src/brain/switchboard";
import type { Brain, BrainTurnOptions } from "../../src/types";

const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const answer = (intent: string, target: string | null = null) => JSON.stringify({ intent, target, request_now: intent !== "none", confidence: 0.95 });
const fake = (): Brain => ({
  start: async () => {}, stop: async () => {}, restart: async () => {}, health: async () => true,
  injectContext: () => {}, send: async () => "healthy response",
});
afterEach(() => jest.useRealTimers());

async function setup(pinned = false) {
  jest.useFakeTimers();
  let calls = 0, classifications = 0;
  let options: BrainTurnOptions | undefined;
  let finish!: (text: string) => void;
  const never = new Promise<string>((resolve) => { finish = resolve; });
  const stuck: Brain = { ...fake(), canHoldIntentOutput: () => true, hasPendingOneShotContext: () => false,
    send: (_m, opts) => { calls++; options = opts; return never; },
  };
  const healthy = fake();
  let healthyCalls = 0;
  healthy.send = async () => { healthyCalls++; return "working fine"; };
  let verdict = answer("none");
  const sb = new SwitchboardBrain(pinned ? fake() : stuck, {
    healthy: { brain: healthy }, ...(pinned ? { stuck: { brain: stuck } } : {}),
  }, async () => { classifications++; return verdict; }, { intentDrainTimeoutMs: 25 });
  if (pinned) { await sb.transferTo("healthy"); await sb.transferTo("stuck"); }
  const notices: string[] = [];
  const old = sb.send("ordinary work", { onNotice: (n) => notices.push(n.text) }).catch((e: Error) => e);
  await flush();
  expect(calls).toBe(1);
  return {
    sb, old, healthy, finish, notices,
    calls: () => calls, healthyCalls: () => healthyCalls, classifications: () => classifications,
    oldOptions: () => options!, verdict: (intent: string, target: string | null = null) => { verdict = answer(intent, target); },
  };
}

// No timer advances: a board-wide settle wait cannot satisfy these assertions.
async function immediate<T>(task: Promise<T>): Promise<T> {
  let result: { value: T } | { error: unknown } | undefined;
  void task.then((value) => { result = { value }; }, (error) => { result = { error }; });
  await flush();
  expect(result).toBeDefined();
  if (!result) throw new Error("unexpected settle wait");
  if ("error" in result) throw result.error;
  return result.value;
}

for (const model of [false, true]) {
  test(`${model ? "model" : "exact"} rollcall bypasses an unrelated never-settling provider`, async () => {
    const h = await setup();
    h.verdict("rollcall");
    expect(await immediate(h.sb.send(model ? "gather the gang" : "roll call"))).toContain("checking in");
    expect(h.calls()).toBe(1);
    expect(h.oldOptions().signal?.aborted).toBe(true);
    expect(await h.old).toBeInstanceOf(Error);
    if (model) expect(h.classifications()).toBe(2);
  });

  test(`${model ? "model" : "exact"} standup answers while the front desk is retiring`, async () => {
    const h = await setup();
    h.verdict("standup");
    const response = await immediate(h.sb.send(model ? "what's the gang up to" : "standup"));
    expect(response).toContain("Getting status from the team.");
    expect(response).toContain("idle, no active session");
    expect(h.calls()).toBe(1);
  });

  test(`${model ? "model" : "exact"} release answers while the pinned lane is retiring`, async () => {
    const h = await setup(true);
    h.verdict("release");
    expect(await immediate(h.sb.send(model ? "I'm finished with this colleague" : "back to Cicero"))).toBe("Back with you.");
    expect(h.sb.activeLane()).toBeNull();
    expect(h.calls()).toBe(1);
  });

  test(`${model ? "model" : "exact"} transfer can select an unrelated target`, async () => {
    const h = await setup();
    h.verdict("transfer", "healthy");
    expect(await immediate(h.sb.send(model ? "I need our other colleague" : "talk to healthy"))).toBe("Healthy here.");
    expect(h.sb.activeLane()).toBe("healthy");
    expect(h.calls()).toBe(1);
  });

  test(`${model ? "model" : "exact"} callme does not reuse the retiring brain`, async () => {
    const h = await setup();
    h.verdict("callme");
    h.sb.setCallMeHandler(async () => "Ringing.");
    expect(await immediate(h.sb.send(model ? "reach me on my handset" : "call me"))).toBe("Ringing.");
    expect(h.calls()).toBe(1);
  });
}

test("normal routing waits only for its destination and retains the retry error", async () => {
  const h = await setup();
  let result: unknown;
  void h.sb.send("more ordinary work").catch((error) => { result = error; });
  await flush();
  expect(result).toBeUndefined();
  expect(h.classifications()).toBe(2); // classification itself is not quarantined
  expect(h.calls()).toBe(1); // no new speculative dispatch
  jest.advanceTimersByTime(25);
  await flush();
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toContain("still settling; retry");
});

test("standup acknowledges immediately and isolates a retiring started lane", async () => {
  const h = await setup(true);
  const iterator = h.sb.sendStream("standup")[Symbol.asyncIterator]();
  expect((await immediate(iterator.next())).value).toBe("Getting status from the team.");
  expect((await immediate(iterator.next())).value).toContain("Healthy: working fine");
  let result: IteratorResult<string> | undefined;
  void iterator.next().then((next) => { result = next; });
  await flush();
  expect(result).toBeUndefined();
  expect(h.calls()).toBe(1);
  expect(h.healthyCalls()).toBe(1);
  jest.advanceTimersByTime(25);
  await flush();
  expect(result?.value).toContain("Stuck: didn't answer");
  await iterator.return?.();
});

test("voicemail and transfer briefing wait only for the target they mutate", async () => {
  const h = await setup(true);
  expect(await immediate(h.sb.send("leave a message for healthy: hello"))).toContain("pass that along");
  // A warm pin without a briefing is a canned reply; no provider dispatch.
  expect(await immediate(h.sb.send("talk to stuck"))).toBe("Stuck here.");
  let error: unknown;
  void h.sb.transferTo("stuck", async () => "new briefing").catch((e) => { error = e; });
  await flush();
  expect(error).toBeUndefined();
  jest.advanceTimersByTime(25);
  await flush();
  expect((error as Error).message).toContain("still settling; retry");
  error = undefined;
  void h.sb.send("leave a message for stuck: hello").catch((e) => { error = e; });
  await flush();
  jest.advanceTimersByTime(25);
  await flush();
  expect((error as Error).message).toContain("still settling; retry");
});

test("late discarded output and notices cannot enter an immediate control reply", async () => {
  const h = await setup();
  const reply = await immediate(h.sb.send("roll call"));
  h.oldOptions().onNotice?.({ type: "tool", text: "stale notice" });
  h.finish("stale output");
  await flush();
  expect(reply).not.toContain("stale");
  expect(h.notices).toEqual([]);
  expect(await h.old).toBeInstanceOf(Error);
});

test("release lets ordinary work dispatch to the healthy front desk", async () => {
  const h = await setup(true);
  expect(await immediate(h.sb.send("back to Cicero"))).toBe("Back with you.");
  expect(await immediate(h.sb.send("new ordinary work"))).toBe("healthy response");
  expect(h.calls()).toBe(1);
});

test("named callme guards only the provider its handler actually briefs", async () => {
  const h = await setup(true);
  const rang: string[] = [];
  h.sb.setCallMeHandler(async (who, options) => {
    await h.sb.transferTo(who!, async () => "dial-back context", options);
    rang.push(who!);
    return "Ringing.";
  });
  expect(await immediate(h.sb.send("have healthy call me"))).toBe("Ringing.");
  expect(rang).toEqual(["healthy"]);
  let error: unknown;
  void h.sb.send("have stuck call me").catch((e) => { error = e; });
  await flush();
  expect(error).toBeUndefined();
  jest.advanceTimersByTime(25);
  await flush();
  expect((error as Error).message).toContain("still settling; retry");
  expect(rang).toEqual(["healthy"]);
});

test("background dispatch cannot bypass the destination quarantine", async () => {
  const h = await setup(true);
  await immediate(h.sb.send("roll call"));
  expect(await immediate(h.sb.sendBackground("background task", { lane: "healthy" }))).toBe("working fine");
  let error: unknown;
  void h.sb.sendBackground("background task", { lane: "stuck" }).catch((e) => { error = e; });
  await flush();
  expect(error).toBeUndefined();
  jest.advanceTimersByTime(25);
  await flush();
  expect((error as Error).message).toContain("still settling; retry");
  expect(h.calls()).toBe(1);
});
