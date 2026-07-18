import { test, expect } from "bun:test";
import {
  TELEGRAM_TEXT_MAX_CHARS,
  callMinutesThresholdMs,
  chunkBriefingDigest,
  composeBriefing,
  composeBriefingDigest,
  dayOf,
  hmOf,
  inQuietHours,
  minutesPrompt,
  parseHm,
  worthMinutes,
} from "../../src/notify/briefing";

const at = (h: number, m: number) => new Date(2026, 6, 7, h, m);

test("parseHm accepts HH:MM and rejects garbage", () => {
  expect(parseHm("08:30")).toBe(510);
  expect(parseHm("0:05")).toBe(5);
  expect(() => parseHm("8pm")).toThrow();
  expect(() => parseHm("25:00")).toThrow();
  expect(() => parseHm("10:60")).toThrow();
});

test("quiet hours spanning midnight", () => {
  const q = { from: "23:00", to: "08:00" };
  expect(inQuietHours(at(23, 30), q)).toBe(true);
  expect(inQuietHours(at(2, 0), q)).toBe(true);
  expect(inQuietHours(at(7, 59), q)).toBe(true);
  expect(inQuietHours(at(8, 0), q)).toBe(false);
  expect(inQuietHours(at(12, 0), q)).toBe(false);
});

test("quiet hours within one day", () => {
  const q = { from: "13:00", to: "14:00" };
  expect(inQuietHours(at(13, 30), q)).toBe(true);
  expect(inQuietHours(at(14, 0), q)).toBe(false);
  expect(inQuietHours(at(12, 59), q)).toBe(false);
});

test("zero-length window is off", () => {
  expect(inQuietHours(at(3, 0), { from: "03:00", to: "03:00" })).toBe(false);
});

test("hmOf zero-pads", () => {
  expect(hmOf(at(8, 5))).toBe("08:05");
});

test("briefing folds deduped news and board state", () => {
  const board = [
    { id: "1", title: "Fix parser", status: "blocked" },
    { id: "2", title: "Ship orb", status: "review" },
    { id: "3", title: "Old thing", status: "done" },
  ];
  const text = composeBriefing(["Coder here — finished: tests.", "Coder here — finished: tests."], board);
  expect(text).toStartWith("Morning briefing.");
  expect(text).toContain("While you were away: Coder here — finished: tests.");
  expect((text.match(/finished: tests/g) ?? []).length).toBe(1); // deduped
  expect(text).toContain('Needs your input: "Fix parser".');
  expect(text).toContain('Waiting on review: "Ship orb".');
});

test("briefing with nothing to say says so", () => {
  expect(composeBriefing([], [])).toBe("Morning briefing. All quiet overnight, and the board is clean.");
  expect(composeBriefing([], null)).toBe("Morning briefing. All quiet overnight.");
});

test("digest briefing: header, dividers, bullets, dedup", () => {
  const board = [
    { id: "1", title: "Fix parser", status: "blocked" },
    { id: "2", title: "Ship orb", status: "review" },
    { id: "3", title: "Old thing", status: "done" },
  ];
  const text = composeBriefingDigest(
    ["Coder here — finished: tests.", "Coder here — finished: tests."],
    board,
    "Health log: weight 82.4 kg.",
    "2026-07-11",
  );
  expect(text).toStartWith("☀️ Morning briefing — 2026-07-11\n\n");
  expect(text).toContain("━━━━━ while you were away ━━━━━\n• Coder here — finished: tests.");
  expect((text.match(/finished: tests/g) ?? []).length).toBe(1); // deduped
  expect(text).toContain('━━━━━ needs your input ━━━━━\n• "Fix parser"');
  expect(text).toContain('━━━━━ waiting on review ━━━━━\n• "Ship orb"');
  expect(text).not.toContain("Old thing"); // done tasks stay off the board
  expect(text).toContain("━━━━━ health ━━━━━\nHealth log: weight 82.4 kg."); // rides last, no bullet
  expect(text.indexOf("health")).toBeGreaterThan(text.indexOf("waiting on review"));
});

