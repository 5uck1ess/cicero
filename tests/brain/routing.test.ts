import { test, expect } from "bun:test";
import { RoutingBrain, DEFAULT_TRIGGERS } from "../../src/brain/routing";
import type { Brain } from "../../src/types";

function fakeBrain(name: string, calls: string[], opts: { failStart?: boolean; stream?: boolean } = {}): Brain {
  const brain: Brain = {
    start: async () => { if (opts.failStart) throw new Error(`${name} start failed`); calls.push(`${name}:start`); },
    stop: async () => { calls.push(`${name}:stop`); },
    send: async (m: string) => { calls.push(`${name}:send:${m}`); return `${name} reply`; },
    injectContext: (c: string) => { calls.push(`${name}:inject:${c}`); },
    restart: async () => { calls.push(`${name}:restart`); },
    health: async () => true,
  };
  if (opts.stream) {
    brain.sendStream = async function* (m: string) { calls.push(`${name}:stream:${m}`); yield `${name} `; yield "streamed"; };
  }
  return brain;
}

test("plain turns go to the primary; trigger phrases go to the think lane", async () => {
  const calls: string[] = [];
  const r = new RoutingBrain(fakeBrain("fast", calls), fakeBrain("think", calls));
  await r.start();
  expect(await r.send("what time is it")).toBe("fast reply");
  expect(await r.send("Think hard about the schema design")).toBe("think reply");
  expect(calls).toContain("fast:send:what time is it");
  expect(calls).toContain("think:send:Think hard about the schema design");
});

test("sendStream routes the same way and falls back to send for non-streaming lanes", async () => {
  const calls: string[] = [];
  const r = new RoutingBrain(fakeBrain("fast", calls, { stream: true }), fakeBrain("think", calls));
  await r.start();
  let out = "";
  for await (const c of r.sendStream("hello")) out += c;
  expect(out).toBe("fast streamed");
  out = "";
  for await (const c of r.sendStream("think deeply about entropy")) out += c;
  expect(out).toBe("think reply"); // think lane has no sendStream — one-chunk fallback
});

test("a dead think lane never routes — escalation phrases stay on the primary", async () => {
  const calls: string[] = [];
  const r = new RoutingBrain(fakeBrain("fast", calls), fakeBrain("think", calls, { failStart: true }));
  await r.start(); // does not throw
  expect(await r.send("think hard about this")).toBe("fast reply");
});

test("custom triggers replace the defaults", async () => {
  const calls: string[] = [];
  const r = new RoutingBrain(fakeBrain("fast", calls), fakeBrain("think", calls), ["ponder"]);
  await r.start();
  expect(await r.send("think hard about x")).toBe("fast reply");
  expect(await r.send("ponder the meaning of life")).toBe("think reply");
});

test("one-shot context reaches only the lane that receives the next turn", async () => {
  const calls: string[] = [];
  const r = new RoutingBrain(fakeBrain("fast", calls), fakeBrain("think", calls));
  await r.start();
  r.injectContext("ctx");
  await r.send("think hard about it");
  expect(calls).toContain("think:inject:ctx");
  expect(calls).not.toContain("fast:inject:ctx");

  r.injectContext("next");
  await r.send("ordinary turn");
  expect(calls).toContain("fast:inject:next");
  expect(calls).not.toContain("think:inject:next");

  await r.stop();
  expect(calls).toContain("fast:stop");
  expect(calls).toContain("think:stop");
});

test("default triggers include the obvious phrasings", () => {
  for (const t of ["think hard", "think deeply", "think carefully"]) {
    expect(DEFAULT_TRIGGERS).toContain(t);
  }
});

test("triggers quoted inside multi-line payloads (resume primers) never route", async () => {
  const calls: string[] = [];
  const r = new RoutingBrain(fakeBrain("fast", calls), fakeBrain("think", calls));
  await r.start();
  const primer = "Context restore:\nUser: think hard about X\nYou: sure\nReply with: ok";
  expect(await r.send(primer)).toBe("fast reply");
});

test("a trigger buried deep in a long sentence doesn't route", async () => {
  const calls: string[] = [];
  const r = new RoutingBrain(fakeBrain("fast", calls), fakeBrain("think", calls));
  await r.start();
  const long = "So anyway, after all of that back and forth about the release schedule I want you to think hard about it";
  expect(await r.send(long)).toBe("fast reply");
});
