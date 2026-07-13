import { expect, test } from "bun:test";
import { DialBackBrain } from "../../src/brain/dial-back";
import type { Brain, BrainTurnOptions } from "../../src/types";

function inner(calls: string[]): Brain {
  return {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    restart: () => Promise.resolve(),
    health: () => Promise.resolve(true),
    injectContext: (context) => { calls.push(`context:${context}`); },
    send: async (message) => { calls.push(`send:${message}`); return `brain:${message}`; },
    sendStream: async function* (message) { calls.push(`stream:${message}`); yield `brain:${message}`; },
    streamProgress: async function* (message) { calls.push(`progress:${message}`); yield `progress:${message}`; },
    activeLane: () => "coder",
  };
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

test("dial-back intercepts batch, stream, and progress turns without consulting the brain", async () => {
  const calls: string[] = [];
  const brain = new DialBackBrain(inner(calls));
  const requests: Array<{ who?: string; options?: BrainTurnOptions }> = [];
  brain.setCallMeHandler(async (who, options) => {
    requests.push({ who, options });
    return who ? `Ringing — ${who} will pick up.` : "Ringing you now.";
  });

  expect(await brain.send("call me")).toBe("Ringing you now.");
  expect(await collect(brain.sendStream("have coder call me"))).toEqual(["Ringing — coder will pick up."]);
  expect(await collect(brain.streamProgress!("ring me please"))).toEqual(["Ringing you now."]);
  expect(requests.map((request) => request.who)).toEqual([undefined, "coder", undefined]);
  // no brain turns — but each ring leaves its coherence memo for the next one
  expect(calls.filter((c) => !c.startsWith("context:"))).toEqual([]);
  expect(calls.filter((c) => c.startsWith("context:"))).toHaveLength(3);
  expect(brain.wasControlTurn()).toBe(true);
});

test("ordinary turns and call-like sentences preserve the inner brain and its capabilities", async () => {
  const calls: string[] = [];
  const brain = new DialBackBrain(inner(calls));
  brain.setCallMeHandler(async () => "should not ring");

  expect(await brain.send("call me when the build is done")).toBe("brain:call me when the build is done");
  expect(await collect(brain.sendStream("hello"))).toEqual(["brain:hello"]);
  expect(await collect(brain.streamProgress!("work"))).toEqual(["progress:work"]);
  expect(await brain.sendBackground("call me")).toBe("brain:call me");
  expect(brain.activeLane!()).toBe("coder");
  expect(brain.wasControlTurn()).toBe(false);
  expect(calls).toEqual([
    "send:call me when the build is done",
    "stream:hello",
    "progress:work",
    "send:call me",
  ]);
});

test("semantic fallback reaches every backend but ignores unrelated and historical call talk", async () => {
  const calls: string[] = [];
  const prompts: string[] = [];
  const brain = new DialBackBrain(inner(calls), (prompt) => {
    prompts.push(prompt);
    if (prompt.includes("coder to phone me")) return Promise.resolve("call:coder");
    if (prompt.includes("did anyone call")) return Promise.resolve("none");
    return Promise.resolve("call");
  }, ["coder"]);
  const requests: Array<string | undefined> = [];
  brain.setCallMeHandler(async (who) => { requests.push(who); return "Ringing."; });

  expect(await brain.send("I want you to call me")).toBe("Ringing.");
  expect(await brain.send("I need the coder to phone me")).toBe("Ringing.");
  expect(await brain.send("did anyone call today?")).toBe("brain:did anyone call today?");
  expect(await brain.send("what is for dinner?")).toBe("brain:what is for dinner?");
  expect(requests).toEqual([undefined, "coder"]);
  expect(prompts).toHaveLength(3);
  expect(calls.filter((c) => !c.startsWith("context:"))).toEqual(["send:did anyone call today?", "send:what is for dinner?"]);
  expect(calls.filter((c) => c.startsWith("context:"))).toHaveLength(2); // one memo per ring

});

test("dial-back receives and honors per-turn cancellation", async () => {
  const brain = new DialBackBrain(inner([]));
  let observed: AbortSignal | undefined;
  brain.setCallMeHandler(async (_who, options) => {
    observed = options?.signal;
    return "Ringing you now.";
  });
  const controller = new AbortController();
  expect(await brain.send("call me", { signal: controller.signal })).toBe("Ringing you now.");
  expect(observed).toBe(controller.signal);

  controller.abort(new Error("superseded"));
  await expect(brain.send("call me", { signal: controller.signal })).rejects.toThrow("superseded");
});

test("semantic fallback cancellation cannot publish a late dial-back", async () => {
  let observed: AbortSignal | undefined;
  const brain = new DialBackBrain(inner([]), (_prompt, signal) => {
    observed = signal;
    return new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  let rang = false;
  brain.setCallMeHandler(async () => { rang = true; return "Ringing."; });
  const controller = new AbortController();

  const turn = brain.send("I want you to call me", { signal: controller.signal });
  await Bun.sleep(0);
  controller.abort(new Error("newer turn"));

  await expect(turn).rejects.toThrow("newer turn");
  expect(observed).toBe(controller.signal);
  expect(rang).toBe(false);
});

test("a dial-back leaves a one-shot memo so the brain can answer 'did you call me?'", async () => {
  // Lane-less deployments route "call me" through this wrapper, not the
  // switchboard — the coherence memo must exist here too.
  const calls: string[] = [];
  const brain = new DialBackBrain(inner(calls));
  brain.setCallMeHandler(async () => "Ringing you now.");
  expect(await brain.send("call me")).toBe("Ringing you now.");
  const memos = calls.filter((c) => c.startsWith("context:"));
  expect(memos.length).toBe(1);
  expect(memos[0]).toContain("phone was rung");
  // no dial-back, no memo
  expect(await brain.send("what time is it?")).toBe("brain:what time is it?");
  expect(calls.filter((c) => c.startsWith("context:")).length).toBe(1);
});
