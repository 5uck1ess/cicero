import { describe, expect, test } from "bun:test";
import { BrainTurnContext, MAX_COMPACT_BATCH_CHARS, MAX_SUMMARY_CHARS, type HistoryCompactor } from "../../src/brain/turn-context";

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
  test("an oversized summary is bounded before it is retained", async () => {
    const ctx = new BrainTurnContext();
    ctx.setCompactor(async () => "HEAD-OF-SUMMARY " + "x".repeat(MAX_SUMMARY_CHARS + 5_000));
    fill(ctx, 13);
    await ctx.settled();
    const state = ctx as unknown as { summary: string | null };
    // The cap is inclusive of the marker, not the cap plus the marker.
    expect(state.summary!.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(state.summary).toContain("[summary truncated]");
    // A summary keeps its head; the opening is what says what this was about.
    expect(state.summary!.startsWith("HEAD-OF-SUMMARY ")).toBe(true);
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

  // Regressions for defects found in review.

  // Retiring a turn whose text never reached the summarizer deletes exactly the
  // content compaction exists to preserve.
  test("a batch is sized so every turn it retires actually fit in the request", async () => {
    let sent: readonly { user: string; assistant: string }[] = [];
    const ctx = new BrainTurnContext();
    ctx.setCompactor(async ({ turns }) => { sent = turns; return "summary"; });
    // Each turn is capped at 4k user + 8k assistant, so these are near-maximal.
    for (let i = 0; i < 13; i += 1) ctx.remember(`u${i}`.padEnd(4_000, "x"), `a${i}`.padEnd(8_000, "y"));
    await ctx.settled();

    const sentChars = sent.reduce((n, t) => n + t.user.length + t.assistant.length, 0);
    expect(sent.length).toBeGreaterThan(0);
    expect(sentChars).toBeLessThanOrEqual(MAX_COMPACT_BATCH_CHARS);
    // Nothing that was dropped from the transcript is missing from the batch:
    // every turn still present, plus every turn sent, accounts for all of them.
    const text = ctx.buildTextPrompt("now", true);
    for (const turn of sent) expect(text).not.toContain(turn.assistant);
  });

  // A failure must land back at the normal ceiling, not sit at the relaxed one.
  test("a failed compaction trims back to the normal cap without waiting for another turn", async () => {
    const ctx = new BrainTurnContext();
    ctx.setCompactor(async () => { throw new Error("summarizer down"); });
    for (let i = 0; i < 24; i += 1) {
      ctx.remember(`q${i}`, `a${i}`);
      await ctx.settled();
    }
    const turns = (ctx.buildTextPrompt("now", true).match(/User: /g) ?? []).length;
    expect(turns).toBeLessThanOrEqual(12);
  });

  // Aborting only asks. A compactor that ignores its signal must not hold the
  // single-flight latch, and the relaxed ceiling, forever.
  test("a compactor that ignores its abort signal still releases the latch at the deadline", async () => {
    let calls = 0;
    let sawAbort = false;
    const ctx = new BrainTurnContext({ compactionTimeoutMs: 20 });
    ctx.setCompactor((_input, signal) => {
      calls += 1;
      signal.addEventListener("abort", () => { sawAbort = true; });
      return new Promise<string>(() => { /* never settles, ignores abort */ });
    });

    for (let i = 0; i < 13; i += 1) ctx.remember(`q${i}`, `a${i}`);
    expect(calls).toBe(1);
    await ctx.settled();          // returns once the deadline fires, not never
    expect(sawAbort).toBe(true);

    // The latch is free, so a later crossing can compact again...
    ctx.setCompactor(async () => "recovered");
    for (let i = 0; i < 13; i += 1) ctx.remember(`later${i}`, `reply${i}`);
    await ctx.settled();
    expect(ctx.buildTextPrompt("now", true)).toContain("recovered");
    // ...and the relaxed ceiling was given back.
    const turns = (ctx.buildTextPrompt("now", true).match(/User: /g) ?? []).length;
    expect(turns).toBeLessThanOrEqual(12);
  });

  // The documented ceiling has to count everything that gets replayed.
  test("the running summary counts toward the character ceiling", async () => {
    const ctx = new BrainTurnContext();
    ctx.setCompactor(async () => "S".repeat(MAX_SUMMARY_CHARS));
    for (let i = 0; i < 13; i += 1) ctx.remember(`u${i}`.padEnd(1_500, "x"), `a${i}`.padEnd(1_500, "y"));
    await ctx.settled();

    // With the summary in place, turn compaction off so plain eviction is what
    // enforces the ceiling — otherwise compaction keeps trimming first and the
    // char accounting is never what binds.
    ctx.setCompactor(null);
    for (let i = 0; i < 30; i += 1) ctx.remember(`later${i}`.padEnd(1_500, "x"), `reply${i}`.padEnd(1_500, "y"));

    // Measured independently of retainedChars(), or this would just assert that
    // the helper agrees with itself and pass with the accounting removed.
    const state = ctx as unknown as {
      history: { user: string; assistant: string }[];
      summary: string | null;
    };
    expect(state.summary).not.toBeNull();
    const replayed = state.history.reduce((n, t) => n + t.user.length + t.assistant.length, 0)
      + (state.summary?.length ?? 0);
    expect(replayed).toBeLessThanOrEqual(32_000);
  });

});
