import { describe, expect, test } from "bun:test";
import { notificationTurnContext } from "../../src/notify/context";

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
