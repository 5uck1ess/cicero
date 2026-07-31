import { test, expect } from "bun:test";
import { SwitchboardBrain, type LaneDef } from "../../src/brain/switchboard";
import { SpeculativeSideEffectError } from "../../src/brain/dial-back";
import type { Brain, BrainTurnOptions } from "../../src/types";

const NONCE_A = "11111111-1111-4111-8111-111111111111";
const NONCE_B = "22222222-2222-4222-8222-222222222222";

function fakeBrain(name: string, calls: string[], opts: { failStart?: boolean } = {}): Brain {
  return {
    start: async () => { if (opts.failStart) throw new Error(`${name} down`); calls.push(`${name}:start`); },
    stop: async () => { calls.push(`${name}:stop`); },
    send: async (m: string) => { calls.push(`${name}:send:${m}`); return `${name} reply`; },
    injectContext: () => { /* not exercised */ },
    restart: async () => { calls.push(`${name}:restart`); },
    health: async () => true,
  };
}

function confirmBrain(calls: string[], pending = true, nonce = NONCE_A): Brain {
  return {
    start: async () => {}, stop: async () => {}, restart: async () => {},
    health: async () => true, injectContext: () => {},
    send: async (m: string) => { calls.push(`send:${m}`); return `brain: ${m}`; },
    hasPendingConfirmation: () => pending,
    pendingConfirmations: () => pending ? [{ nonce, summary: "guarded operation" }] : [],
    resolvePendingConfirmation: (approved: boolean, suppliedNonce: string) => {
      if (!pending || suppliedNonce !== nonce) return false;
      pending = false;
      calls.push(approved ? "approved" : "cancelled");
      return true;
    },
  };
}

function board(calls: string[], laneOpts: Partial<Record<string, Partial<LaneDef> & { failStart?: boolean }>> = {}) {
  const lanes: Record<string, LaneDef> = {
    coder: { brain: fakeBrain("coder", calls, { failStart: laneOpts.coder?.failStart }), aliases: ["the coder", "code guy"], voice: "am_michael", ...laneOpts.coder },
    think: { brain: fakeBrain("think", calls), voice: "bm_george", greeting: "Thinking cap on." },
  };
  return new SwitchboardBrain(fakeBrain("front", calls), lanes);
}

function settlesWithin<T>(promise: PromiseLike<T>, label: string, timeoutMs = 100): Promise<T> {
  return Promise.race([
    Promise.resolve(promise),
    Bun.sleep(timeoutMs).then(() => { throw new Error(`${label} did not settle`); }),
  ]);
}

test("unpinned turns go to the front desk; lanes stay cold", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  expect(await sb.send("what's the weather")).toBe("front reply");
  expect(calls).not.toContain("coder:start");
  expect(sb.activeLane()).toBeNull();
  expect(sb.activeLaneVoice()).toBeUndefined();
});

test("one-shot context follows a control-plane transfer to the brain that receives the real turn", async () => {
  const calls: string[] = [];
  const injected = { front: [] as string[], coder: [] as string[] };
  const front = { ...fakeBrain("front", calls), injectContext: (context: string) => injected.front.push(context) };
  const coder = { ...fakeBrain("coder", calls), injectContext: (context: string) => injected.coder.push(context) };
  const sb = new SwitchboardBrain(front, { coder: { brain: coder } });

  try {
    await sb.start();
    sb.injectContext("latest command output");
    await sb.send("switch to coder");
    expect(injected.front).toEqual([]);
    expect(injected.coder).toEqual([]);

    await sb.send("continue");
    expect(injected.coder).toEqual(["latest command output"]);
    await sb.send("one more");
    expect(injected.coder).toEqual(["latest command output"]);
  } finally {
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("bare yes/no relays directly into a pending confirmation without a brain turn", async () => {
  for (const [utterance, ack, call] of [
    ["Yes.", "Approved.", "approved"],
    ["yeah", "Approved.", "approved"],
    ["go ahead", "Approved.", "approved"],
    ["do it", "Approved.", "approved"],
    ["approved", "Approved.", "approved"],
    ["No.", "Cancelled.", "cancelled"],
    ["nope", "Cancelled.", "cancelled"],
    ["don't", "Cancelled.", "cancelled"],
    ["cancel that", "Cancelled.", "cancelled"],
  ] as const) {
    const calls: string[] = [];
    const sb = new SwitchboardBrain(confirmBrain(calls), {});
    expect(await sb.send(utterance)).toBe(ack);
    expect(calls).toEqual([call]);
  }
});

test("bare yes with no pending confirmation falls through untouched", async () => {
  const calls: string[] = [];
  const sb = new SwitchboardBrain(confirmBrain(calls, false), {});
  expect(await sb.send("yes")).toBe("brain: yes");
  expect(calls).toEqual(["send:yes"]);
});

test("confirmation relay is whole-utterance only", async () => {
  for (const utterance of ["yes, tell me more", "yes, but do not do it", "please go ahead", "do it tomorrow", "no problem", "cancel that job later"]) {
    const calls: string[] = [];
    const sb = new SwitchboardBrain(confirmBrain(calls), {});
    expect(await sb.send(utterance)).toBe(`brain: ${utterance}`);
    expect(calls).toEqual([`send:${utterance}`]);
  }
});

test("a nonce resolves the originating lane even when another lane is current", async () => {
  const frontCalls: string[] = [];
  const coderCalls: string[] = [];
  const thinkCalls: string[] = [];
  const sb = new SwitchboardBrain(confirmBrain(frontCalls, false), {
    coder: { brain: confirmBrain(coderCalls, true, NONCE_A) },
    think: { brain: confirmBrain(thinkCalls, false, NONCE_B) },
  });
  await sb.start();
  await sb.send("talk to think");
  expect(sb.activeLane()).toBe("think");

  expect(sb.resolvePendingConfirmation(true, NONCE_A)).toBe(true);
  expect(coderCalls).toEqual(["approved"]);
  expect(thinkCalls).toEqual([]);
  expect(frontCalls).toEqual([]);
});

test("distinct lane capabilities cannot collide or resolve each other", () => {
  const frontCalls: string[] = [];
  const coderCalls: string[] = [];
  const sb = new SwitchboardBrain(confirmBrain(frontCalls, true, NONCE_A), {
    coder: { brain: confirmBrain(coderCalls, true, NONCE_B) },
  });

  expect(sb.pendingConfirmations().map((gate) => gate.nonce)).toEqual([NONCE_A, NONCE_B]);
  expect(sb.resolvePendingConfirmation(true, NONCE_B)).toBe(true);
  expect(coderCalls).toEqual(["approved"]);
  expect(frontCalls).toEqual([]);
  expect(sb.pendingConfirmations().map((gate) => gate.nonce)).toEqual([NONCE_A]);
  expect(sb.resolvePendingConfirmation(true, NONCE_B)).toBe(false); // replay
  expect(sb.resolvePendingConfirmation(true, crypto.randomUUID())).toBe(false);
});

test("an exact local affirmative approves one uniquely bound inactive-lane gate", async () => {
  const frontCalls: string[] = [];
  const coderCalls: string[] = [];
  const sb = new SwitchboardBrain(confirmBrain(frontCalls, false), {
    coder: { brain: confirmBrain(coderCalls, true, NONCE_A) },
  });

  expect(await sb.send("Yes.")).toBe("Approved.");
  expect(coderCalls).toEqual(["approved"]);
  expect(frontCalls).toEqual([]);
});

test("an unbound local affirmative fails closed when multiple gates are pending", async () => {
  const frontCalls: string[] = [];
  const coderCalls: string[] = [];
  const sb = new SwitchboardBrain(confirmBrain(frontCalls, true, NONCE_A), {
    coder: { brain: confirmBrain(coderCalls, true, NONCE_B) },
  });

  expect(await sb.send("yes")).toBe("I can't safely match that response. Use the matching approval request.");
  expect(frontCalls).toEqual([]);
  expect(coderCalls).toEqual([]);
  expect(sb.pendingConfirmations()).toHaveLength(2);
});

test("'let me talk to the coder' pins: lazy start, ack, voice override, sticky routing", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  expect(await sb.send("Let me talk to the coder.")).toBe("Coder here.");
  expect(calls).toContain("coder:start");
  expect(sb.activeLane()).toBe("coder");
  expect(sb.activeLaneVoice()).toBe("am_michael");
  // Subsequent turns stay on the lane — sticky.
  expect(await sb.send("how are the tests going?")).toBe("coder reply");
  expect(calls).toContain("coder:send:how are the tests going?");
});

test("'back to cicero' releases the pin and speaks in the default voice again", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  await sb.send("talk to the coder");
  expect(await sb.send("Thanks, back to you.")).toBe("Back with you.");
  expect(sb.activeLane()).toBeNull();
  expect(await sb.send("hello")).toBe("front reply");
});

test("aliases and custom greetings resolve; pin phrasing variants work", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  expect(await sb.send("put the code guy on the line")).toBe("Coder here.");
  await sb.send("back to cicero");
  expect(await sb.send("Switch me to think, please.")).toBe("Thinking cap on.");
});

test("unknown lane answers with the roster instead of confusing the agent", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  const reply = await sb.send("connect me to my manager");
  expect(reply).toContain("I don't have a line to");
  expect(reply).toContain("coder");
  expect(sb.activeLane()).toBeNull();
});

test("a lane that fails to start reports it and stays unpinned", async () => {
  const calls: string[] = [];
  const sb = board(calls, { coder: { failStart: true } });
  await sb.start();
  expect(await sb.send("talk to the coder")).toBe("I couldn't reach coder right now.");
  expect(sb.activeLane()).toBeNull();
  expect(await sb.send("hello")).toBe("front reply");
});

/** A lane whose start hangs until the returned release() is called. */
function coldLane(calls: string[], name = "worker") {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let starts = 0;
  const brain: Brain = {
    ...fakeBrain(name, calls),
    start: async () => { starts++; await gate; calls.push(`${name}:start`); },
  };
  return { brain, release: () => release(), startCount: () => starts };
}

