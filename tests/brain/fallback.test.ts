import { test, expect } from "bun:test";
import { FallbackBrain } from "../../src/brain/fallback";
import type { Brain } from "../../src/types";

function fake(over: Partial<Brain> & { name?: string } = {}): Brain & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    start: async () => { calls.push("start"); },
    stop: async () => { calls.push("stop"); },
    send: async (m: string) => { calls.push(`send:${m}`); return `${over.name ?? "ok"}`; },
    injectContext: (c: string) => { calls.push(`ctx:${c}`); },
    restart: async () => { calls.push("restart"); },
    health: async () => true,
    ...over,
  };
}

async function drain(src: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of src) out.push(c);
  return out;
}

test("primary serves normally — fallbacks never start", async () => {
  const primary = fake({ name: "primary" });
  const backup = fake({ name: "backup" });
  const fb = new FallbackBrain([primary, backup], "qa");
  await fb.start();
  expect(await fb.send("hi")).toBe("primary");
  expect(backup.calls).toEqual([]); // lazy: not even started
});

test("primary failure falls to the backup with a spoken notice, once", async () => {
  const primary = fake({ send: async () => { throw new Error("plan exhausted"); } });
  const backup = fake({ name: "backup" });
  const fb = new FallbackBrain([primary, backup], "qa");
  expect(await fb.send("one")).toBe("On the backup line. backup");
  expect(await fb.send("two")).toBe("backup"); // same tier again — no repeat notice
  expect(backup.calls.filter((c) => c === "start").length).toBe(1);
});

test("recovered primary takes the next turn", async () => {
  let fail = true;
  const primary = fake({ send: async () => { if (fail) throw new Error("429"); return "primary"; } });
  const backup = fake({ name: "backup" });
  const fb = new FallbackBrain([primary, backup], "qa");
  expect(await fb.send("one")).toBe("On the backup line. backup");
  fail = false;
  expect(await fb.send("two")).toBe("primary"); // no "back online" chatter — just answers
});

test("stream: pre-output failure falls through; mid-stream failure surfaces", async () => {
  const dead = fake({
    sendStream: async function* (): AsyncIterable<string> { throw new Error("auth"); },
  });
  const backup = fake({
    sendStream: async function* () { yield "b1 "; yield "b2"; },
  });
  const fb = new FallbackBrain([dead, backup], "qa");
  expect(await drain(fb.sendStream("hi"))).toEqual(["On the backup line. ", "b1 ", "b2"]);

  const midDeath = fake({
    sendStream: async function* () { yield "partial "; throw new Error("boom"); },
  });
  const fb2 = new FallbackBrain([midDeath, backup], "qa");
  const got: string[] = [];
  await expect(async () => { for await (const c of fb2.sendStream("hi")) got.push(c); }).toThrow("boom");
  expect(got).toEqual(["partial "]); // backup never re-answers a half-spoken turn
});

test("all tiers dead: the last error surfaces", async () => {
  const a = fake({ send: async () => { throw new Error("a down"); } });
  const b = fake({ send: async () => { throw new Error("b down"); } });
  const fb = new FallbackBrain([a, b], "qa");
  await expect(fb.send("hi")).rejects.toThrow("b down");
});

test("context injected before a tier starts is replayed when it does", async () => {
  const primary = fake({ send: async () => { throw new Error("down"); } });
  const backup = fake({ name: "backup" });
  const fb = new FallbackBrain([primary, backup], "qa");
  fb.injectContext("remember me");
  await fb.send("hi");
  expect(primary.calls).toContain("ctx:remember me");
  expect(backup.calls).toContain("ctx:remember me");
  await fb.send("next");
  expect(backup.calls.filter((call) => call === "ctx:remember me")).toHaveLength(1);
});