test("digest briefing: empty state mirrors the prose wording", () => {
  expect(composeBriefingDigest([], [], null, "2026-07-11")).toBe(
    "☀️ Morning briefing — 2026-07-11\n\nAll quiet overnight, and the board is clean.",
  );
  expect(composeBriefingDigest([], null, null, "2026-07-11")).toBe(
    "☀️ Morning briefing — 2026-07-11\n\nAll quiet overnight.",
  );
  // A board with only finished work is still "clean".
  expect(composeBriefingDigest([], [{ id: "1", title: "Done", status: "done" }], null)).toBe(
    "☀️ Morning briefing\n\nAll quiet overnight, and the board is clean.",
  );
});

test("digest briefing: news without a board still renders", () => {
  const text = composeBriefingDigest(["Deploy landed."], null, null, "2026-07-11");
  expect(text).toBe("☀️ Morning briefing — 2026-07-11\n\n━━━━━ while you were away ━━━━━\n• Deploy landed.");
});

test("digest briefing: health-only mornings intentionally omit the quiet framing", () => {
  expect(composeBriefingDigest([], [], "Health log: weight 82.4 kg.", "2026-07-11")).toBe(
    "☀️ Morning briefing — 2026-07-11\n\n━━━━━ health ━━━━━\nHealth log: weight 82.4 kg.",
  );
  expect(composeBriefing([], [], "Health log: weight 82.4 kg.")).toContain(
    "All quiet overnight, and the board is clean.",
  );
});

test("digest chunking: empty, one-chunk, and exact-cap inputs", () => {
  expect(chunkBriefingDigest("")).toEqual([]);
  expect(chunkBriefingDigest("☀️ Morning briefing\n\nAll quiet overnight.")).toEqual([
    "☀️ Morning briefing\n\nAll quiet overnight.",
  ]);
  const exact = "x".repeat(TELEGRAM_TEXT_MAX_CHARS);
  expect(chunkBriefingDigest(exact)).toEqual([exact]);
});

test("digest chunking prefers section boundaries before line boundaries", () => {
  const firstSection = `━━━━━ while you were away ━━━━━\n• ${"A".repeat(2_000)}`;
  const secondSection = `━━━━━ needs your input ━━━━━\n• ${"B".repeat(2_000)}`;
  const digest = `☀️ Morning briefing — 2026-07-18\n\n${firstSection}\n\n${secondSection}`;

  const chunks = chunkBriefingDigest(digest);

  expect(chunks).toHaveLength(2);
  expect(chunks[0]).toBe(`☀️ Morning briefing — 2026-07-18\n\n${firstSection}`);
  expect(chunks[1]).toBe(`☀️ Morning briefing (2/2)\n\n${secondSection}`);
  expect(chunks.every((chunk) => chunk.length <= TELEGRAM_TEXT_MAX_CHARS)).toBe(true);
});

test("digest chunking splits an oversized section on item lines", () => {
  const items = Array.from({ length: 6 }, (_, index) => `• item-${index + 1} ${String(index + 1).repeat(850)}`);
  const digest = `☀️ Morning briefing\n\n━━━━━ while you were away ━━━━━\n${items.join("\n")}`;

  const chunks = chunkBriefingDigest(digest);

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.slice(1).every((chunk, index) => chunk.startsWith(`☀️ Morning briefing (${index + 2}/${chunks.length})\n\n`))).toBe(true);
  for (const item of items) expect(chunks.some((chunk) => chunk.includes(item))).toBe(true);
  expect(chunks.every((chunk) => chunk.length <= TELEGRAM_TEXT_MAX_CHARS)).toBe(true);
});

test("digest chunking hard-splits an oversized single line with an ellipsis", () => {
  const digest = `☀️ Morning briefing\n\n${"Z".repeat(TELEGRAM_TEXT_MAX_CHARS * 2)}`;

  const chunks = chunkBriefingDigest(digest);

  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks[0].endsWith("…")).toBe(true);
  expect(chunks.slice(1, -1).every((chunk) => chunk.endsWith("…"))).toBe(true);
  expect(chunks.every((chunk) => chunk.length <= TELEGRAM_TEXT_MAX_CHARS)).toBe(true);
});

