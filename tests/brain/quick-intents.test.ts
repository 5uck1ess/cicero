import { test, expect } from "bun:test";
import { QuickIntentsBrain } from "../../src/brain/quick-intents";
import type { Brain } from "../../src/types";

function fakeBrain(calls: string[]): Brain {
  return {
    send: async (m: string) => { calls.push(m); return `brain: ${m}`; },
    start: async () => {}, stop: async () => {}, restart: async () => {},
    health: async () => true, injectContext: () => {},
  };
}

const NOON = () => new Date(2026, 6, 7, 12, 5);

test("phrase match answers instantly without a brain turn", async () => {
  const calls: string[] = [];
  const b = new QuickIntentsBrain(fakeBrain(calls), [
    { phrases: ["what time is it", "time check"], reply: "It's {time}." },
  ], NOON);
  expect(await b.send("What time is it?")).toMatch(/^It's 12:05/);
  expect(await b.send("Time check!")).toMatch(/^It's/);
  expect(calls).toEqual([]);
});

test("pattern match works; misses fall through untouched", async () => {
  const calls: string[] = [];
  const b = new QuickIntentsBrain(fakeBrain(calls), [
    { pattern: "^ping\\b", reply: "Pong." },
  ], NOON);
  expect(await b.send("ping the stack")).toBe("Pong.");
  expect(await b.send("please ping the server for me")).toBe("brain: please ping the server for me");
  expect(calls).toEqual(["please ping the server for me"]);
});

test("{date} expands; STT punctuation can't defeat a phrase", async () => {
  const b = new QuickIntentsBrain(fakeBrain([]), [
    { phrases: ["whats today"], reply: "Today is {date}." },
  ], NOON);
  expect(await b.send("What's today?")).toContain("July 7");
});

test("reply variants pick one option and still expand templates", async () => {
  const calls: string[] = [];
  const b = new QuickIntentsBrain(fakeBrain(calls), [
    { phrases: ["time check"], reply: ["First {time}.", "Second {date}.", "Third."] },
  ], NOON, () => 0.5);
  expect(await b.send("time check")).toContain("July 7");
  expect(calls).toEqual([]);
});

test("empty reply variant lists are disabled and fall through", async () => {
  const calls: string[] = [];
  const b = new QuickIntentsBrain(fakeBrain(calls), [
    { phrases: ["status"], reply: [] },
  ], NOON);
  expect(await b.send("status")).toBe("brain: status");
  expect(calls).toEqual(["status"]);
});

test("invalid regex disables only that entry; stream path yields the hit", async () => {
  const calls: string[] = [];
  const b = new QuickIntentsBrain(fakeBrain(calls), [
    { pattern: "([bad", reply: "never" },
    { phrases: ["status"], reply: "All green." },
  ], NOON);
  const chunks: string[] = [];
  for await (const c of b.sendStream("Status.")) chunks.push(c);
  expect(chunks).toEqual(["All green."]);
  expect(await b.send("never matches the bad one")).toStartWith("brain:");
});

test("quick intents stand down while a confirmation gate is armed", async () => {
  const calls: string[] = [];
  let pending = true;
  const nonce = "33333333-3333-4333-8333-333333333333";
  const inner: Brain = {
    ...fakeBrain(calls),
    hasPendingConfirmation: () => pending,
    pendingConfirmations: () => pending ? [{ nonce, summary: "guarded operation" }] : [],
    resolvePendingConfirmation: (approved: boolean, suppliedNonce: string) => {
      if (!pending || suppliedNonce !== nonce) return false;
      pending = false;
      return approved;
    },
  };
  const b = new QuickIntentsBrain(inner, [
    { phrases: ["cancel that", "never mind"], reply: "Very good." },
  ], NOON);
  // With the gate armed, even a bank phrase reaches the inner brain (whose
  // switchboard relay owns the yes/no) instead of a canned reply.
  expect(await b.send("cancel that")).toBe("brain: cancel that");
  expect(calls).toEqual(["cancel that"]);
  expect(b.hasPendingConfirmation()).toBe(true);
  expect(b.resolvePendingConfirmation(true, nonce)).toBe(true);
  // Gate cleared — the bank answers again.
  expect(await b.send("never mind")).toBe("Very good.");
  expect(calls).toEqual(["cancel that"]);
});

test("lane voice accessors delegate to the wrapped brain", () => {
  const inner = { ...fakeBrain([]), activeLane: () => "coder", activeLaneVoice: () => "stark" };
  const b = new QuickIntentsBrain(inner, [], NOON);
  expect(b.activeLane()).toBe("coder");
  expect(b.activeLaneVoice()).toBe("stark");
});

test("setCallMeHandler reaches the wrapped brain — QuickIntents is the outermost wrapper", () => {
  // Regression for the PR #97 gap: the daemon installs the dial-back handler
  // with `brain.setCallMeHandler?.(...)`, so a wrapper that drops the
  // capability silently disables spoken "call me" for the whole stack.
  const installed: Array<(who?: string) => Promise<string>> = [];
  const inner = { ...fakeBrain([]), setCallMeHandler: (h: (who?: string) => Promise<string>) => { installed.push(h); } };
  const b = new QuickIntentsBrain(inner, [], NOON);
  const handler = async () => "Ringing you now.";
  b.setCallMeHandler!(handler);
  expect(installed).toEqual([handler]);

  // Capability contract: absent on the inner brain means absent on the wrapper.
  const bare = new QuickIntentsBrain(fakeBrain([]), [], NOON);
  expect(bare.setCallMeHandler).toBeUndefined();
});
