import { describe, expect, test } from "bun:test";
import { BrainTurnContext, MAX_SUMMARY_CHARS, type HistoryCompactor } from "../../src/brain/turn-context";

/** Fill the context past its 12-turn cap. */
function fill(ctx: BrainTurnContext, count: number, prefix = "q"): void {
  for (let i = 0; i < count; i += 1) ctx.remember(`${prefix}${i}`, `a${i}`);
}

const prompt = (ctx: BrainTurnContext): string => ctx.buildTextPrompt("now", true);

describe("history compaction", () => {
  // The whole point: without a compactor, turn 13 silently deletes turn 1.
  test("without a compactor the oldest turns are still evicted, exactly as before", () => {
    const ctx = new BrainTurnContext();
    fill(ctx, 20);
    const text = prompt(ctx);
    expect(text).not.toContain("q0");
    expect(text).toContain("q19");
    expect(text).not.toContain("Summary of earlier conversation");
  });

  test("a compactor replaces the older turns with a summary instead of dropping them", async () => {
    const seen: string[][] = [];
    const compactor: HistoryCompactor = async ({ turns }) => {
      seen.push(turns.map((t) => t.user));
      return "The user asked about the early topics.";
    };
    const ctx = new BrainTurnContext();
    ctx.setCompactor(compactor);
    fill(ctx, 13);
    await ctx.settled();

    const text = prompt(ctx);
    expect(text).toContain("Summary of earlier conversation:");
    expect(text).toContain("The user asked about the early topics.");
    // The summarized turns are gone from the verbatim transcript...
    expect(text).not.toContain("User: q0\n");
    // ...and the recent ones are still there in full.
    expect(text).toContain("q12");
    // It summarized the older half, not everything.
    expect(seen[0]).toEqual(["q0", "q1", "q2", "q3", "q4", "q5"]);
  });

  test("the summary is carried into chat-message form too", async () => {
    const ctx = new BrainTurnContext();
    ctx.setCompactor(async () => "earlier: they discussed deployment");
    fill(ctx, 13);
    await ctx.settled();

    const messages = ctx.buildChatMessages("now", "SYSTEM");
    const summaries = messages.filter((m) => m.role === "system" && m.content.includes("Summary of earlier"));
    expect(summaries.length).toBe(1);
    expect(summaries[0]!.content).toContain("they discussed deployment");
    // The system prompt still leads.
    expect(messages[0]).toEqual({ role: "system", content: "SYSTEM" });
  });

  // Single-flight: a second trigger while one is running must not start another.
  test("only one compaction runs at a time", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ctx = new BrainTurnContext();
    ctx.setCompactor(async () => {
      started += 1;
      await gate;
      return "summary";
    });

    fill(ctx, 13);
    expect(started).toBe(1);
    fill(ctx, 6, "later"); // keeps crossing the cap while the first is in flight
    expect(started).toBe(1);

    release();
    await ctx.settled();
    expect(started).toBe(1);
  });

  // The full turns must keep serving prompts until the summary actually lands —
  // otherwise compaction is just eviction with extra steps.
  test("history is served in full while the compaction is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ctx = new BrainTurnContext();
    ctx.setCompactor(async () => { await gate; return "summary"; });

    fill(ctx, 13);
    const during = prompt(ctx);
    expect(during).toContain("q0");   // not yet dropped
    expect(during).not.toContain("Summary of earlier conversation");

    release();
    await ctx.settled();
    const after = prompt(ctx);
    expect(after).not.toContain("User: q0\n");
    expect(after).toContain("Summary of earlier conversation");
  });

  // The transcript must stay bounded even if the compactor never returns.
  test("a compactor that never finishes cannot grow the transcript without bound", async () => {
    const ctx = new BrainTurnContext();
    ctx.setCompactor(() => new Promise<string>(() => { /* never settles */ }));
    fill(ctx, 200);

    const text = prompt(ctx);
    const turns = (text.match(/User: /g) ?? []).length;
    // Relaxed to 2x the normal 12-turn cap while compacting, and no further.
    expect(turns).toBeLessThanOrEqual(24);
    expect(text).not.toContain("User: q0\n");
  });

  test("a failing compactor degrades to plain eviction", async () => {
    const ctx = new BrainTurnContext();
    ctx.setCompactor(async () => { throw new Error("summarizer down"); });
    fill(ctx, 13);
    await ctx.settled();

    const text = prompt(ctx);
    expect(text).not.toContain("Summary of earlier conversation");
    expect(text).toContain("q12");
    // And it recovers: a later compaction can still succeed.
    ctx.setCompactor(async () => "recovered summary");
    fill(ctx, 13, "second");
    await ctx.settled();
    expect(prompt(ctx)).toContain("recovered summary");
  });

  test("an empty summary is treated as a failure, not stored", async () => {
    const ctx = new BrainTurnContext();
    ctx.setCompactor(async () => "   ");
    fill(ctx, 13);
    await ctx.settled();
    expect(prompt(ctx)).not.toContain("Summary of earlier conversation");
  });

  // Successive compactions fold into one running summary rather than stacking.
  test("a later compaction receives the previous summary and replaces it", async () => {
    const previous: (string | null)[] = [];
    const ctx = new BrainTurnContext();
    let round = 0;
    ctx.setCompactor(async ({ previousSummary }) => {
      previous.push(previousSummary);
      round += 1;
      return `summary round ${round}`;
    });

    fill(ctx, 13, "first");
    await ctx.settled();
    fill(ctx, 13, "second");
    await ctx.settled();

    expect(previous[0]).toBeNull();
    expect(previous[1]).toBe("summary round 1");
    const text = prompt(ctx);
    expect(text).toContain("summary round 2");
    expect(text).not.toContain("summary round 1"); // replaced, not stacked
  });

  test("an oversized summary is bounded before it is retained", async () => {
    const ctx = new BrainTurnContext();
    ctx.setCompactor(async () => "x".repeat(MAX_SUMMARY_CHARS + 5_000));
    fill(ctx, 13);
    await ctx.settled();
    const text = prompt(ctx);
    expect(text).toContain("earlier content truncated");
    expect(text.length).toBeLessThan(MAX_SUMMARY_CHARS + 20_000);
  });

  // clear() must not let a compaction started before it resurrect old content.
  test("clear() discards a compaction that was already in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ctx = new BrainTurnContext();
    ctx.setCompactor(async () => { await gate; return "stale summary"; });

    fill(ctx, 13);
    ctx.clear();
    release();
    await ctx.settled();

    ctx.remember("fresh", "reply");
    const text = prompt(ctx);
    expect(text).not.toContain("stale summary");
    expect(text).toContain("fresh");
  });

  test("the compactor is given the turns verbatim", async () => {
    let received: readonly { user: string; assistant: string }[] = [];
    const ctx = new BrainTurnContext();
    ctx.setCompactor(async ({ turns }) => { received = turns; return "s"; });
    fill(ctx, 13);
    await ctx.settled();
    expect(received[0]).toEqual({ user: "q0", assistant: "a0" });
  });

  test("setting the compactor back to null restores plain eviction", async () => {
    const ctx = new BrainTurnContext();
    ctx.setCompactor(async () => "should not appear");
    ctx.setCompactor(null);
    fill(ctx, 20);
    await ctx.settled();
    expect(prompt(ctx)).not.toContain("Summary of earlier conversation");
  });
});
