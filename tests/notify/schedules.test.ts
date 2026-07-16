import { test, expect } from "bun:test";
import { PromptScheduler, SCHEDULE_MAX_REPLY_CHARS, type PromptScheduleDef } from "../../src/notify/schedules";

/** Local wall-clock date — the scheduler reads HH:MM in the box clock when no timezone is set. */
function at(hours: number, minutes: number): Date {
  return new Date(2026, 6, 12, hours, minutes, 5);
}

async function waitFor(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await Bun.sleep(1);
  }
  throw new Error(`${label} never happened`);
}

interface Harness {
  scheduler: PromptScheduler;
  asked: PromptScheduleDef[];
  delivered: string[];
  setNow: (d: Date) => void;
}

function harness(opts: {
  schedules: PromptScheduleDef[];
  reply?: (schedule: PromptScheduleDef, signal: AbortSignal) => Promise<string>;
  quietHours?: { from: string; to: string };
  turnTimeoutMs?: number;
  deliver?: (text: string) => Promise<void>;
}): Harness {
  let now = at(0, 0);
  const asked: PromptScheduleDef[] = [];
  const delivered: string[] = [];
  const scheduler = new PromptScheduler({
    schedules: opts.schedules,
    quietHours: opts.quietHours,
    turnTimeoutMs: opts.turnTimeoutMs,
    ask: (schedule, signal) => {
      asked.push(schedule);
      return opts.reply ? opts.reply(schedule, signal) : Promise.resolve("three ideas: a, b, c");
    },
    deliver: opts.deliver ?? (async (text) => { delivered.push(text); }),
    now: () => now,
  });
  return { scheduler, asked, delivered, setNow: (d) => { now = d; } };
}

test("a schedule fires on its minute, once per day, and the reply is delivered with a header", async () => {
  const h = harness({ schedules: [{ name: "content ideas", at: "09:00", prompt: "draft today's ideas" }] });

  h.setNow(at(8, 59));
  h.scheduler.tick();
  expect(h.asked.length).toBe(0);

  h.setNow(at(9, 0));
  h.scheduler.tick();
  await waitFor(() => h.delivered.length === 1, "delivery");
  expect(h.asked[0]!.prompt).toBe("draft today's ideas");
  expect(h.delivered[0]).toStartWith("💡 content ideas — ");
  expect(h.delivered[0]).toContain("three ideas: a, b, c");

  // Same minute again (ticks are 20s apart): no re-fire.
  h.scheduler.tick();
  await Bun.sleep(5);
  expect(h.asked.length).toBe(1);
});

test("quiet hours hold delivery, not the work — the text is released when the window ends", async () => {
  const h = harness({
    schedules: [{ at: "06:00", prompt: "overnight sweep" }],
    quietHours: { from: "23:30", to: "08:30" },
  });

  h.setNow(at(6, 0));
  h.scheduler.tick();
  await waitFor(() => h.asked.length === 1, "the turn");
  await Bun.sleep(5);
  expect(h.delivered.length).toBe(0); // rendered, but held

  h.setNow(at(8, 31));
  h.scheduler.tick();
  await waitFor(() => h.delivered.length === 1, "quiet release");
  expect(h.delivered[0]).toContain("scheduled prompt 1");
});

test("an empty reply is not delivered", async () => {
  const h = harness({
    schedules: [{ at: "09:00", prompt: "p" }],
    reply: async () => "   ",
  });
  h.setNow(at(9, 0));
  h.scheduler.tick();
  await waitFor(() => h.asked.length === 1, "the turn");
  await Bun.sleep(5);
  expect(h.delivered.length).toBe(0);
});

test("an oversized reply is bounded before delivery", async () => {
  const h = harness({
    schedules: [{ at: "09:00", prompt: "p" }],
    reply: async () => "x".repeat(SCHEDULE_MAX_REPLY_CHARS + 5_000),
  });
  h.setNow(at(9, 0));
  h.scheduler.tick();
  await waitFor(() => h.delivered.length === 1, "delivery");
  expect(h.delivered[0]!.length).toBeLessThan(SCHEDULE_MAX_REPLY_CHARS + 200);
  expect(h.delivered[0]).toEndWith("… (truncated)");
});

test("a failing turn is logged and dropped — the next day fires again", async () => {
  let attempts = 0;
  const h = harness({
    schedules: [{ at: "09:00", prompt: "p" }],
    reply: async () => { attempts++; throw new Error("brain offline"); },
  });
  h.setNow(at(9, 0));
  h.scheduler.tick();
  await waitFor(() => attempts === 1, "first attempt");
  await Bun.sleep(5);
  expect(h.delivered.length).toBe(0);

  // Tomorrow, same minute: a fresh day stamp admits a retry.
  h.setNow(new Date(2026, 6, 13, 9, 0, 5));
  h.scheduler.tick();
  await waitFor(() => attempts === 2, "next-day retry");
});

test("the absolute deadline aborts a hung turn", async () => {
  let sawAbort = false;
  const h = harness({
    schedules: [{ at: "09:00", prompt: "p" }],
    turnTimeoutMs: 15,
    reply: (_s, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { sawAbort = true; reject(signal.reason); }, { once: true });
    }),
  });
  h.setNow(at(9, 0));
  h.scheduler.tick();
  await waitFor(() => sawAbort, "deadline abort");
  await Bun.sleep(5);
  expect(h.delivered.length).toBe(0);
});

test("stop() aborts an in-flight turn and drops held texts", async () => {
  let sawAbort = false;
  const h = harness({
    schedules: [{ at: "09:00", prompt: "p" }],
    reply: (_s, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { sawAbort = true; reject(signal.reason); }, { once: true });
    }),
  });
  h.setNow(at(9, 0));
  h.scheduler.tick();
  await waitFor(() => h.asked.length === 1, "the turn");
  h.scheduler.stop();
  await waitFor(() => sawAbort, "stop abort");
  expect(h.delivered.length).toBe(0);
});

test("a failed delivery does not poison the scheduler for other schedules", async () => {
  const delivered: string[] = [];
  const h = harness({
    schedules: [
      { name: "first", at: "09:00", prompt: "a" },
      { name: "second", at: "09:00", prompt: "b" },
    ],
    deliver: async (text) => {
      if (text.includes("first")) throw new Error("telegram down");
      delivered.push(text);
    },
  });
  h.setNow(at(9, 0));
  h.scheduler.tick();
  await waitFor(() => delivered.length === 1, "surviving delivery");
  expect(delivered[0]).toContain("second");
});

test("a malformed schedule time fails at construction, not at fire time", () => {
  expect(() => harness({ schedules: [{ at: "9am", prompt: "p" }] })).toThrow(/expected HH:MM/);
});

test("snapshot reports next schedule and counts without exposing prompt bodies", () => {
  const h = harness({
    schedules: [
      { name: "morning", at: "09:00", prompt: "SECRET BODY" },
      { name: "afternoon", at: "14:00", prompt: "ANOTHER BODY", lane: "research" },
    ],
  });
  h.setNow(at(10, 0));
  const snapshot = h.scheduler.snapshot();
  expect(snapshot.next).toEqual({ name: "afternoon", at: "14:00", day: "today", lane: "research" });
  expect(snapshot.heldCount).toBe(0);
  expect(snapshot.inFlightCount).toBe(0);
  expect(JSON.stringify(snapshot)).not.toContain("BODY");
});