test("a transfer talked over during a cold start is not silently dropped", async () => {
  // Forward guard for these review fixes: the PR already preserves a genuine
  // barge-in; cancellation ownership must not clear that intentional handoff.
  // Live incident 2026-07-30: "get Rick" started a 14-second ACP lane cold
  // start with no further speech to cover it. The user spoke into the silence,
  // that barge-in superseded the pending transfer, and the request evaporated —
  // the lane came up and sat there while every later turn went to the front
  // desk. The superseded turn must still reject (late work must never publish
  // into a newer turn), but the front desk must stop pretending it was never
  // asked.
  const calls: string[] = [];
  const cold = coldLane(calls);
  const sb = new SwitchboardBrain(fakeBrain("front", calls), { worker: { brain: cold.brain } });
  const transport = new AbortController();
  try {
    await sb.start();
    const transfer = sb.send("talk to the worker", { signal: transport.signal });
    void transfer.catch(() => { /* asserted below */ });
    await Bun.sleep(0);
    expect(cold.startCount()).toBe(1);

    // The web transport aborts the old same-socket turn before its drain loop
    // admits the queued successor. The dead turn still rejects and publishes
    // nothing; the successor owns the pending ask.
    transport.abort(new Error("superseded by a newer turn"));
    await expect(transfer).rejects.toThrow("superseded by a newer turn");
    expect(await settlesWithin(sb.send("hello?"), "barge-in"))
      .toBe("Still getting Worker on the line — one moment.");
    expect(sb.activeLane()).toBeNull(); // nothing pinned late by the dead turn

    cold.release();
    await Bun.sleep(0);
    // With the lane up, the NEXT turn completes the pin itself.
    expect(await settlesWithin(sb.send("you there?"), "pin")).toBe("Worker here.");
    expect(sb.activeLane()).toBe("worker");
    // Resolved once — a later turn is an ordinary lane turn, not another ack.
    expect(await sb.send("what's up")).toBe("worker reply");
  } finally {
    cold.release();
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("a push-to-talk barge-in keeps the pending cold transfer alive", async () => {
  // The browser's PTT interruption aborts the active turn BEFORE it has the
  // replacement audio to send (page.ts abortActiveTurn, then endPtt sends the
  // WAV), and the server records that as "turn aborted by client". abortTurn
  // fixes the reason on the FIRST abort, so the later same-socket supersession
  // can never overwrite it. This is an ordinary barge-in with the speaker still
  // on the line, so the transfer must survive it exactly as a queued-turn
  // supersession does — treating it as the conversation going away reinstates
  // the very incident this feature exists to fix.
  const calls: string[] = [];
  const cold = coldLane(calls);
  const sb = new SwitchboardBrain(fakeBrain("front", calls), { worker: { brain: cold.brain } });
  const transport = new AbortController();
  try {
    await sb.start();
    const transfer = sb.send("talk to the worker", { signal: transport.signal });
    void transfer.catch(() => { /* asserted below */ });
    await Bun.sleep(0);
    expect(cold.startCount()).toBe(1);

    transport.abort(new Error("turn aborted by client"));
    await expect(transfer).rejects.toThrow("turn aborted by client");
    expect(await settlesWithin(sb.send("hello?"), "barge-in"))
      .toBe("Still getting Worker on the line — one moment.");

    cold.release();
    await Bun.sleep(0);
    expect(await settlesWithin(sb.send("you there?"), "pin")).toBe("Worker here.");
    expect(sb.activeLane()).toBe("worker");
  } finally {
    cold.release();
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("a local-microphone barge-in keeps the pending cold transfer alive", async () => {
  // src/daemon.ts aborts the active local turn with a bare string rather than an
  // Error. Same contract as the browser barge-in, different reason shape — a
  // classifier that only understood Errors dropped every local transfer.
  // Literal, not a shared constant: the point is what the daemon really sends.
  const calls: string[] = [];
  const cold = coldLane(calls);
  const sb = new SwitchboardBrain(fakeBrain("front", calls), { worker: { brain: cold.brain } });
  const transport = new AbortController();
  try {
    await sb.start();
    const transfer = sb.send("talk to the worker", { signal: transport.signal });
    void transfer.catch(() => { /* asserted below */ });
    await Bun.sleep(0);
    expect(cold.startCount()).toBe(1);

    transport.abort("barge-in");
    await expect(transfer).rejects.toThrow();
    expect(await settlesWithin(sb.send("hello?"), "local barge-in"))
      .toBe("Still getting Worker on the line — one moment.");

    cold.release();
    await Bun.sleep(0);
    expect(await settlesWithin(sb.send("you there?"), "pin")).toBe("Worker here.");
    expect(sb.activeLane()).toBe("worker");
  } finally {
    cold.release();
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("an explicit local stop drops the transfer even though the reason says barge-in", async () => {
  // "stop" cancels the work in flight. The operator is still on the line, but
  // they asked for this to go away — the next thing they say must not be
  // steered into a lane they just cancelled. The abort reason cannot carry
  // that: the interrupt callback runs first and fixes it as "barge-in".
  const calls: string[] = [];
  const cold = coldLane(calls);
  const sb = new SwitchboardBrain(fakeBrain("front", calls), { worker: { brain: cold.brain } });
  const transport = new AbortController();
  try {
    await sb.start();
    const transfer = sb.send("talk to the worker", { signal: transport.signal });
    void transfer.catch(() => { /* asserted below */ });
    await Bun.sleep(0);
    expect(cold.startCount()).toBe(1);

    transport.abort("barge-in");
    await expect(transfer).rejects.toThrow();
    // A spoken "stop" reaches the daemon as a barge-in AND a stop command, in
    // that order, so the reason on the wire says "barge-in". The stop is
    // delivered out of band.
    sb.dropDeferredWork();

    cold.release();
    await Bun.sleep(0);
    expect(await sb.send("new conversation")).toBe("front reply");
    expect(sb.activeLane()).toBeNull();
  } finally {
    cold.release();
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("a cold transfer called off mid-start does not pin the lane it was starting", async () => {
  // Deactivating the microphone ends the conversation WITHOUT aborting the turn
  // that asked for the transfer, so the cold start runs to completion on a live
  // signal. Clearing the pending record alone did not stop it: it finished the
  // wait and pinned the lane seconds after everyone had left.
  const calls: string[] = [];
  const cold = coldLane(calls);
  const sb = new SwitchboardBrain(fakeBrain("front", calls), { worker: { brain: cold.brain } });
  try {
    await sb.start();
    const transfer = sb.send("talk to the worker");
    await Bun.sleep(0);
    expect(cold.startCount()).toBe(1);

    sb.dropDeferredWork();
    cold.release();

    expect(await transfer).toBe("Never mind worker then.");
    expect(sb.activeLane()).toBeNull();
    // ...and the conversation that follows starts at the front desk.
    expect(await sb.send("new conversation")).toBe("front reply");
    expect(sb.activeLane()).toBeNull();
  } finally {
    cold.release();
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("ending a conversation releases a deferred transfer that already pinned", async () => {
  // The microphone can go inactive while its last local turn still keeps the
  // conversation live. If the cold start pins during that turn, the eventual
  // conversation-end drop must release the pin too or the next conversation
  // bypasses the front desk and reaches the old worker.
  const calls: string[] = [];
  const cold = coldLane(calls);
  const sb = new SwitchboardBrain(fakeBrain("front", calls), { worker: { brain: cold.brain } });
  try {
    await sb.start();
    const transfer = sb.send("talk to the worker");
    await Bun.sleep(0);
    expect(cold.startCount()).toBe(1);

    cold.release();
    expect(await transfer).toBe("Worker here.");
    expect(sb.activeLane()).toBe("worker");

    sb.dropDeferredWork();

    expect(sb.activeLane()).toBeNull();
    expect(await sb.send("new conversation")).toBe("front reply");
    expect(calls).not.toContain("worker:send:new conversation");
  } finally {
    cold.release();
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("a cold transfer becomes sticky after its lane answers an ordinary turn", async () => {
  // The cold-start greeting only completes the transfer. Once the operator
  // actually talks to that lane and gets an answer, ending the conversation
  // must not discard a pin that is now indistinguishable from a warm transfer.
  const calls: string[] = [];
  const cold = coldLane(calls);
  const sb = new SwitchboardBrain(fakeBrain("front", calls), { worker: { brain: cold.brain } });
  try {
    await sb.start();
    const transfer = sb.send("talk to the worker");
    await Bun.sleep(0);
    cold.release();
    expect(await transfer).toBe("Worker here.");

    expect(await sb.send("help me with this")).toBe("worker reply");
    sb.dropDeferredWork();

    expect(sb.activeLane()).toBe("worker");
    expect(await sb.send("new conversation")).toBe("worker reply");
    expect(calls).toContain("worker:send:new conversation");
  } finally {
    cold.release();
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("ending a conversation leaves the front desk no memo about it", async () => {
  // Releasing a lane normally tells whoever answers next that the user came
  // back from a side conversation, and carries its last exchanges along. After
  // a conversation ends nobody came back, and that recap would be the finished
  // conversation's tail arriving inside an unrelated later one.
  const calls: string[] = [];
  const injected: string[] = [];
  const front = { ...fakeBrain("front", calls), injectContext: (context: string) => injected.push(context) };
  const cold = coldLane(calls);
  const sb = new SwitchboardBrain(front, { worker: { brain: cold.brain } });
  try {
    await sb.start();
    const transfer = sb.send("talk to the worker");
    await Bun.sleep(0);
    cold.release();
    expect(await transfer).toBe("Worker here.");

    sb.dropDeferredWork();
    expect(await sb.send("new conversation")).toBe("front reply");
    expect(injected.join("\n")).not.toContain("returned to the main line");
  } finally {
    cold.release();
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("ending a conversation clears its exchange before the next transfer", async () => {
  // A deferred pin can settle before the conversation-end notification arrives.
  // Releasing that pin clears its recap, but the handoff record must go too or
  // the next conversation's first transfer briefs a new lane on the old caller.
  const calls: string[] = [];
  const thinkContexts: string[] = [];
  const cold = coldLane(calls);
  const think = {
    ...fakeBrain("think", calls),
    injectContext: (context: string) => { thinkContexts.push(context); },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", calls), {
    worker: { brain: cold.brain },
    think: { brain: think },
  });
  try {
    await sb.start();
    expect(await sb.send("the old conversation's private detail")).toBe("front reply");
    const transfer = sb.send("talk to the worker");
    await Bun.sleep(0);
    cold.release();
    expect(await transfer).toBe("Worker here.");

    sb.dropDeferredWork();
    expect(await sb.send("talk to think")).toBe("Think here.");
    expect(thinkContexts.join("\n")).not.toContain("the old conversation's private detail");
  } finally {
    cold.release();
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("returning to the front desk preserves the exchange for a later transfer", async () => {
  // Returning to Cicero is still inside one conversation. The next lane should
  // receive the prior lane's exchange so the user does not have to repeat it.
  const calls: string[] = [];
  const thinkContexts: string[] = [];
  const coder = fakeBrain("coder", calls);
  const think = {
    ...fakeBrain("think", calls),
    injectContext: (context: string) => { thinkContexts.push(context); },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", calls), {
    coder: { brain: coder },
    think: { brain: think },
  });
  try {
    await sb.start();
    expect(await sb.send("talk to coder")).toBe("Coder here.");
    expect(await sb.send("keep this same-conversation detail")).toBe("coder reply");
    expect(await sb.send("back to Cicero")).toBe("Back with you.");

    expect(await sb.send("talk to think")).toBe("Think here.");
    expect(thinkContexts.join("\n")).toContain("keep this same-conversation detail");
  } finally {
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("ending a conversation does not release an ordinary explicit transfer", async () => {
  // A deliberate transfer to an already-started lane is the existing sticky
  // product behavior. Conversation cleanup must not mistake that live pin for
  // deferred work merely because both routes select the same employee.
  const calls: string[] = [];
  const sb = board(calls);
  try {
    await sb.start();
    await sb.send("talk to the coder");
    await sb.send("back to cicero");

    expect(await sb.send("talk to the coder")).toBe("Coder here.");
    expect(sb.activeLane()).toBe("coder");

    sb.dropDeferredWork();

    expect(sb.activeLane()).toBe("coder");
    expect(await sb.send("new conversation")).toBe("coder reply");
    expect(calls).toContain("coder:send:new conversation");
  } finally {
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("a cold transfer nobody called off still pins the lane", async () => {
  // The other direction: refusing a late pin must be tied to the drop, not
  // applied to every start that takes a while.
  const calls: string[] = [];
  const cold = coldLane(calls);
  const sb = new SwitchboardBrain(fakeBrain("front", calls), { worker: { brain: cold.brain } });
  try {
    await sb.start();
    const transfer = sb.send("talk to the worker");
    await Bun.sleep(0);
    expect(cold.startCount()).toBe(1);

    cold.release();

    expect(await transfer).toBe("Worker here.");
    expect(sb.activeLane()).toBe("worker");
  } finally {
    cold.release();
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("a transport-cancelled cold transfer does not steer a later conversation", async () => {
  const calls: string[] = [];
  const cold = coldLane(calls);
  const sb = new SwitchboardBrain(fakeBrain("front", calls), { worker: { brain: cold.brain } });
  const transport = new AbortController();
  try {
    await sb.start();
    const transfer = sb.send("talk to the worker", { signal: transport.signal });
    void transfer.catch(() => { /* asserted below */ });
    await Bun.sleep(0);
    expect(cold.startCount()).toBe(1);

    transport.abort(new Error("voice socket closed"));
    await expect(transfer).rejects.toThrow("voice socket closed");
    sb.dropDeferredWork();

    cold.release();
    await Bun.sleep(0);
    expect(await sb.send("new conversation")).toBe("front reply");
    expect(sb.activeLane()).toBeNull();
  } finally {
    cold.release();
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("a pending cold transfer that fails to start reports it instead of stalling", async () => {
  // The "still coming" ack must never outlive the start it describes, or the
  // user is told to hold for a lane that is never going to arrive.
  const calls: string[] = [];
  let failStart!: (e: Error) => void;
  const gate = new Promise<void>((_, reject) => { failStart = reject; });
  const sb = new SwitchboardBrain(fakeBrain("front", calls), {
    worker: { brain: { ...fakeBrain("worker", calls), start: () => gate } },
  });
  try {
    await sb.start();
    const transfer = sb.send("talk to the worker");
    void transfer.catch(() => { /* asserted below */ });
    await Bun.sleep(0);
    expect(await settlesWithin(sb.send("hello?"), "barge-in"))
      .toBe("Still getting Worker on the line — one moment.");
    await expect(transfer).rejects.toThrow("superseded by a newer accepted turn");

    failStart(new Error("worker down"));
    await Bun.sleep(0);
    expect(await settlesWithin(sb.send("you there?"), "failure ack"))
      .toBe("I couldn't reach worker right now.");
    expect(sb.activeLane()).toBeNull();
    expect(await sb.send("hello")).toBe("front reply"); // cleared, not sticky
  } finally {
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("'never mind' calls off a transfer that is still coming", async () => {
  // The hold must be cancellable, or it is the one state the user cannot exit.
  const calls: string[] = [];
  const cold = coldLane(calls);
  const sb = new SwitchboardBrain(fakeBrain("front", calls), { worker: { brain: cold.brain } });
  try {
    await sb.start();
    const transfer = sb.send("talk to the worker");
    void transfer.catch(() => { /* superseded below */ });
    await Bun.sleep(0);
    expect(await settlesWithin(sb.send("hello?"), "barge-in"))
      .toBe("Still getting Worker on the line — one moment.");
    await expect(transfer).rejects.toThrow("superseded by a newer accepted turn");

    expect(await settlesWithin(sb.send("never mind"), "cancel"))
      .toBe("Alright — I'll leave Worker out of it.");

    cold.release();
    await Bun.sleep(0);
    expect(await sb.send("you there?")).toBe("front reply"); // stays at the front desk
    expect(sb.activeLane()).toBeNull();
  } finally {
    cold.release();
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("'never mind' spoken to somebody on the line goes to them, not the switchboard", async () => {
  // "never mind" cancels a transfer that has not connected yet. Once the coder
  // has picked up it is something the user is saying TO the coder ("never mind,
  // I'll do it myself"), and hanging up on them instead loses the utterance.
  // Explicit release phrases still release.
  const calls: string[] = [];
  const sb = new SwitchboardBrain(fakeBrain("front", calls), {
    coder: { brain: fakeBrain("coder", calls) },
  });
  try {
    await sb.start();
    expect(await sb.send("talk to the coder")).toBe("Coder here.");
    expect(sb.activeLane()).toBe("coder");

    expect(await sb.send("never mind")).toBe("coder reply");
    expect(sb.activeLane()).toBe("coder");

    expect(await sb.send("that's all")).toBe("Back with you.");
    expect(sb.activeLane()).toBeNull();
  } finally {
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("'that's all' releases an active lane and cancels a pending cold transfer", async () => {
  const calls: string[] = [];
  const cold = coldLane(calls);
  const sb = new SwitchboardBrain(fakeBrain("front", calls), {
    coder: { brain: fakeBrain("coder", calls) },
    worker: { brain: cold.brain },
  });
  try {
    await sb.start();
    expect(await sb.send("talk to the coder")).toBe("Coder here.");

    const transfer = sb.send("talk to the worker");
    void transfer.catch(() => { /* asserted below */ });
    await Bun.sleep(0);
    expect(cold.startCount()).toBe(1);
    expect(sb.activeLane()).toBe("coder");

    expect(await settlesWithin(sb.send("that's all"), "release and cancel"))
      .toBe("Back with you — and I'll leave Worker out of it.");
    await expect(transfer).rejects.toThrow("superseded by a newer accepted turn");
    expect(sb.activeLane()).toBeNull();

    cold.release();
    await Bun.sleep(0);
    expect(await sb.send("new topic")).toBe("front reply");
    expect(sb.activeLane()).toBeNull();
  } finally {
    cold.release();
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("a newer transfer replaces a pending cold one — no stale lane arrives", async () => {
  // "get the worker… no, the coder" must not leave the worker queued to seize
  // the line the moment its slow start lands.
  const calls: string[] = [];
  const cold = coldLane(calls);
  const sb = new SwitchboardBrain(fakeBrain("front", calls), {
    worker: { brain: cold.brain },
    coder: { brain: fakeBrain("coder", calls) },
  });
  try {
    await sb.start();
    const transfer = sb.send("talk to the worker");
    void transfer.catch(() => { /* superseded below */ });
    await Bun.sleep(0);
    expect(await settlesWithin(sb.send("talk to the coder"), "second transfer")).toBe("Coder here.");
    expect(sb.activeLane()).toBe("coder");

    cold.release();
    await Bun.sleep(0);
    expect(await sb.send("still there?")).toBe("coder reply"); // coder keeps the line
    expect(sb.activeLane()).toBe("coder");
  } finally {
    cold.release();
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("'that's all' at the front desk is a normal turn, not a release ack", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  expect(await sb.send("that's all")).toBe("front reply");
});

test("sendStream yields the ack for switches and streams lane turns", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  const collect = async (m: string) => {
    let out = "";
    for await (const c of sb.sendStream(m)) out += c;
    return out;
  };
  expect(await collect("talk to the coder")).toBe("Coder here.");
  expect(await collect("status?")).toBe("coder reply"); // no sendStream on the fake — one-chunk fallback
});

test("stop stops the front desk and only the lanes that were started", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  await sb.send("talk to the coder");
  await sb.stop();
  expect(calls).toContain("front:stop");
  expect(calls).toContain("coder:stop");
  expect(calls).not.toContain("think:stop");
});

// ---------- natural / STT-decorated transfer phrasings (2026-07-06 live-call bug) ----------

test("natural phrasings pin: question forms, lead-ins, commas, please", async () => {
  const cases = [
    "Can you transfer me to the coder?",
    "I said, let me talk to the coder.",
    "Switch me to the coder?",
    "Could you connect me with the coder, please?",
    "Okay, put me through to the coder.",
    "I'd like to speak with the coder.",
    "Yeah, get me the coder please.",
  ];
  for (const c of cases) {
    const calls: string[] = [];
    const sb = board(calls);
    await sb.start();
    await sb.send(c);
    expect(sb.activeLane()).toBe("coder");
  }
});

test("natural release phrasings unpin", async () => {
  const cases = ["Okay, back to Cicero.", "Thanks, go back to Cicero please.", "Alright, switch back."];
  for (const c of cases) {
    const calls: string[] = [];
    const sb = board(calls);
    await sb.start();
    await sb.send("let me talk to the coder");
    await sb.send(c);
    expect(sb.activeLane()).toBeNull();
  }
});

test("conversational sentences still reach the brain, not the switchboard", async () => {
  const negatives = [
    "Can you talk to me about the weather?",
    "Tell the coder I said hi next time.",
    "We should talk to the customer tomorrow.",
    "Put the file in the repo.",
  ];
  for (const c of negatives) {
    const calls: string[] = [];
    const sb = board(calls);
    await sb.start();
    await sb.send(c);
    expect(sb.activeLane()).toBeNull();
  }
});

test("aliases written with a leading 'the' still resolve ('the thinker' bug)", async () => {
  const calls: string[] = [];
  const lanes: Record<string, LaneDef> = {
    think: { brain: fakeBrain("think", calls), aliases: ["the thinker", "deep thinker"] },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", calls), lanes);
  await sb.start();
  await sb.send("Let me talk to the thinker.");
  expect(sb.activeLane()).toBe("think");
});

test("persona is injected into the lane brain before its first start", async () => {
  const calls: string[] = [];
  const injected: string[] = [];
  const brain = { ...fakeBrain("coder", calls), injectContext: (c: string) => { injected.push(c); calls.push("coder:ctx"); } };
  const sb = new SwitchboardBrain(fakeBrain("front", calls), {
    coder: { brain, persona: "Speak as Tony Stark." },
  });
  await sb.start();
  await sb.send("let me talk to the coder");
  expect(injected).toEqual(["Speak as Tony Stark."]);
  expect(calls.indexOf("coder:ctx")).toBeLessThan(calls.indexOf("coder:start"));
  await sb.send("back to cicero");
  await sb.send("let me talk to the coder");
  expect(injected.length).toBe(1); // once per session, not per pin
});

test("loose verbs only transfer when the name resolves ('give me your opinion' bug)", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  await sb.send("get me the coder");                       // loose verb + real lane -> pins
  expect(sb.activeLane()).toBe("coder");
  const reply = await sb.send("Give me your one-sentence opinion of tabs versus spaces.");
  expect(sb.activeLane()).toBe("coder");                   // still pinned
  expect(reply).toBe("coder reply");                       // went to the brain, not the roster
  await sb.send("back to cicero");
  expect(await sb.send("Put the file in the repo.")).toBe("front reply");
  expect(await sb.send("Transfer me to my manager.")).toContain("I can connect you to");
});

test("roll call: one check-in sentence per lane, voices consumed per sentence", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  const reply = await sb.send("Avengers, assemble!");
  expect(reply).toBe("The Coder checking in. Think checking in.");
  // voice queue: one voice per rendered sentence, then back to the default
  expect(sb.activeLaneVoice()).toBe("am_michael");
  expect(sb.activeLaneVoice()).toBe("bm_george");
  expect(sb.activeLaneVoice()).toBeUndefined();
  expect(sb.activeLane()).toBeNull();          // roll call does not pin anyone
  expect(calls).not.toContain("coder:start");  // greetings need voices, not brains
});

test("roll call phrasings: 'everyone check in', 'roll call' with lead-ins", async () => {
  for (const c of ["I want everyone to check in.", "Okay, roll call.", "roll call please"]) {
    const calls: string[] = [];
    const sb = board(calls);
    await sb.start();
    expect(await sb.send(c)).toContain("checking in.");
  }
});

test("roll call catches natural group phrasings (the live-call misses)", async () => {
  const phrasings = [
    "Can you bring everyone into the conversation?",
    "I want to have everyone check in.",
    "Bring everyone in.",
    "Get everyone on the line.",
    "Can we have everyone join the conversation?",
    "Group call, please.",
    "Have everybody say hi.",
  ];
  for (const c of phrasings) {
    const sb = board([]);
    await sb.start();
    expect(await sb.send(c)).toContain("checking in.");
    expect(sb.wasControlTurn()).toBe(true);
  }
});

test("standup: started lanes report in their own voices, idle lanes say so", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  await sb.send("Let me talk to the coder.");   // start coder
  await sb.send("Back to you.");                // release the pin
  const reply = await sb.send("Status from everyone.");
  expect(reply).toStartWith("Getting status from the team.");
  expect(reply).toContain("Coder: coder reply.");
  expect(reply).toContain("Think: idle, no active session.");
  expect(sb.wasControlTurn()).toBe(true);
  // voice queue: intro = front desk, then one entry per rendered sentence
  expect(sb.activeLaneVoice()).toBeUndefined();       // "Getting status from the team."
  expect(sb.activeLaneVoice()).toBe("am_michael");    // coder's line
  expect(sb.activeLaneVoice()).toBe("bm_george");     // think's line
  expect(sb.activeLaneVoice()).toBeUndefined();       // queue drained
  expect(calls.filter((c) => c === "think:start")).toHaveLength(0); // idle lane not woken
});

test("a completed standup lane clears its deadline timer", async () => {
  let lateAbort = 0;
  const lane: Brain = {
    ...fakeBrain("worker", []),
    send: async (_message, options) => {
      options?.signal?.addEventListener("abort", () => { lateAbort++; }, { once: true });
      return "all clear";
    },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", []), { worker: { brain: lane } }, undefined, {
    standupLaneTimeoutMs: 15,
  });
  await sb.transferTo("worker");
  await sb.send("back to cicero");

  expect(await sb.send("status from everyone")).toContain("Worker: all clear.");
  await Bun.sleep(35);
  expect(lateAbort).toBe(0);
});

test("a standup deadline aborts the lane turn and prevents late work", async () => {
  let aborts = 0;
  let lateMutations = 0;
  const lane: Brain = {
    ...fakeBrain("worker", []),
    send: (_message, options) => new Promise<string>((resolve, reject) => {
      const late = setTimeout(() => {
        lateMutations++;
        resolve("late answer");
      }, 60);
      options?.signal?.addEventListener("abort", () => {
        aborts++;
        clearTimeout(late);
        reject(options.signal?.reason);
      }, { once: true });
    }),
  };
  const sb = new SwitchboardBrain(fakeBrain("front", []), { worker: { brain: lane } }, undefined, {
    standupLaneTimeoutMs: 15,
  });
  await sb.transferTo("worker");
  await sb.send("back to cicero");

  expect(await sb.send("status from everyone")).toContain("Worker: didn't answer.");
  await Bun.sleep(70);
  expect(aborts).toBe(1);
  expect(lateMutations).toBe(0);
});

test("caller cancellation aborts and rejects the whole standup promptly", async () => {
  let observedAbort = false;
  const lane: Brain = {
    ...fakeBrain("worker", []),
    send: (_message, options) => new Promise<string>(() => {
      options?.signal?.addEventListener("abort", () => { observedAbort = true; }, { once: true });
    }),
  };
  const sb = new SwitchboardBrain(fakeBrain("front", []), { worker: { brain: lane } }, undefined, {
    standupLaneTimeoutMs: 1_000,
  });
  await sb.transferTo("worker");
  await sb.send("back to cicero");
  const caller = new AbortController();

  const turn = sb.send("status from everyone", { signal: caller.signal });
  setTimeout(() => caller.abort(new Error("caller left")), 10);
  await expect(turn).rejects.toThrow("caller left");
  expect(observedAbort).toBe(true);
});

test("caller cancellation between fulfilled streamed answers suppresses stale output", async () => {
  const first = fakeBrain("first", []);
  const second = fakeBrain("second", []);
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    first: { brain: first, voice: "first-voice" },
    second: { brain: second, voice: "second-voice" },
  }, undefined, { standupLaneTimeoutMs: 1_000 });
  await sb.transferTo("first");
  await sb.transferTo("second");
  await sb.send("back to cicero");

  const caller = new AbortController();
  const stream = sb.sendStream("status from everyone", { signal: caller.signal })[Symbol.asyncIterator]();
  expect((await stream.next()).value).toBe("Getting status from the team.");
  expect(sb.activeLaneVoice()).toBeUndefined();
  expect((await stream.next()).value).toContain("First: first reply.");
  expect(sb.activeLaneVoice()).toBe("first-voice");

  caller.abort(new Error("caller left after first answer"));
  await expect(stream.next()).rejects.toThrow("caller left after first answer");
  expect(sb.activeLaneVoice()).toBeUndefined();
});

test("abandoning an older standup cannot clear a newer turn's voice lease", async () => {
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    first: { brain: fakeBrain("first", []), voice: "first-voice" },
    second: { brain: fakeBrain("second", []), voice: "second-voice" },
  }, undefined, { standupLaneTimeoutMs: 1_000 });
  await sb.transferTo("first");
  await sb.transferTo("second");
  await sb.send("back to cicero");

  const older = sb.sendStream("status from everyone")[Symbol.asyncIterator]();
  const newer = sb.sendStream("status from everyone")[Symbol.asyncIterator]();
  expect((await older.next()).value).toBe("Getting status from the team.");
  expect((await newer.next()).value).toBe("Getting status from the team.");
  expect(sb.activeLaneVoice()).toBeUndefined(); // newer intro
  expect((await newer.next()).value).toContain("First: first reply.");

  await older.return?.(undefined);
  expect(sb.activeLaneVoice()).toBe("first-voice");
  await newer.return?.(undefined);
  expect(sb.activeLaneVoice()).toBeUndefined();
});

test("a programmatic transfer supersedes a paused standup without stale output", async () => {
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    first: { brain: fakeBrain("first", []), voice: "first-voice" },
    second: { brain: fakeBrain("second", []), voice: "second-voice" },
  }, undefined, { standupLaneTimeoutMs: 1_000 });
  await sb.transferTo("first");
  await sb.transferTo("second");
  await sb.send("back to cicero");

  const oldStandup = sb.sendStream("status from everyone")[Symbol.asyncIterator]();
  expect((await oldStandup.next()).value).toBe("Getting status from the team.");

  expect(await sb.transferTo("first")).toBe("First");
  expect(sb.activeLaneVoice()).toBe("first-voice");
  await expect(oldStandup.next()).rejects.toThrow("superseded by a newer accepted turn");
  expect(sb.activeLaneVoice()).toBe("first-voice");
});

test("a bare-name transfer supersedes a paused standup before its early return", async () => {
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    first: { brain: fakeBrain("first", []), voice: "first-voice" },
    second: { brain: fakeBrain("second", []), voice: "second-voice" },
  }, undefined, { standupLaneTimeoutMs: 1_000 });
  await sb.transferTo("first");
  await sb.transferTo("second");
  await sb.send("back to cicero");

  const oldStandup = sb.sendStream("status from everyone")[Symbol.asyncIterator]();
  expect((await oldStandup.next()).value).toBe("Getting status from the team.");

  expect(await sb.send("first")).toBe("First here.");
  expect(sb.activeLaneVoice()).toBe("first-voice");
  await expect(oldStandup.next()).rejects.toThrow("superseded by a newer accepted turn");
  expect(sb.activeLaneVoice()).toBe("first-voice");
});

test("a late older classifier cannot replace a newer standup's voice lease", async () => {
  let resolveClassifier: ((label: string) => void) | undefined;
  const classifier = () => new Promise<string>((resolve) => { resolveClassifier = resolve; });
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    first: { brain: fakeBrain("first", []), voice: "first-voice" },
    second: { brain: fakeBrain("second", []), voice: "second-voice" },
  }, classifier, { standupLaneTimeoutMs: 1_000 });
  await sb.transferTo("first");
  await sb.transferTo("second");
  await sb.send("back to cicero");

  const staleTurn = sb.send("Could you connect the whole office for a quick hello?");
  await Bun.sleep(0);
  expect(typeof resolveClassifier).toBe("function");

  const newer = sb.sendStream("status from everyone")[Symbol.asyncIterator]();
  expect((await newer.next()).value).toBe("Getting status from the team.");
  expect(sb.activeLaneVoice()).toBeUndefined();
  expect((await newer.next()).value).toContain("First: first reply.");
  expect(sb.activeLaneVoice()).toBe("first-voice");

  resolveClassifier!("rollcall");
  await expect(staleTurn).rejects.toThrow("superseded by a newer accepted turn");
  expect((await newer.next()).value).toContain("Second: second reply.");
  expect(sb.activeLaneVoice()).toBe("second-voice");
  expect((await newer.next()).done).toBe(true);
});

test("a superseding turn promptly rejects an uncooperative classifier", async () => {
  let classifierStarted = false;
  let classifierSignal: AbortSignal | undefined;
  const classifier = (_prompt: string, signal?: AbortSignal) => {
    classifierStarted = true;
    classifierSignal = signal;
    return new Promise<string>(() => { /* intentionally never settles */ });
  };
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    worker: { brain: fakeBrain("worker", []), voice: "worker-voice" },
  }, classifier);
  await sb.transferTo("worker");
  await sb.send("back to cicero");

  const staleTurn = sb.send("Could you connect the whole office for a quick hello?");
  const promptRejection = Promise.race([
    staleTurn,
    Bun.sleep(100).then(() => { throw new Error("stale classifier turn did not cancel"); }),
  ]);
  await Bun.sleep(0);
  expect(classifierStarted).toBe(true);
  expect(classifierSignal).toBeDefined();

  expect(await sb.send("status from everyone")).toContain("Worker: worker reply.");
  expect(classifierSignal!.aborted).toBe(true);
  await expect(promptRejection).rejects.toThrow("superseded by a newer accepted turn");
});

test("a superseding turn aborts the propagated signal and races a never-settling brain send", async () => {
  let downstreamSignal: AbortSignal | undefined;
  const front: Brain = {
    ...fakeBrain("front", []),
    send: (_message, options) => {
      downstreamSignal = options?.signal;
      return new Promise<string>(() => { /* intentionally never settles */ });
    },
  };
  const sb = new SwitchboardBrain(front, {});
  const caller = new AbortController();
  const staleTurn = sb.send("ordinary work", { signal: caller.signal });
  const promptRejection = Promise.race([
    staleTurn,
    Bun.sleep(100).then(() => { throw new Error("stale provider turn did not cancel"); }),
  ]);
  await Bun.sleep(0);
  expect(downstreamSignal).toBeDefined();
  expect(downstreamSignal).not.toBe(caller.signal);
  expect(downstreamSignal!.aborted).toBe(false);

  expect(await sb.transferTo("missing-lane")).toBeNull();
  expect(caller.signal.aborted).toBe(false);
  expect(downstreamSignal!.aborted).toBe(true);
  await expect(promptRejection).rejects.toThrow("superseded by a newer accepted turn");
});

test("a superseding turn races a signal-ignoring stream pull and detaches cleanup", async () => {
  let downstreamSignal: AbortSignal | undefined;
  let pulls = 0;
  let returns = 0;
  const front: Brain = {
    ...fakeBrain("front", []),
    sendStream: (_message, options) => {
      downstreamSignal = options?.signal;
      return {
        [Symbol.asyncIterator](): AsyncIterator<string> {
          return {
            next: () => {
              pulls++;
              if (pulls === 1) return Promise.resolve({ done: false, value: "x".repeat(41) });
              return new Promise<IteratorResult<string>>(() => { /* intentionally never settles */ });
            },
            return: async () => {
              returns++;
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  };
  const sb = new SwitchboardBrain(front, {});
  const stream = sb.sendStream("ordinary streamed work")[Symbol.asyncIterator]();
  expect((await stream.next()).value).toBe("x".repeat(41));

  const stalePull = stream.next();
  const promptRejection = Promise.race([
    stalePull,
    Bun.sleep(100).then(() => { throw new Error("stale stream pull did not cancel"); }),
  ]);
  await Bun.sleep(0);
  expect(pulls).toBe(2);
  expect(downstreamSignal).toBeDefined();

  expect(await sb.transferTo("missing-lane")).toBeNull();
  expect(downstreamSignal!.aborted).toBe(true);
  await expect(promptRejection).rejects.toThrow("superseded by a newer accepted turn");
  await Bun.sleep(0);
  expect(returns).toBe(1);
});

test("a superseded cold start is coalesced, recorded, retried, and stopped", async () => {
  let resolveStart: (() => void) | undefined;
  let starts = 0;
  let stops = 0;
  const contexts: string[] = [];
  const worker: Brain = {
    ...fakeBrain("worker", []),
    start: () => {
      starts++;
      return new Promise<void>((resolve) => { resolveStart = resolve; });
    },
    stop: async () => { stops++; },
    injectContext: (context) => { contexts.push(context); },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    worker: { brain: worker, persona: "Keep the status concise." },
  });

  const firstTransfer = sb.transferTo("worker");
  const firstRejection = Promise.race([
    firstTransfer,
    Bun.sleep(100).then(() => { throw new Error("superseded cold start did not release its caller"); }),
  ]);
  await Bun.sleep(0);
  expect(starts).toBe(1);
  expect(contexts).toEqual(["Keep the status concise."]);

  expect(await sb.transferTo("missing-lane")).toBeNull();
  await expect(firstRejection).rejects.toThrow("superseded by a newer accepted turn");

  const retry = sb.transferTo("worker");
  await Bun.sleep(0);
  expect(starts).toBe(1); // coalesced onto the still-owned lifecycle promise
  resolveStart!();
  expect(await retry).toBe("Worker");
  expect(starts).toBe(1);

  await sb.stop();
  expect(stops).toBe(1);
});

test("stop does not wait for a lane start that never settles", async () => {
  let stops = 0;
  const worker: Brain = {
    ...fakeBrain("worker", []),
    start: () => new Promise<void>(() => { /* intentionally never settles */ }),
    stop: async () => { stops++; },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", []), { worker: { brain: worker } });

  const transfer = sb.transferTo("worker");
  void transfer.catch(() => {});
  await Bun.sleep(0);
  await settlesWithin(sb.stop(), "switchboard stop");

  expect(stops).toBe(1);
  expect(sb.activeLane()).toBeNull();
  await expect(settlesWithin(transfer, "retired transfer")).rejects.toThrow("switchboard stopping");
});

test("stop clears a pending cold transfer before the next board session", async () => {
  // Forward guard: stop already cleared the scalar pending state before the
  // pending-transfer ownership fix made cancellation disposition explicit.
  const calls: string[] = [];
  const cold = coldLane(calls);
  const sb = new SwitchboardBrain(fakeBrain("front", calls), { worker: { brain: cold.brain } });
  try {
    await sb.start();
    const transfer = sb.send("talk to the worker");
    void transfer.catch(() => { /* superseded below */ });
    await Bun.sleep(0);
    expect(await settlesWithin(sb.send("hello?"), "barge-in"))
      .toBe("Still getting Worker on the line — one moment.");
    await expect(transfer).rejects.toThrow("superseded by a newer accepted turn");

    await settlesWithin(sb.stop(), "switchboard stop");
    cold.release();
    await Bun.sleep(0);
    await Bun.sleep(0);

    await sb.start();
    expect(await sb.send("fresh conversation")).toBe("front reply");
    expect(sb.activeLane()).toBeNull();
  } finally {
    cold.release();
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("stop preempts a primary start that never settles", async () => {
  let stops = 0;
  const primary: Brain = {
    ...fakeBrain("front", []),
    start: () => new Promise<void>(() => { /* intentionally never settles */ }),
    stop: async () => { stops++; },
  };
  const sb = new SwitchboardBrain(primary, {});

  const starting = sb.start();
  void starting.catch(() => {});
  await Bun.sleep(0);
  await settlesWithin(sb.stop(), "stop behind primary start");

  expect(stops).toBe(1);
  await expect(sb.send("must remain closed")).rejects.toThrow("switchboard is stopping");
});

test("stop preempts a primary restart that never settles", async () => {
  let stops = 0;
  const primary: Brain = {
    ...fakeBrain("front", []),
    stop: async () => { stops++; },
    restart: () => new Promise<void>(() => { /* intentionally never settles */ }),
  };
  const sb = new SwitchboardBrain(primary, {});
  await sb.start();

  const restarting = sb.restart();
  void restarting.catch(() => {});
  await Bun.sleep(0);
  await settlesWithin(sb.stop(), "stop behind primary restart");

  expect(stops).toBe(1);
  await expect(sb.send("must remain closed")).rejects.toThrow("switchboard is stopping");
});

test("a primary start that appears after stop is reaped before the next session starts", async () => {
  let resolveFirstStart: (() => void) | undefined;
  let resolveFirstStop: (() => void) | undefined;
  let starts = 0;
  let stops = 0;
  let activeStops = 0;
  let maxConcurrentStops = 0;
  const primary: Brain = {
    ...fakeBrain("front", []),
    start: () => {
      starts++;
      if (starts === 1) {
        return new Promise<void>((resolve) => { resolveFirstStart = resolve; });
      }
      return Promise.resolve();
    },
    stop: async () => {
      stops++;
      activeStops++;
      maxConcurrentStops = Math.max(maxConcurrentStops, activeStops);
      try {
        if (stops === 1) {
          await new Promise<void>((resolve) => { resolveFirstStop = resolve; });
        }
      } finally {
        activeStops--;
      }
    },
  };
  const sb = new SwitchboardBrain(primary, {});

  const staleStart = sb.start();
  await Bun.sleep(0);
  const stopping = sb.stop();
  await Bun.sleep(0);
  expect(stops).toBe(1);
  const freshStart = sb.start();
  await Bun.sleep(0);
  expect(starts).toBe(1); // the next session is gated on late cleanup

  resolveFirstStart!();
  await Bun.sleep(0);
  expect(stops).toBe(1); // the late reap queues behind the in-flight stop
  expect(maxConcurrentStops).toBe(1);

  resolveFirstStop!();
  await Promise.all([stopping, staleStart, freshStart]);
  expect(starts).toBe(2);
  expect(stops).toBe(2); // immediate shutdown plus late-start reaping
  expect(maxConcurrentStops).toBe(1);
  expect(await sb.send("fresh session")).toBe("front reply");
  await sb.stop();
});

test("a cold start that succeeds after stop is reaped and cannot resurrect its pin", async () => {
  let resolveFirstStart: (() => void) | undefined;
  let starts = 0;
  let stops = 0;
  const worker: Brain = {
    ...fakeBrain("worker", []),
    start: () => {
      starts++;
      if (starts === 1) {
        return new Promise<void>((resolve) => { resolveFirstStart = resolve; });
      }
      return Promise.resolve();
    },
    stop: async () => { stops++; },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", []), { worker: { brain: worker } });

  const stale = sb.transferTo("worker");
  void stale.catch(() => {});
  await Bun.sleep(0);
  await settlesWithin(sb.stop(), "switchboard stop");
  expect(stops).toBe(1);

  resolveFirstStart!();
  await Bun.sleep(0);
  await Bun.sleep(0);
  expect(stops).toBe(2); // the process appeared after the boundary and was stopped again
  expect(sb.activeLane()).toBeNull();
  await expect(stale).rejects.toThrow("switchboard stopping");

  await sb.start();
  expect(await sb.transferTo("worker")).toBe("Worker");
  expect(starts).toBe(2);
  await sb.stop();
});

test("stop then start clears pinned, started, handoff, and one-shot context state", async () => {
  let starts = 0;
  let stops = 0;
  let sends = 0;
  const contexts: string[] = [];
  const worker: Brain = {
    ...fakeBrain("worker", []),
    start: async () => { starts++; },
    stop: async () => { stops++; },
    send: async () => { sends++; return "worker reply"; },
    injectContext: (context) => { contexts.push(context); },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    worker: { brain: worker, voice: "worker-voice" },
  });

  await sb.start();
  await sb.transferTo("worker");
  await sb.send("remember this old exchange");
  sb.injectContext("stale one-shot context");
  await sb.stop();

  expect(sb.activeLane()).toBeNull();
  expect(sb.activeLaneVoice()).toBeUndefined();
  await sb.start();
  const standup = await sb.send("status from everyone");
  expect(standup).toContain("idle, no active session");
  expect(sends).toBe(1); // the post-start standup did not contact the stopped lane

  await sb.transferTo("worker");
  await sb.send("fresh session");
  expect(starts).toBe(2);
  expect(stops).toBe(1);
  expect(contexts).toEqual([]); // no stale handoff or pending wrapper context
  await sb.stop();
});

test("a superseded cold transfer injects only the winning brief", async () => {
  let resolveStart: (() => void) | undefined;
  const contexts: string[] = [];
  const worker: Brain = {
    ...fakeBrain("worker", []),
    start: () => new Promise<void>((resolve) => { resolveStart = resolve; }),
    injectContext: (context) => { contexts.push(context); },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    worker: { brain: worker, persona: "worker persona" },
  });

  const stale = sb.transferTo("worker", async () => "stale brief");
  void stale.catch(() => {});
  await Bun.sleep(0);
  const winner = sb.transferTo("worker", async () => "fresh brief");
  await Bun.sleep(0);
  resolveStart!();

  await expect(stale).rejects.toThrow("superseded by a newer accepted turn");
  expect(await winner).toBe("Worker");
  expect(contexts).toEqual(["worker persona", "fresh brief"]);
  await sb.stop();
});

test("a failed start is cleanup-stopped and retry does not duplicate persona or stale brief", async () => {
  let starts = 0;
  let stops = 0;
  let up = false;
  const contexts: string[] = [];
  const worker: Brain = {
    ...fakeBrain("worker", []),
    start: async () => {
      starts++;
      if (starts === 1) {
        up = true; // partial allocation before failure
        throw new Error("start failed after allocation");
      }
      if (up) throw new Error("retry overlapped uncleared state");
      up = true;
    },
    stop: async () => { stops++; up = false; },
    injectContext: (context) => { contexts.push(context); },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    worker: { brain: worker, persona: "worker persona" },
  });

  expect(await sb.transferTo("worker", async () => "failed brief")).toBeNull();
  expect(stops).toBe(1);
  expect(up).toBe(false);
  expect(await sb.transferTo("worker", async () => "fresh brief")).toBe("Worker");
  expect(starts).toBe(2);
  expect(contexts).toEqual(["worker persona", "fresh brief"]);

  await sb.stop();
  expect(stops).toBe(2);
  expect(up).toBe(false);
});

test("caller abort after a lexical rollcall clears its undrained voice lease", async () => {
  const caller = new AbortController();
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    first: { brain: fakeBrain("first", []), voice: "first-voice" },
    second: { brain: fakeBrain("second", []), voice: "second-voice" },
  });

  expect(await sb.send("roll call", { signal: caller.signal }))
    .toBe("First checking in. Second checking in.");
  caller.abort(new Error("speech cancelled"));
  expect(sb.activeLaneVoice()).toBeUndefined();
  expect(sb.activeLaneVoice()).toBeUndefined();
});

test("stream return interrupts pending pulls without awaiting uncooperative cleanup", async () => {
  for (const capability of ["sendStream", "streamProgress"] as const) {
    let pulls = 0;
    let returns = 0;
    const source = (): AsyncIterable<string> => ({
      [Symbol.asyncIterator](): AsyncIterator<string> {
        return {
          next: () => {
            pulls++;
            return new Promise<IteratorResult<string>>(() => { /* never settles */ });
          },
          return: () => {
            returns++;
            return new Promise<IteratorResult<string>>(() => { /* never settles */ });
          },
        };
      },
    });
    const front: Brain = capability === "sendStream"
      ? { ...fakeBrain("front", []), sendStream: source }
      : { ...fakeBrain("front", []), streamProgress: source };
    const sb = new SwitchboardBrain(front, {});
    const iterable = capability === "sendStream"
      ? sb.sendStream("blocked stream")
      : sb.streamProgress!("blocked progress");
    const iterator = iterable[Symbol.asyncIterator]();
    const pending = iterator.next();
    void pending.catch(() => {});
    await Bun.sleep(0);
    expect(pulls).toBe(1);

    const returned = await settlesWithin(iterator.return!(), `${capability} return`);
    expect(returned.done).toBe(true);
    await expect(settlesWithin(pending, `${capability} pending pull`))
      .rejects.toThrow("switchboard stream consumer stopped");
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(returns).toBe(1);
  }
});

test("restart aborts active work, blocks admission, and preserves a successfully restarted pin", async () => {
  let resolveRestart: (() => void) | undefined;
  let blockedSignal: AbortSignal | undefined;
  let workerRestarts = 0;
  const front: Brain = {
    ...fakeBrain("front", []),
    restart: () => new Promise<void>((resolve) => { resolveRestart = resolve; }),
  };
  const worker: Brain = {
    ...fakeBrain("worker", []),
    send: (message, options) => {
      if (message !== "blocked") return Promise.resolve("worker reply");
      blockedSignal = options?.signal;
      return new Promise<string>(() => { /* ignores cancellation */ });
    },
    restart: async () => { workerRestarts++; },
  };
  const sb = new SwitchboardBrain(front, { worker: { brain: worker } });
  await sb.start();
  await sb.transferTo("worker");

  const blocked = sb.send("blocked");
  void blocked.catch(() => {});
  await Bun.sleep(0);
  const restarting = sb.restart();
  await expect(settlesWithin(blocked, "restart cancellation"))
    .rejects.toThrow("switchboard restarting");
  expect(blockedSignal?.aborted).toBe(true);
  await expect(sb.send("during restart")).rejects.toThrow("switchboard is stopping");

  await Bun.sleep(0);
  resolveRestart!();
  await restarting;
  expect(workerRestarts).toBe(1);
  expect(sb.activeLane()).toBe("worker");
  expect(await sb.send("after restart")).toBe("worker reply");
  await sb.stop();
});

test("restart stays closed until retired cold-lane cleanup finishes", async () => {
  let resolveCleanup: (() => void) | undefined;
  let stops = 0;
  const worker: Brain = {
    ...fakeBrain("worker", []),
    start: () => new Promise<void>(() => { /* intentionally never settles */ }),
    stop: () => {
      stops++;
      if (stops === 1) {
        return new Promise<void>((resolve) => { resolveCleanup = resolve; });
      }
      return Promise.resolve();
    },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", []), { worker: { brain: worker } });
  await sb.start();

  const staleTransfer = sb.transferTo("worker");
  void staleTransfer.catch(() => {});
  await Bun.sleep(0);
  const restarting = sb.restart();
  await Bun.sleep(0);
  await Bun.sleep(0);

  expect(stops).toBe(1);
  await expect(staleTransfer).rejects.toThrow("switchboard restarting");
  await expect(sb.send("during retired cleanup")).rejects.toThrow("switchboard is stopping");

  resolveCleanup!();
  await restarting;
  expect(await sb.send("after cleanup")).toBe("front reply");
  await sb.stop();
});

test("restart restores a started lane persona before reopening admission", async () => {
  const injections: string[] = [];
  let sessionContext: string[] = [];
  const worker: Brain = {
    ...fakeBrain("worker", []),
    injectContext: (context) => {
      injections.push(context);
      sessionContext.push(context);
    },
    restart: async () => { sessionContext = []; },
    send: async () => sessionContext.join(" | "),
  };
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    worker: { brain: worker, persona: "Keep the status concise." },
  });
  await sb.start();
  await sb.transferTo("worker");
  expect(injections).toEqual(["Keep the status concise."]);

  await sb.restart();
  expect(sb.activeLane()).toBe("worker");
  expect(injections).toEqual(["Keep the status concise.", "Keep the status concise."]);
  expect(await sb.send("after restart")).toBe("Keep the status concise.");
  await sb.stop();
});

test("restart clears a completed voice lease and remains closed after primary failure", async () => {
  let failRestart = false;
  const front: Brain = {
    ...fakeBrain("front", []),
    restart: async () => {
      if (failRestart) throw new Error("restart failed");
    },
  };
  const sb = new SwitchboardBrain(front, {
    worker: { brain: fakeBrain("worker", []), voice: "worker-voice" },
  });

  await sb.send("roll call");
  await sb.restart();
  expect(sb.activeLaneVoice()).toBeUndefined();

  failRestart = true;
  await expect(sb.restart()).rejects.toThrow("restart failed");
  await expect(sb.send("must stay closed")).rejects.toThrow("switchboard is stopping");
});

test("cached sendToTab resolves the active capability at invocation time", async () => {
  const frontCalls: string[] = [];
  const workerCalls: string[] = [];
  const front: Brain = {
    ...fakeBrain("front", []),
    sendToTab: async (message, tab) => { frontCalls.push(`${message}:${tab}`); return "front tab"; },
  };
  const worker: Brain = {
    ...fakeBrain("worker", []),
    sendToTab: async (message, tab) => { workerCalls.push(`${message}:${tab}`); return "worker tab"; },
  };
  const sb = new SwitchboardBrain(front, { worker: { brain: worker } });

  const cachedFront = sb.sendToTab!;
  await sb.transferTo("worker");
  expect(await cachedFront("one", "tab-a")).toBe("worker tab");
  expect(frontCalls).toEqual([]);
  expect(workerCalls).toEqual(["one:tab-a"]);

  const cachedWorker = sb.sendToTab!;
  await sb.send("back to cicero");
  expect(await cachedWorker("two", "tab-b")).toBe("front tab");
  expect(frontCalls).toEqual(["two:tab-b"]);

  const unsupported = new SwitchboardBrain(front, {
    worker: { brain: fakeBrain("worker", []) },
  });
  const cachedSupported = unsupported.sendToTab!;
  await unsupported.transferTo("worker");
  await expect(cachedSupported("stale", "tab-c")).rejects.toThrow("does not support sendToTab");
  expect(frontCalls).toEqual(["two:tab-b"]);
});

test("completed batch, stream, and sendToTab signals are never retroactively aborted", async () => {
  const batchSignals: AbortSignal[] = [];
  let streamSignal: AbortSignal | undefined;
  let tabSignal: AbortSignal | undefined;
  const front: Brain = {
    ...fakeBrain("front", []),
    send: async (_message, options) => {
      batchSignals.push(options!.signal!);
      return "batch reply";
    },
    sendStream: async function* (_message, options) {
      streamSignal = options?.signal;
      yield "stream reply";
    },
    sendToTab: async (_message, _tab, options) => {
      tabSignal = options?.signal;
      return "tab reply";
    },
  };
  const sb = new SwitchboardBrain(front, {});

  const caller = new AbortController();
  expect(await sb.send("first", { signal: caller.signal })).toBe("batch reply");
  const firstSignal = batchSignals[0]!;
  caller.abort(new Error("late caller abort"));
  expect(firstSignal.aborted).toBe(false);
  await sb.send("second");
  expect(firstSignal.aborted).toBe(false);

  let streamed = "";
  for await (const chunk of sb.sendStream("stream")) streamed += chunk;
  expect(streamed).toBe("stream reply");
  await sb.send("after stream");
  expect(streamSignal?.aborted).toBe(false);

  expect(await sb.sendToTab!("tab work", "target")).toBe("tab reply");
  await sb.send("after tab");
  expect(tabSignal?.aborted).toBe(false);
});

test("an invalid programmatic transfer still supersedes a paused standup", async () => {
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    worker: { brain: fakeBrain("worker", []), voice: "worker-voice" },
  }, undefined, { standupLaneTimeoutMs: 1_000 });
  await sb.transferTo("worker");
  await sb.send("back to cicero");

  const oldStandup = sb.sendStream("status from everyone")[Symbol.asyncIterator]();
  expect((await oldStandup.next()).value).toBe("Getting status from the team.");
  expect(sb.activeLaneVoice()).toBeUndefined();

  expect(await sb.transferTo("nobody-in-this-office")).toBeNull();
  await expect(oldStandup.next()).rejects.toThrow("superseded by a newer accepted turn");
  expect(sb.activeLaneVoice()).toBeUndefined();
});

test("ending a streamed standup aborts unfinished parallel lanes and clears voice routing", async () => {
  let slowAborted = false;
  const fast: Brain = {
    ...fakeBrain("fast", []),
    send: () => Promise.resolve("ready"),
  };
  const slow: Brain = {
    ...fakeBrain("slow", []),
    send: (_message, options) => new Promise<string>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        slowAborted = true;
        reject(options.signal?.reason);
      }, { once: true });
    }),
  };
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    fast: { brain: fast, voice: "fast-voice" },
    slow: { brain: slow, voice: "slow-voice" },
  }, undefined, { standupLaneTimeoutMs: 1_000 });
  await sb.transferTo("fast");
  await sb.transferTo("slow");
  await sb.send("back to cicero");

  const stream = sb.sendStream("status from everyone")[Symbol.asyncIterator]();
  expect((await stream.next()).value).toBe("Getting status from the team.");
  expect((await stream.next()).value).toContain("Fast: ready.");
  await stream.return?.(undefined);
  await Bun.sleep(0);

  expect(slowAborted).toBe(true);
  expect(sb.activeLaneVoice()).toBeUndefined();
});

test("standup lane timeout must fit the runtime's positive timer range", () => {
  for (const standupLaneTimeoutMs of [0, -1, 1.5, 2_147_483_648]) {
    expect(() => new SwitchboardBrain(fakeBrain("front", []), {}, undefined, {
      standupLaneTimeoutMs,
    })).toThrow("positive integer no greater than 2147483647");
  }
  expect(() => new SwitchboardBrain(fakeBrain("front", []), {}, undefined, {
    standupLaneTimeoutMs: 2_147_483_647,
  })).not.toThrow();
});

test("standup lane failures are logged once with bounded diagnostics", async () => {
  const hugeFailure = `root-cause-${"x".repeat(1_000)}-tail-marker`;
  const lane: Brain = {
    ...fakeBrain("worker", []),
    send: async () => { throw new Error(hugeFailure); },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", []), { worker: { brain: lane } });
  await sb.transferTo("worker");
  await sb.send("back to cicero");

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]): void => { output.push(values.map(String).join(" ")); };
  try {
    expect(await sb.send("status from everyone")).toContain("Worker: didn't answer.");
  } finally {
    console.log = originalLog;
  }

  const failures = output.filter((line) => line.includes("switchboard: standup lane worker failed:"));
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("Error: root-cause-");
  expect(failures[0]).not.toContain("tail-marker");
  expect(failures[0]!.length).toBeLessThan(400);
});

test("standup phrasings match; ordinary status questions do not", async () => {
  for (const c of ["What's everyone working on?", "Give me a team status update.", "Standup.", "Everyone report in."]) {
    const sb = board([]);
    await sb.start();
    expect(await sb.send(c)).toStartWith("Getting status from the team.");
  }
  const sb = board([]);
  await sb.start();
  expect(await sb.send("What is the status of the parser fix?")).not.toStartWith("Getting status");
  expect(sb.wasControlTurn()).toBe(false);
});

test("group requests with trailing qualifiers (the 'roll call with everyone' live miss)", async () => {
  const rollcalls = ["roll call with everyone.", "Roll call for the team, please."];
  for (const c of rollcalls) {
    const sb = board([]);
    await sb.start();
    expect(await sb.send(c)).toContain("checking in.");
  }
  const standups = ["I want the status of each agent.", "Status from all of them.", "Standup with everyone."];
  for (const c of standups) {
    const sb = board([]);
    await sb.start();
    expect(await sb.send(c)).toStartWith("Getting status from the team.");
  }
});

test("bare 'status' stays a normal turn for whoever is pinned", async () => {
  const sb = board([]);
  await sb.start();
  await sb.send("Let me talk to the coder.");
  expect(await sb.send("Status?")).toBe("coder reply");
  expect(await sb.send("I want a status update.")).toBe("coder reply");
});

// ---------- intent-classifier fallback (generic phrasings) ----------

function classifierBoard(calls: string[], label: string | (() => Promise<string>)) {
  const classify = typeof label === "string" ? async () => label : label;
  const prompts: string[] = [];
  const wrapped = async (p: string) => { prompts.push(p); return typeof label === "string" ? label : label(); };
  const lanes: Record<string, LaneDef> = {
    coder: { brain: fakeBrain("coder", calls), aliases: ["the coder"], voice: "am_michael" },
    think: { brain: fakeBrain("think", calls), voice: "bm_george" },
  };
  return { sb: new SwitchboardBrain(fakeBrain("front", calls), lanes, wrapped), prompts };
}

function magicRollcallFront(calls: string[], streaming = false): Brain {
  return {
    ...fakeBrain("front", calls),
    send: async (m: string) => { calls.push(`front:send:${m}`); return "roll call"; },
    ...(streaming ? {
      sendStream: async function* (m: string) {
        calls.push(`front:stream:${m}`);
        yield "roll ";
        yield "call";
      },
    } : {}),
  };
}

test("classifier routes phrasings the patterns miss", async () => {
  const calls: string[] = [];
  const { sb, prompts } = classifierBoard(calls, "transfer:coder");
  await sb.start();
  const reply = await sb.send("Could you patch me through to whoever handles the code?");
  expect(reply).toContain("Coder here.");
  expect(sb.activeLane()).toBe("coder");
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("coder (aka the coder)");
});

test("classifier 'none', garbage, and failures all degrade to a normal turn", async () => {
  for (const label of ["none", "banana", "transfer:nobody"]) {
    const calls: string[] = [];
    const { sb } = classifierBoard(calls, label);
    await sb.start();
    expect(await sb.send("Can you bring up the status page code?")).toBe("front reply");
    expect(sb.wasControlTurn()).toBe(false);
  }
  const calls: string[] = [];
  const { sb } = classifierBoard(calls, () => Promise.reject(new Error("down")));
  await sb.start();
  expect(await sb.send("Please connect the dots here.")).toBe("front reply");
});

test("non-control-ish turns never pay for a classification", async () => {
  const calls: string[] = [];
  const { sb, prompts } = classifierBoard(calls, "standup");
  await sb.start();
  expect(await sb.send("Fix the login bug in the parser.")).toBe("front reply");
  expect(prompts).toHaveLength(0);
});

test("classifier can trigger rollcall and standup from fuzzy asks", async () => {
  const calls: string[] = [];
  const { sb } = classifierBoard(calls, "rollcall");
  await sb.start();
  expect(await sb.send("I'd love to hear from the whole office right now.")).toContain("checking in.");
  const { sb: sb2 } = classifierBoard([], "standup");
  await sb2.start();
  expect(await sb2.send("Catch me up on what the team has been doing.")).toStartWith("Getting status from the team.");
});

test("classifier prompt demands a group reference for rollcall/standup", async () => {
  // Live misfire 2026-07-07: "Quick check: say ready if you can hear me."
  // hit the CONTROLISH prefilter ("check") and gemma labeled it rollcall.
  const calls: string[] = [];
  const { sb, prompts } = classifierBoard(calls, "none");
  await sb.start();
  await sb.send("Quick check: say ready if you can hear me.");
  expect(prompts.length).toBe(1);
  expect(prompts[0]).toContain("require the WHOLE GROUP");
});

test("transfer briefs the new employee on the last exchange", async () => {
  const calls: string[] = [];
  const injected: Record<string, string[]> = { coder: [], think: [] };
  const lanes: Record<string, LaneDef> = {
    coder: { brain: { ...fakeBrain("coder", calls), injectContext: (c: string) => injected.coder.push(c) }, aliases: ["the coder"], voice: "v1" },
    think: { brain: { ...fakeBrain("think", calls), injectContext: (c: string) => injected.think.push(c) }, voice: "v2" },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", calls), lanes);
  await sb.start();
  await sb.send("How do I fix the parser?");            // front desk answers
  await sb.send("Let me talk to the coder.");           // transfer → briefing
  expect(injected.coder.some((c) => c.includes("Handoff from Cicero") && c.includes("How do I fix the parser?"))).toBe(true);
  await sb.send("Refactor it then.");                   // coder exchange
  await sb.send("Switch to think.");                    // second hop → briefed on coder talk
  expect(injected.think.some((c) => c.includes("Handoff from coder") && c.includes("Refactor it then."))).toBe(true);
});

test("voicemail is delivered into the lane's context and confirmed", async () => {
  const calls: string[] = [];
  const injected: string[] = [];
  const lanes: Record<string, LaneDef> = {
    coder: { brain: { ...fakeBrain("coder", calls), injectContext: (c: string) => injected.push(c) }, aliases: ["the coder"] },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", calls), lanes);
  await sb.start();
  const ack = await sb.send("Leave a message for the coder: ship the parser fix tonight, please.");
  expect(ack).toBe("I'll pass that along to the Coder.");
  expect(injected.some((c) => c.includes("ship the parser fix tonight, please."))).toBe(true);
  expect(calls).not.toContain("coder:start"); // a voicemail doesn't wake anyone
  expect(await sb.send("Take a note for the manager: hello")).toContain("I don't have a line to manager");
});

test("a bare name as the whole utterance transfers (the correction flow)", async () => {
  const calls: string[] = [];
  const lanes: Record<string, LaneDef> = {
    think: { brain: fakeBrain("think", calls), aliases: ["the thinker", "strange"], greeting: "Strange. Ask your question." },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", calls), lanes);
  await sb.start();
  // Live miss 2026-07-07: STT heard "Thank", user corrected with just "Think."
  expect(await sb.send("Think.")).toBe("Strange. Ask your question.");
  expect(await sb.send("Back to Cicero.")).toContain("Back");
  expect(await sb.send("Strange")).toBe("Strange. Ask your question.");
});

test("bare common words do NOT transfer", async () => {
  const calls: string[] = [];
  const lanes: Record<string, LaneDef> = {
    coder: { brain: fakeBrain("coder", calls), aliases: ["stark"] },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", calls), lanes);
  await sb.start();
  expect(await sb.send("Start.")).toBe("front reply"); // one edit from stark — must not route
  expect(await sb.send("I think so.")).toBe("front reply");
});

test("fuzzy lane resolution catches STT mishears in transfer phrases", async () => {
  const calls: string[] = [];
  const lanes: Record<string, LaneDef> = {
    think: { brain: fakeBrain("think", calls), greeting: "Strange here." },
    coder: { brain: fakeBrain("coder", calls) },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", calls), lanes);
  await sb.start();
  expect(await sb.send("Can I talk to Thank?")).toBe("Strange here.");
});

test("front desk replying a magic phrase executes it instead of reciting it", async () => {
  const calls: string[] = [];
  const front = { ...fakeBrain("front", calls), send: async () => "status from everyone" };
  const lanes: Record<string, LaneDef> = {
    coder: { brain: fakeBrain("coder", calls), voice: "v1" },
  };
  const sb = new SwitchboardBrain(front, lanes);
  await sb.start();
  await sb.send("Talk to the coder."); // start the lane so standup queries it
  await sb.send("Back to Cicero.");
  const out = await sb.send("Yes, pull them and let them respond.");
  expect(out).not.toBe("status from everyone");
  expect(out).toContain("Getting status from the team.");
  expect(sb.wasControlTurn()).toBe(true);
});

test("roll call uses working names (first alias), not lane ids", async () => {
  const calls: string[] = [];
  const lanes = {
    coder: { brain: fakeBrain("coder", calls), aliases: ["ada", "the coder"], voice: "ada" },
    qa: { brain: fakeBrain("qa", calls), aliases: ["quinn", "quality assurance"], voice: "quinn" },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", calls), lanes);
  const reply = (await sb.send("Roll call.")).trim();
  expect(reply).toBe("Ada checking in. Quinn checking in.");
});

test("'pass me to' / 'patch me to' / 'hand me to' transfer (the Quinn miss)", async () => {
  const calls: string[] = [];
  const lanes = {
    qa: { brain: fakeBrain("qa", calls), aliases: ["quinn", "quality assurance"], voice: "quinn", greeting: "Heya!" },
  };
  for (const phrase of ["Can you pass me to Quinn?", "Patch me through to Quinn.", "Hand me over to Quinn please."]) {
    const sb = new SwitchboardBrain(fakeBrain("front", calls), lanes);
    const reply = await sb.send(phrase);
    expect(sb.activeLane()).toBe("qa");
    expect(reply).toContain("Heya!");
  }
});

test("'pass' in ordinary sentences does not transfer", async () => {
  const calls: string[] = [];
  const lanes = {
    qa: { brain: fakeBrain("qa", calls), aliases: ["quinn"], voice: "quinn" },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", calls), lanes);
  await sb.send("Did the tests pass me anything useful?");
  expect(sb.activeLane()).toBe(null);
});

test("transferTo pins a lane by name or alias and returns the working name", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  expect(await sb.transferTo("sage")).toBeNull(); // not on this board
  expect(sb.activeLane()).toBeNull();
  expect(await sb.transferTo("code guy")).toBe("the Coder");
  expect(sb.activeLane()).toBe("coder");
  expect(calls).toContain("coder:start");
  // next turn goes to the pinned lane, exactly like a spoken transfer
  expect(await sb.send("how's the build")).toBe("coder reply");
});

test("transferTo returns null when the lane won't start — pin never takes", async () => {
  const calls: string[] = [];
  const sb = board(calls, { coder: { failStart: true } });
  expect(await sb.transferTo("coder")).toBeNull();
  expect(sb.activeLane()).toBeNull();
});

test("transferTo caller cancellation cannot pin a lane after a late start", async () => {
  const calls: string[] = [];
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  const worker: Brain = {
    ...fakeBrain("worker", calls),
    start: () => startGate,
  };
  const sb = new SwitchboardBrain(fakeBrain("front", calls), { worker: { brain: worker } });
  const caller = new AbortController();

  const transfer = sb.transferTo("worker", undefined, { signal: caller.signal });
  void transfer.catch(() => {});
  await Bun.sleep(0);
  caller.abort(new Error("superseded dial-back"));

  await expect(transfer).rejects.toThrow("superseded dial-back");
  releaseStart();
  await Bun.sleep(0);
  expect(sb.activeLane()).toBeNull();
  // The revealing turn: checking only the instant after startup missed that a
  // cancelled programmatic transfer could still be adopted by whatever the
  // operator said next. transferTo's signal is documented to prevent a LATE
  // pin, not merely to abandon its own turn.
  expect(await sb.send("hello?")).toBe("front reply");
  expect(sb.activeLane()).toBeNull();
  await sb.stop();
});

test("'back to jarvis' releases a pin like 'back to cicero'", async () => {
  for (const phrase of ["back to jarvis", "jarvis come back", "okay back to jarvis please"]) {
    const calls: string[] = [];
    const sb = board(calls);
    await sb.transferTo("coder");
    expect(await sb.send(phrase)).toBe("Back with you.");
    expect(sb.activeLane()).toBeNull();
  }
});

test("transferTo briefs the lane before it picks up; a failing brief never blocks", async () => {
  const calls: string[] = [];
  const injected: string[] = [];
  const lanes: Record<string, LaneDef> = {
    coder: {
      brain: { ...fakeBrain("coder", calls), injectContext: (c: string) => injected.push(c) },
      aliases: ["ada"],
    },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", calls), lanes);
  const briefed: string[] = [];
  expect(await sb.transferTo("ada", async (lane) => { briefed.push(lane); return "calling about task t_1"; })).toBe("Ada");
  expect(briefed).toEqual(["coder"]); // brief sees the resolved lane id, not the alias
  expect(injected).toEqual(["calling about task t_1"]);
  // a brief that throws is swallowed — the transfer still lands
  const sb2 = new SwitchboardBrain(fakeBrain("front", calls), {
    coder: { brain: fakeBrain("coder", calls), aliases: ["ada"] },
  });
  expect(await sb2.transferTo("ada", async () => { throw new Error("board down"); })).toBe("Ada");
});

test("classifier-labeled standup/rollcall without a group word is ignored", async () => {
  const calls: string[] = [];
  const lanes: Record<string, LaneDef> = {
    coder: { brain: fakeBrain("coder", calls), aliases: ["ada"] },
  };
  // classifier hallucinates "standup" for a bare status question
  const sb = new SwitchboardBrain(fakeBrain("front", calls), lanes, async () => "standup");
  await sb.transferTo("ada");
  expect(await sb.send("what's the status?")).toBe("coder reply"); // normal turn for the pinned lane
  // with a real group reference the label is honored
  const sb2 = new SwitchboardBrain(fakeBrain("front", calls), lanes, async () => "standup");
  const out = await sb2.send("status from everyone please");
  expect(out).toContain("Getting status from the team.");
});

test("classifier rollcall with the literal phrase but no group word is honored (2026-07-12 live miss)", async () => {
  // "roll call" IS the action's name — the group-word guard must not discard
  // a label the caller literally spoke. Both phrasings failed live.
  for (const c of ["Yes, that's what I just said, roll call.", "Yes, initiate roll call."]) {
    const calls: string[] = [];
    const { sb } = classifierBoard(calls, "rollcall");
    await sb.start();
    expect(await sb.send(c)).toContain("checking in.");
    expect(sb.wasControlTurn()).toBe(true);
  }
});

test("classifier-labeled bare group-action names are ignored (2026-07-30 live regression)", async () => {
  for (const [utterance, label] of [
    ["The roll call.", "rollcall"],
    ["the standup.", "standup"],
  ] as const) {
    const calls: string[] = [];
    const { sb } = classifierBoard(calls, label);
    await sb.start();
    expect(await sb.send(utterance)).toBe("front reply");
    expect(sb.wasControlTurn()).toBe(false);
  }
});

test("a refused classifier rollcall cannot return through the front-desk reply", async () => {
  const calls: string[] = [];
  const lanes: Record<string, LaneDef> = {
    coder: { brain: fakeBrain("coder", calls) },
    think: { brain: fakeBrain("think", calls) },
  };
  const sb = new SwitchboardBrain(magicRollcallFront(calls), lanes, async () => "rollcall");
  await sb.start();

  expect(await sb.send("The roll call.")).toBe("roll call");
  expect(sb.wasControlTurn()).toBe(false);
  expect(calls.some((call) => call.startsWith("coder:send:") || call.startsWith("think:send:"))).toBe(false);
});

test("a refused classifier rollcall cannot return through a streamed front-desk reply", async () => {
  const calls: string[] = [];
  const lanes: Record<string, LaneDef> = {
    coder: { brain: fakeBrain("coder", calls) },
    think: { brain: fakeBrain("think", calls) },
  };
  const sb = new SwitchboardBrain(magicRollcallFront(calls, true), lanes, async () => "rollcall");
  await sb.start();
  let out = "";
  for await (const chunk of sb.sendStream("The roll call.")) out += chunk;

  expect(out).toBe("roll call");
  expect(sb.wasControlTurn()).toBe(false);
  expect(calls.some((call) => call.startsWith("coder:send:") || call.startsWith("think:send:"))).toBe(false);
});

test("a streamed front-desk rollcall reply still promotes when nothing was refused", async () => {
  // The positive twin of the streaming refusal above, and it earns its place:
  // wedging the streaming path into a permanently-refused state broke no test
  // without it, so the promotion that path is supposed to perform had no cover
  // at all.
  const calls: string[] = [];
  const lanes: Record<string, LaneDef> = {
    coder: { brain: fakeBrain("coder", calls) },
    think: { brain: fakeBrain("think", calls) },
  };
  const sb = new SwitchboardBrain(magicRollcallFront(calls, true), lanes, async () => "none");
  await sb.start();
  let out = "";
  for await (const chunk of sb.sendStream("Check whether they should respond.")) out += chunk;

  expect(out).toBe("Coder checking in. Think checking in.");
  expect(sb.wasControlTurn()).toBe(true);
});

test("a front-desk rollcall reply still promotes when no classifier label was refused", async () => {
  const calls: string[] = [];
  const lanes: Record<string, LaneDef> = {
    coder: { brain: fakeBrain("coder", calls) },
    think: { brain: fakeBrain("think", calls) },
  };
  let classifications = 0;
  const sb = new SwitchboardBrain(
    magicRollcallFront(calls),
    lanes,
    async () => classifications++ === 0 ? "none" : "rollcall",
  );
  await sb.start();

  expect(await sb.send("Check whether they should respond.")).toBe("Coder checking in. Think checking in.");
  expect(sb.wasControlTurn()).toBe(true);
  expect(await sb.send("The roll call.")).toBe("roll call");
  expect(sb.wasControlTurn()).toBe(false);
});

test("a dial-back veto also blocks a front-desk group-action reply", async () => {
  const calls: string[] = [];
  const lanes: Record<string, LaneDef> = {
    coder: { brain: fakeBrain("coder", calls) },
    think: { brain: fakeBrain("think", calls) },
  };
  const sb = new SwitchboardBrain(magicRollcallFront(calls), lanes, async () => "rollcall");
  await sb.start();

  expect(await sb.send("Have everyone call me back.")).toBe("roll call");
  expect(sb.wasControlTurn()).toBe(false);
});

test("a refused group action does not suppress a front-desk trigger on a later turn", async () => {
  const calls: string[] = [];
  const lanes: Record<string, LaneDef> = {
    coder: { brain: fakeBrain("coder", calls) },
    think: { brain: fakeBrain("think", calls) },
  };
  const sb = new SwitchboardBrain(magicRollcallFront(calls), lanes, async () => "rollcall");
  await sb.start();

  expect(await sb.send("The roll call.")).toBe("roll call");
  expect(await sb.send("Hello.")).toBe("Coder checking in. Think checking in.");
  expect(sb.wasControlTurn()).toBe(true);
});

test("classifier group-action request framing distinguishes commands from ambiguous bare verbs", async () => {
  const requests = [
    ["run the roll call", "rollcall"],
    ["do the roll call", "rollcall"],
    ["start a roll call", "rollcall"],
    ["begin roll call", "rollcall"],
    ["initiate the roll call", "rollcall"],
    ["hold a roll call", "rollcall"],
    ["have the roll call", "rollcall"],
    ["have a roll call", "rollcall"],
    ["take a roll call", "rollcall"],
    ["I'd like a roll call", "rollcall"],
    ["I need a roll call", "rollcall"],
    ["give me a roll call", "rollcall"],
    ["let's have the standup", "standup"],
    ["Right, standup", "standup"],
    ["That's what I said: standup", "standup"],
  ] as const;
  for (const [utterance, label] of requests) {
    const calls: string[] = [];
    const { sb } = classifierBoard(calls, label);
    await sb.start();
    const reply = await sb.send(utterance);
    expect(label === "rollcall" ? reply.includes("checking in.") : reply.startsWith("Getting status from the team.")).toBe(true);
    expect(sb.wasControlTurn()).toBe(true);
  }
  for (const utterance of [
    "have roll call me back",
    "take roll call off my hands",
  ]) {
    const calls: string[] = [];
    const { sb } = classifierBoard(calls, "rollcall");
    await sb.start();
    expect(await sb.send(utterance)).toBe("front reply");
    expect(sb.wasControlTurn()).toBe(false);
  }
});

test("classifier group-action evidence yields to dial-back readings and requires a named confirmation", async () => {
  for (const utterance of [
    "yes, check on that",
    "right, transfer the status",
    "yeah, check the build",
  ]) {
    const calls: string[] = [];
    const { sb } = classifierBoard(calls, "rollcall");
    await sb.start();
    expect(await sb.send(utterance)).toBe("front reply");
    expect(sb.wasControlTurn()).toBe(false);
  }
  const calls: string[] = [];
  const { sb } = classifierBoard(calls, "rollcall");
  await sb.start();
  expect(await sb.send("have everyone call me back")).toBe("front reply");
  expect(sb.wasControlTurn()).toBe(false);
});

test("'do another roll call' matches lexically — no classifier round-trip", async () => {
  const calls: string[] = [];
  const { sb, prompts } = classifierBoard(calls, "none");
  await sb.start();
  expect(await sb.send("Wait, do another roll call?")).toContain("checking in.");
  expect(prompts).toHaveLength(0);
});

test("bare 'again' after a roll call repeats it", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  expect(await sb.send("roll call")).toContain("checking in.");
  for (const c of ["Again.", "Do it again.", "One more time, please."]) {
    expect(await sb.send(c)).toContain("checking in.");
    expect(sb.wasControlTurn()).toBe(true);
  }
});

test("bare 'again' after a standup repeats the standup", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  expect(await sb.send("status from everyone")).toContain("Getting status from the team.");
  expect(await sb.send("again")).toContain("Getting status from the team.");
});

test("a normal turn in between ends the 'again' context", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  await sb.send("roll call");
  expect(await sb.send("What do you think about the weather?")).toBe("front reply");
  expect(await sb.send("again")).toBe("front reply"); // brain turn, not a roll call
});

// --- sendBackground: scheduled/unattended turns (2026-07-12) ---

test("sendBackground without a lane reaches the front desk even while a lane is pinned", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  await sb.send("talk to the coder");
  expect(sb.activeLane()).toBe("coder");

  expect(await sb.sendBackground("draft today's ideas")).toBe("front reply");
  expect(calls).toContain("front:send:draft today's ideas");
  expect(sb.activeLane()).toBe("coder"); // the pinned line never moved
});

test("sendBackground skips the control plane — 'roll call' is just words in a prompt", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  expect(await sb.sendBackground("roll call")).toBe("front reply");
  expect(calls).toContain("front:send:roll call");
  expect(calls.filter((c) => c.includes(":start"))).toEqual(["front:start"]); // no lane woke up
});

test("sendBackground with a lane cold-starts it, installs the persona once, and never pins it", async () => {
  const calls: string[] = [];
  const injected: string[] = [];
  const brain = { ...fakeBrain("coder", calls), injectContext: (context: string) => injected.push(context) };
  const sb = new SwitchboardBrain(fakeBrain("front", calls), {
    coder: { brain, persona: "Speak as Ada." },
  });
  await sb.start();

  expect(await sb.sendBackground("research the web", { lane: "coder" })).toBe("coder reply");
  expect(calls).toContain("coder:start");
  expect(calls).toContain("coder:send:research the web");
  expect(injected).toEqual(["Speak as Ada."]);
  expect(sb.activeLane()).toBeNull(); // background work never moves the pinned line

  // Warm lane on the second day: no restart, no second persona install.
  await sb.sendBackground("research again", { lane: "coder" });
  expect(calls.filter((c) => c === "coder:start").length).toBe(1);
  expect(injected).toEqual(["Speak as Ada."]);
});

test("a named-lane background turn delivers systemContext and never rejects a lane-less brain", async () => {
  // The lane path routes through def.brain.send() directly (never sendUnattended),
  // so a lane brain WITHOUT sendBackground handles a background turn fine, and the
  // routing-only `lane` field is a harmless extra property on the send() options.
  // This pins both: no spurious lane rejection, and the operational snapshot
  // (systemContext) reaches the employee running the background turn.
  const calls: string[] = [];
  let seen: string | undefined = "UNSET";
  const brain: Brain = {
    ...fakeBrain("coder", calls),
    send: async (m: string, options?: BrainTurnOptions) => {
      calls.push(`coder:send:${m}`);
      seen = options?.systemContext;
      return "coder reply";
    },
  };
  const sb = new SwitchboardBrain(fakeBrain("front", calls), { coder: { brain } });
  await sb.start();

  expect(await sb.sendBackground("do it", { lane: "coder", systemContext: "OP-STATE" })).toBe("coder reply");
  expect(seen).toBe("OP-STATE");
});

test("sendBackground on an unknown lane is an error, not a silent front-desk answer", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  expect(sb.sendBackground("p", { lane: "nope" })).rejects.toThrow(/unknown lane "nope"/);
});

test("sendBackground surfaces a lane start failure instead of retrying forever", async () => {
  const calls: string[] = [];
  const sb = board(calls, { coder: { failStart: true } });
  await sb.start();
  expect(settlesWithin(sb.sendBackground("p", { lane: "coder" }), "background turn")).rejects.toThrow(/coder down/);
});

test("concurrent stop() calls share one in-flight primary stop, and a failed stop stays retryable", async () => {
  let stops = 0;
  let failStop = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const front: Brain = {
    ...fakeBrain("front", []),
    stop: async () => {
      stops += 1;
      await gate;
      if (failStop) throw new Error("stop failed");
    },
  };
  const sb = new SwitchboardBrain(front, { worker: { brain: fakeBrain("worker", []) } });
  await sb.start();

  failStop = true;
  const first = sb.stop();
  const second = sb.stop();
  release();
  // stop() itself never rejects (cleanup is allSettled) — the leaf invocation
  // count is the observable: both callers must have shared one stop.
  await settlesWithin(Promise.all([first, second]), "both stops");
  expect(stops).toBe(1);

  // The shared failure must not latch — a later stop() runs the leaf stop again.
  failStop = false;
  await settlesWithin(sb.stop(), "retried stop");
  expect(stops).toBe(2);
});

test("a retried start() recovers the switchboard after a failed primary start", async () => {
  let fail = true;
  const front: Brain = {
    ...fakeBrain("front", []),
    start: async () => { if (fail) throw new Error("front down"); },
  };
  const sb = new SwitchboardBrain(front, { worker: { brain: fakeBrain("worker", []) } });
  await expect(sb.start()).rejects.toThrow("front down");

  fail = false;
  await settlesWithin(sb.start(), "retried start");
  expect(await sb.send("hello")).toBe("front reply");
});

test("a retried restart() recovers the switchboard after a failed primary restart", async () => {
  let fail = false;
  const front: Brain = {
    ...fakeBrain("front", []),
    restart: async () => { if (fail) throw new Error("restart failed"); },
  };
  const sb = new SwitchboardBrain(front, { worker: { brain: fakeBrain("worker", []) } });
  await sb.start();

  fail = true;
  await expect(sb.restart()).rejects.toThrow("restart failed");
  await expect(sb.send("closed")).rejects.toThrow("switchboard is stopping");

  fail = false;
  await settlesWithin(sb.restart(), "retried restart");
  expect(await sb.send("hello")).toBe("front reply");
});

test("spoken 'call me' rings the dial-back handler instead of the brain", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  const rang: Array<string | undefined> = [];
  sb.setCallMeHandler(async (who) => { rang.push(who); return who ? `Ringing you now — ${who} will pick up.` : "Ringing you now."; });
  await sb.start();
  expect(await sb.send("call me")).toBe("Ringing you now.");
  expect(await sb.send("Hey Jarvis, ring me please!")).toBe("Ringing you now.");
  expect(rang).toEqual([undefined, undefined]);
  expect(calls.filter((c) => c.startsWith("front:send"))).toEqual([]);
});

test("spoken 'have <employee> call me' names who picks up and beats the transfer pattern", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  const rang: Array<string | undefined> = [];
  sb.setCallMeHandler(async (who) => { rang.push(who); return "ack"; });
  await sb.start();
  await sb.send("have coder call me");
  expect(rang).toEqual(["coder"]);
  expect(sb.activeLane()).toBeNull(); // the handler owns any pinning, not PIN_RE
});

test("call-ish sentences and unset handlers still reach the brain", async () => {
  const calls: string[] = [];
  const sb = board(calls);
  await sb.start();
  // no handler installed: the intent must fall through untouched
  expect(await sb.send("call me")).toBe("front reply");
  const rang: Array<string | undefined> = [];
  sb.setCallMeHandler(async (who) => { rang.push(who); return "ack"; });
  // not a dial-back: trailing clause keeps it a normal sentence
  expect(await sb.send("call me when the build is done")).toBe("front reply");
  expect(rang).toEqual([]);
});

test("classifier fallback dials back when the lexical pattern misses", async () => {
  // "I want you to call me" (live miss 2026-07-13) matches no pattern; the
  // small-model fallback must carry it, exactly like typed Telegram does.
  const prompts: string[] = [];
  const classifier = async (prompt: string) => { prompts.push(prompt); return "callme"; };
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    coder: { brain: fakeBrain("coder", []) },
  }, classifier);
  const rang: Array<string | undefined> = [];
  sb.setCallMeHandler(async (who) => { rang.push(who); return "Ringing you now."; });
  await sb.start();
  expect(await sb.send("I want you to call me")).toBe("Ringing you now.");
  expect(rang).toEqual([undefined]);
  expect(prompts[0]).toContain("callme");
});

test("classifier callme:<employee> routes the named pickup", async () => {
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    coder: { brain: fakeBrain("coder", []) },
  }, async () => "callme:coder");
  const rang: Array<string | undefined> = [];
  sb.setCallMeHandler(async (who) => { rang.push(who); return "Ringing."; });
  await sb.start();
  expect(await sb.send("I need the coder to phone me")).toBe("Ringing.");
  expect(rang).toEqual(["coder"]);
});

test("a classifier dial-back survives its own handler pinning the lane", async () => {
  // Live incident 2026-07-30: "I can't talk to Rick have him call mw" routed to
  // callme:think, the phone rang and the lane was pinned — then the user got
  // "(Cicero unreachable: switchboard turn superseded by a newer accepted
  // turn)" instead of the ack. The real daemon handler calls transferTo() to
  // decide who picks up, and that is itself a public turn, so it superseded
  // the very turn that invoked it. Every other dial-back test uses an inert
  // handler, which is why nothing caught it. A control action delegating to
  // another public entry point must not cancel its own caller.
  const calls: string[] = [];
  const sb = new SwitchboardBrain(fakeBrain("front", calls), {
    think: { brain: fakeBrain("think", calls) },
  }, async () => "callme:think");
  sb.setCallMeHandler(async (who) => {
    const name = await sb.transferTo(who ?? "think");
    return `Ringing you now — ${name} will pick up.`;
  });
  try {
    await sb.start();
    expect(await sb.send("I can't talk to Rick have him call me")).toBe(
      "Ringing you now — Think will pick up.",
    );
    expect(sb.activeLane()).toBe("think");
  } finally {
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("a spoken dial-back survives its own handler pinning the lane", async () => {
  // Same defect on the lexical path: it reaches the daemon handler too, and
  // the outer runAcceptedTurn asserts the turn before it returns. Telegram's
  // typed "call me" masks this by intercepting before the brain, so voice is
  // where it bites.
  const calls: string[] = [];
  const sb = new SwitchboardBrain(fakeBrain("front", calls), {
    think: { brain: fakeBrain("think", calls) },
  });
  sb.setCallMeHandler(async (who) => {
    const name = await sb.transferTo(who ?? "think");
    return `Ringing you now — ${name} will pick up.`;
  });
  try {
    await sb.start();
    expect(await sb.send("have think call me")).toBe(
      "Ringing you now — Think will pick up.",
    );
  } finally {
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("a barge-in during a dial-back still supersedes the dialing turn", async () => {
  // The delegation window must be scoped to the handler's OWN async context.
  // A concurrent public turn is not delegation — it is the user interrupting,
  // and it has to take the lease. If it were allowed to adopt the dialing turn
  // instead, two utterances would share one lease and the barge-in would never
  // cancel the dial.
  const calls: string[] = [];
  const sb = new SwitchboardBrain(fakeBrain("front", calls), {
    think: { brain: fakeBrain("think", calls) },
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  sb.setCallMeHandler(async () => {
    await held;
    return "Ringing you now.";
  });
  try {
    await sb.start();
    const dialing = sb.send("call me");
    await Bun.sleep(5); // let the turn reach the held handler
    const bargeIn = sb.send("actually never mind");
    expect(await settlesWithin(bargeIn, "barge-in")).toBe("front reply");
    release();
    await expect(dialing).rejects.toThrow("superseded by a newer accepted turn");
  } finally {
    release();
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("hallucinated callme labels are ignored without call vocabulary", async () => {
  // Mirror of the group-word guard: the classifier alone must never be able
  // to dial the user's phone from an utterance that mentions no call.
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    coder: { brain: fakeBrain("coder", []) },
  }, async () => "callme");
  const rang: Array<string | undefined> = [];
  sb.setCallMeHandler(async (who) => { rang.push(who); return "Ringing."; });
  await sb.start();
  // control-ish ("status report") so the classifier runs — but no call words
  expect(await sb.send("give me a status report on the build")).toBe("front reply");
  expect(rang).toEqual([]);
});

test("a dial-back leaves a memo so the persona can answer 'did you call me?'", async () => {
  // Live incident 2026-07-13: the phone rang, then the front desk flatly
  // denied having called — the control plane acted outside the brain's
  // context. The memo closes that gap for whoever answers the next turn.
  const calls: string[] = [];
  const injected = { front: [] as string[], coder: [] as string[] };
  const front = { ...fakeBrain("front", calls), injectContext: (c: string) => injected.front.push(c) };
  const coder = { ...fakeBrain("coder", calls), injectContext: (c: string) => injected.coder.push(c) };
  const sb = new SwitchboardBrain(front, { coder: { brain: coder } });
  sb.setCallMeHandler(async () => "Ringing you now.");
  try {
    await sb.start();
    await sb.send("call me");
    expect(injected.front).toEqual([]); // one-shot: rides the NEXT brain turn
    await sb.send("did you call me?");
    expect(injected.front.length).toBe(1);
    expect(injected.front[0]).toContain("phone was rung");
    expect(injected.coder).toEqual([]); // only whoever answers next hears it
  } finally {
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("classifier-routed dial-backs leave the same memo", async () => {
  const injected: string[] = [];
  const front = { ...fakeBrain("front", []), injectContext: (c: string) => injected.push(c) };
  const sb = new SwitchboardBrain(front, {
    coder: { brain: fakeBrain("coder", []) },
  }, async () => "callme:coder");
  sb.setCallMeHandler(async () => "Ringing.");
  try {
    await sb.start();
    expect(await sb.send("I need the coder to phone me")).toBe("Ringing.");
    await sb.send("thanks!");
    expect(injected.some((c) => c.includes("phone was rung"))).toBe(true);
  } finally {
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});

test("a speculative turn refuses the lexical dial-back instead of ringing", async () => {
  // The switchboard exposes setCallMeHandler, so createBrain does NOT wrap it
  // in DialBackBrain — its refusal never runs on a lane setup. Without this,
  // a speculative "call me" spools a callback the final utterance cannot
  // retract (Codex merge review, 2026-07-28).
  const rang: Array<string | undefined> = [];
  const sb = board([]);
  sb.setCallMeHandler(async (who) => { rang.push(who); return "Ringing you now."; });
  await sb.start();
  expect(sb.send("call me", { speculative: true })).rejects.toThrow(SpeculativeSideEffectError);
  await Bun.sleep(5);
  expect(rang).toEqual([]);
  // No memo either: nothing was rung, so the next turn must not be told it was.
  const injected: string[] = [];
  const front = { ...fakeBrain("front", []), injectContext: (c: string) => injected.push(c) };
  const sb2 = new SwitchboardBrain(front, { coder: { brain: fakeBrain("coder", []) } });
  sb2.setCallMeHandler(async () => "Ringing.");
  await sb2.start();
  await sb2.send("call me", { speculative: true }).catch(() => { /* expected */ });
  await sb2.send("what's up?");
  expect(injected).toEqual([]);
});

test("a speculative turn refuses the classifier dial-back too", async () => {
  // The classifier path passed no options at all, so it was the wider hole of
  // the two — "phone me now" reaches it without matching any pattern.
  const sb = new SwitchboardBrain(fakeBrain("front", []), {
    coder: { brain: fakeBrain("coder", []) },
  }, async () => "callme");
  const rang: Array<string | undefined> = [];
  sb.setCallMeHandler(async (who) => { rang.push(who); return "Ringing."; });
  await sb.start();
  expect(sb.send("I want you to phone me", { speculative: true }))
    .rejects.toThrow(SpeculativeSideEffectError);
  await Bun.sleep(5);
  expect(rang).toEqual([]);
});

test("the speculative refusal reaches sendStream, the speculator's own entry point", async () => {
  const sb = board([]);
  const rang: Array<string | undefined> = [];
  sb.setCallMeHandler(async (who) => { rang.push(who); return "Ringing."; });
  await sb.start();
  await expect((async () => {
    for await (const _chunk of sb.sendStream("call me", { speculative: true })) { /* drain */ }
  })()).rejects.toThrow(SpeculativeSideEffectError);
  expect(rang).toEqual([]);
});

test("both dial sites hand the handler the turn signal and nothing more", async () => {
  // Guards against re-introducing the regression this PR briefly shipped:
  // forwarding the whole turn options to the handler. The refusal above the
  // dial needs `options`; the handler gets ONLY `{ signal }` so a cancelled
  // turn stops the dial-back's own work without leaking `speculative` (which
  // would make the handler refuse a dial the site already approved).
  // Both sites now match: the classifier path used to withhold the signal
  // because the handler's transferTo() re-entry superseded the turn — the
  // delegation window fixes that cause, so it no longer has to.
  const seen: Array<{ who?: string; keys: string[] }> = [];
  const lexical = board([]);
  lexical.setCallMeHandler(async (who, options) => {
    seen.push({ who, keys: Object.keys(options ?? {}) });
    return "Ringing.";
  });
  await lexical.start();
  expect(await lexical.send("call me")).toBe("Ringing.");

  const classified = new SwitchboardBrain(fakeBrain("front", []), {
    coder: { brain: fakeBrain("coder", []) },
  }, async () => "callme:coder");
  classified.setCallMeHandler(async (who, options) => {
    seen.push({ who, keys: Object.keys(options ?? {}) });
    return "Ringing.";
  });
  await classified.start();
  expect(await classified.send("I need the coder to phone me")).toBe("Ringing.");

  expect(seen).toEqual([
    { who: undefined, keys: ["signal"] }, // lexical: the turn signal, nothing else
    { who: "coder", keys: ["signal"] },   // classifier: the same, no more
  ]);
});

test("release and roll call leave memos — the front desk knows what it missed", async () => {
  const calls: string[] = [];
  const injected = { front: [] as string[], coder: [] as string[] };
  const front = { ...fakeBrain("front", calls), injectContext: (c: string) => injected.front.push(c) };
  const coder = { ...fakeBrain("coder", calls), injectContext: (c: string) => injected.coder.push(c) };
  const sb = new SwitchboardBrain(front, { coder: { brain: coder } });
  try {
    await sb.start();
    await sb.send("switch to coder");
    expect(injected.front).toEqual([]); // the transfer itself needs no memo
    await sb.send("how is the build going?");
    await sb.send("Thanks, back to you.");
    await sb.send("anything I should know?");
    expect(injected.front.length).toBe(1);
    expect(injected.front[0].toLowerCase()).toContain("coder");
    // the memo carries the tail of the lane conversation, not just its existence
    expect(injected.front[0]).toContain("how is the build going?");
    expect(injected.front[0]).toContain("coder reply");
    await sb.send("roll call");
    await sb.send("thanks everyone");
    expect(injected.front.length).toBe(2);
    expect(injected.front[1]).toContain("roll call");
  } finally {
    await sb.stop().catch(() => { /* test cleanup */ });
  }
});
