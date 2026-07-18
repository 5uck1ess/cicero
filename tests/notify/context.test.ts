import { describe, expect, test } from "bun:test";
import {
  MAX_TURN_CONTEXT_ENTRY_CHARS,
  briefingTurnContext,
  notificationTurnContext,
} from "../../src/notify/context";
import { BrainTurnContext } from "../../src/brain/turn-context";

describe("notificationTurnContext", () => {
  test("carries the delivered text, the timestamp, and the follow-up hint", () => {
    const at = new Date("2026-07-14T18:00:00.000Z");
    const ctx = notificationTurnContext("Fork sync: rebase hit conflicts.", at);
    expect(ctx).toContain("2026-07-14T18:00:00.000Z");
    expect(ctx).toContain("Fork sync: rebase hit conflicts.");
    expect(ctx).toContain("most recent notification");
    // One-shot context rides a prompt: it must stay a compact block, not grow prose.
    expect(ctx.split("\n").length).toBe(2);
  });
});

describe("briefingTurnContext", () => {
  test("labels a delivered morning briefing for follow-up", () => {
    const ctx = briefingTurnContext("☀️ Morning briefing\n\n• PR #123 is ready.", new Date("2026-07-18T12:30:00.000Z"));
    expect(ctx).toContain("[Morning briefing delivered at 2026-07-18T12:30:00.000Z]");
    expect(ctx).toContain("PR #123 is ready.");
    expect(ctx).toContain("most recent morning briefing");
  });

  test("honestly bounds the injected digest copy to one turn-context entry", () => {
    const headMarker = "HEAD-OF-FULL-TELEGRAM-DIGEST";
    const tailMarker = "TAIL-OF-FULL-TELEGRAM-DIGEST";
    const ctx = briefingTurnContext(`${headMarker}${"x".repeat(12_000)}${tailMarker}`, new Date(0));
    const turnContext = new BrainTurnContext();
    turnContext.inject(ctx);
    expect(ctx.length).toBeLessThanOrEqual(MAX_TURN_CONTEXT_ENTRY_CHARS);
    expect(ctx).toContain("[earlier briefing content truncated for brain context]");
    expect(ctx).not.toContain(headMarker);
    expect(ctx).toContain(tailMarker);
    expect(turnContext.takePending()).toBe(ctx);
  });
});