test("18 realistic overnight items survive a multi-chunk digest verbatim", () => {
  const items = Array.from({ length: 18 }, (_, index) => (
    `GitHub PR #${1_200 + index} announced: ${["parser", "scheduler", "dashboard", "voice transport"][index % 4]} ` +
    `work is ready for review after the overnight CI matrix completed successfully; ` +
    `the change includes focused regressions, operator notes, and a safe rollback path. ` +
    `Reviewers can inspect the bounded failure handling, cancellation ownership, and release checklist (${index + 1}/18).`
  ));
  const digest = composeBriefingDigest(items, [], null, "2026-07-18");

  const chunks = chunkBriefingDigest(digest);
  const delivered = chunks.join("\n");

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => chunk.length <= TELEGRAM_TEXT_MAX_CHARS)).toBe(true);
  for (const item of items) expect(delivered).toContain(item);
});

test("minutes need a call longer than the duration gate", () => {
  const t0 = 1_000_000;
  const quick = [
    { user: "how's CI?", reply: "Green.", t: t0 },
    { user: "cool, bye", reply: "Talk soon.", t: t0 + 40_000 }, // 40s call
  ];
  expect(worthMinutes(quick)).toBe(false);
  expect(worthMinutes([quick[0]])).toBe(false);
  const real = [
    { user: "walk me through the parser fix", reply: "…", t: t0 },
    { user: "ship it tonight", reply: "On it.", t: t0 + 4 * 60_000 }, // 4-minute call
  ];
  expect(worthMinutes(real)).toBe(true);
  expect(worthMinutes(real, 5 * 60_000)).toBe(false); // configurable: 5-min bar
});

test("call-minutes duration honors an explicit zero instead of replacing it with the default", () => {
  expect(callMinutesThresholdMs({ min_minutes: 0 })).toBe(0);
  expect(callMinutesThresholdMs({})).toBe(3 * 60_000);
  expect(callMinutesThresholdMs(true)).toBe(3 * 60_000);
});

test("minutes prompt offers the SKIP escape hatch", () => {
  expect(minutesPrompt([{ user: "hi", reply: "hello" }])).toContain("reply with exactly SKIP");
});

test("minutes prompt carries the transcript", () => {
  const p = minutesPrompt([{ user: "deploy the fix", reply: "Done, CI is green." }]);
  expect(p).toContain("User: deploy the fix");
  expect(p).toContain("Assistant: Done, CI is green.");
  expect(p).toContain("call notes");
});

test("timezone-aware clock: 08:30 in New York is not 08:30 UTC", () => {
  const utc0830 = new Date(Date.UTC(2026, 6, 7, 8, 30)); // the 4am-wtf incident
  expect(hmOf(utc0830, "UTC")).toBe("08:30");
  expect(hmOf(utc0830, "America/New_York")).toBe("04:30");
  const nyMorning = new Date(Date.UTC(2026, 6, 7, 12, 30)); // 08:30 EDT
  expect(hmOf(nyMorning, "America/New_York")).toBe("08:30");
  expect(dayOf(utc0830, "America/New_York")).toBe("2026-07-07");
});

test("quiet hours respect the configured timezone", () => {
  const q = { from: "23:00", to: "08:00" };
  const earlyNy = new Date(Date.UTC(2026, 6, 7, 11, 0)); // 07:00 EDT — quiet in NY, mid-morning UTC
  expect(inQuietHours(earlyNy, q, "America/New_York")).toBe(true);
  expect(inQuietHours(earlyNy, q, "UTC")).toBe(false);
});

test("composeBriefing: the health line rides last when present, silence otherwise", () => {
  expect(composeBriefing([], [], "Health log: weight 82.4 kg.")).toBe(
    "Morning briefing. All quiet overnight, and the board is clean. Health log: weight 82.4 kg.",
  );
  expect(composeBriefing([], [], null)).toBe("Morning briefing. All quiet overnight, and the board is clean.");
});
