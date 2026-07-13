import { test, expect } from "bun:test";
import { FallbackBrain } from "../../src/brain/fallback";
import { RoutingBrain } from "../../src/brain/routing";
import type { Brain } from "../../src/types";

const PRIMARY_NONCE = "44444444-4444-4444-8444-444444444444";
const SECONDARY_NONCE = "55555555-5555-4555-8555-555555555555";

function gatedBrain(nonce: string, calls: string[], initialPending = true): Brain {
  let pending = initialPending;
  return {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    send: (message: string) => Promise.resolve(message),
    streamProgress: (message: string) => oneShot(message),
    injectContext: () => {},
    restart: () => Promise.resolve(),
    health: () => Promise.resolve(true),
    hasPendingConfirmation: () => pending,
    pendingConfirmations: () => pending ? [{ nonce, summary: `gate ${nonce.slice(0, 4)}` }] : [],
    resolvePendingConfirmation: (approved: boolean, suppliedNonce: string) => {
      if (!pending || suppliedNonce !== nonce) return false;
      pending = false;
      calls.push(approved ? `approved:${nonce}` : `denied:${nonce}`);
      return true;
    },
  };
}

async function* oneShot(value: string): AsyncIterable<string> {
  try {
    yield value;
  } catch (err: unknown) {
    throw err;
  }
}

async function drain(source: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  try {
    for await (const chunk of source) chunks.push(chunk);
    return chunks;
  } catch (err: unknown) {
    throw err;
  }
}

test("routing wrapper sends a nonce to the child that originated it", () => {
  const primaryCalls: string[] = [];
  const escalationCalls: string[] = [];
  const brain = new RoutingBrain(
    gatedBrain(PRIMARY_NONCE, primaryCalls),
    gatedBrain(SECONDARY_NONCE, escalationCalls),
  );

  expect(brain.pendingConfirmations!().map((gate) => gate.nonce)).toEqual([PRIMARY_NONCE, SECONDARY_NONCE]);
  expect(brain.resolvePendingConfirmation!(true, SECONDARY_NONCE)).toBe(true);
  expect(primaryCalls).toEqual([]);
  expect(escalationCalls).toEqual([`approved:${SECONDARY_NONCE}`]);
});

test("an exact local yes reaches a uniquely pending escalation brain", async () => {
  const primaryCalls: string[] = [];
  const escalationCalls: string[] = [];
  const brain = new RoutingBrain(
    gatedBrain(PRIMARY_NONCE, primaryCalls, false),
    gatedBrain(SECONDARY_NONCE, escalationCalls),
  );

  expect(await brain.send("Yes.")).toBe("Approved.");
  expect(primaryCalls).toEqual([]);
  expect(escalationCalls).toEqual([`approved:${SECONDARY_NONCE}`]);
});

test("progress narration resolves a unique gate before selecting a lane", async () => {
  const primaryCalls: string[] = [];
  const escalationCalls: string[] = [];
  const brain = new RoutingBrain(
    gatedBrain(PRIMARY_NONCE, primaryCalls, false),
    gatedBrain(SECONDARY_NONCE, escalationCalls),
  );

  expect(await drain(brain.streamProgress!("Yes."))).toEqual(["Approved."]);
  expect(primaryCalls).toEqual([]);
  expect(escalationCalls).toEqual([`approved:${SECONDARY_NONCE}`]);
});

test("fallback wrapper routes capabilities across tiers rather than current tier", () => {
  const primaryCalls: string[] = [];
  const fallbackCalls: string[] = [];
  const brain = new FallbackBrain([
    gatedBrain(PRIMARY_NONCE, primaryCalls),
    gatedBrain(SECONDARY_NONCE, fallbackCalls),
  ], "coder");

  expect(brain.resolvePendingConfirmation!(false, SECONDARY_NONCE)).toBe(true);
  expect(primaryCalls).toEqual([]);
  expect(fallbackCalls).toEqual([`denied:${SECONDARY_NONCE}`]);
});

test("an exact local denial reaches a uniquely pending fallback tier", async () => {
  const primaryCalls: string[] = [];
  const fallbackCalls: string[] = [];
  const brain = new FallbackBrain([
    gatedBrain(PRIMARY_NONCE, primaryCalls, false),
    gatedBrain(SECONDARY_NONCE, fallbackCalls),
  ], "coder");

  expect(await brain.send("No.")).toBe("Cancelled.");
  expect(primaryCalls).toEqual([]);
  expect(fallbackCalls).toEqual([`denied:${SECONDARY_NONCE}`]);
});

test("fallback streaming resolves a unique gate before trying tiers", async () => {
  const primaryCalls: string[] = [];
  const fallbackCalls: string[] = [];
  const brain = new FallbackBrain([
    gatedBrain(PRIMARY_NONCE, primaryCalls, false),
    gatedBrain(SECONDARY_NONCE, fallbackCalls),
  ], "coder");

  expect(await drain(brain.sendStream("No."))).toEqual(["Cancelled."]);
  expect(primaryCalls).toEqual([]);
  expect(fallbackCalls).toEqual([`denied:${SECONDARY_NONCE}`]);
});

test("duplicate capability claims fail closed without resolving either child", () => {
  const firstCalls: string[] = [];
  const secondCalls: string[] = [];
  const brain = new RoutingBrain(
    gatedBrain(PRIMARY_NONCE, firstCalls),
    gatedBrain(PRIMARY_NONCE, secondCalls),
  );

  expect(brain.resolvePendingConfirmation!(true, PRIMARY_NONCE)).toBe(false);
  expect(firstCalls).toEqual([]);
  expect(secondCalls).toEqual([]);
});
