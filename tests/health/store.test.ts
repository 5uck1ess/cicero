import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEALTH_READ_TAIL_BYTES, HealthStore, briefLine, trendReport, formatValue, type HealthEntry } from "../../src/health/store";
import { parseLogWords, healthLog, healthRecent, healthTrend } from "../../src/cli/health";

const tmpStore = () => new HealthStore(join(mkdtempSync(join(tmpdir(), "cicero-health-")), "metrics.jsonl"));

const entry = (over: Partial<HealthEntry>): HealthEntry => ({ t: Date.now(), metric: "weight", source: "cli", ...over });

// ------------------------------------------------------------------- store

test("store: appends survive a re-read, since() filters, recent() tails", async () => {
  const store = tmpStore();
  await store.append(entry({ t: 1000, metric: "weight", value: 83, unit: "kg" }));
  await store.append(entry({ t: 2000, metric: "calories", value: 650, note: "chicken bowl" }));
  await store.append(entry({ t: 3000, metric: "weight", value: 82.4, unit: "kg" }));

  expect((await store.recent(2)).map((e) => e.t)).toEqual([2000, 3000]);
  expect((await store.since(2000)).map((e) => e.metric)).toEqual(["calories", "weight"]);
  expect((await store.since(9000))).toEqual([]);
});

test("store: concurrent appends don't interleave", async () => {
  const store = tmpStore();
  await Promise.all(Array.from({ length: 25 }, (_, i) => store.append(entry({ t: i, value: i }))));
  expect((await store.recent(100)).length).toBe(25);
});

test("store: recent(n) reads only a bounded tail, but since() covers the full window", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-health-window-"));
  const file = join(root, "metrics.jsonl");
  // ~400 KB — well past HEALTH_READ_TAIL_BYTES (64 KiB), under HEALTH_SINCE_MAX_BYTES.
  // Earliest weight 100, a long tail of notes, latest weight 90.
  const lines: string[] = [JSON.stringify(entry({ t: 1, metric: "weight", value: 100 }))];
  for (let i = 0; i < 4_000; i++) lines.push(JSON.stringify(entry({ t: 100 + i, metric: "note", note: "x".repeat(80) })));
  lines.push(JSON.stringify(entry({ t: 1_000_000, metric: "weight", value: 90 })));
  const body = lines.join("\n") + "\n";
  expect(Buffer.byteLength(body)).toBeGreaterThan(HEALTH_READ_TAIL_BYTES * 4);
  writeFileSync(file, body);
  const store = new HealthStore(file);

  // Regression: a time-window read must include the earliest in-window weight
  // (100), not just the tail — otherwise a weight trend reports change 0, not -10.
  const weights = (await store.since(0)).filter((e) => e.metric === "weight").map((e) => e.value);
  expect(weights).toEqual([100, 90]);

  // recent(n) stays bounded to the last tail chunk (it does not scan the file).
  expect((await store.recent(2)).map((e) => e.t)).toEqual([4_099, 1_000_000]);
});

test("store: an oversized unterminated final line reads empty instead of throwing", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-health-bigline-"));
  const file = join(root, "metrics.jsonl");
  // A valid history followed by a torn/oversized final entry larger than the tail
  // window and lacking a trailing newline: the retained tail contains no complete
  // line. That is not an I/O failure, so the read degrades to empty (rendered as
  // "no recent entries") rather than throwing (which would flip health to
  // "unavailable"). Only genuine open/read errors surface as unavailable.
  const good = JSON.stringify(entry({ t: 1, metric: "weight", value: 80 })) + "\n";
  const giant = `{"t":2,"metric":"note","note":"${"y".repeat(HEALTH_READ_TAIL_BYTES + 4096)}"`; // no newline
  writeFileSync(file, good + giant);
  const store = new HealthStore(file);
  expect(await store.recent(10)).toEqual([]);
});

test("store: unreadable record paths surface failure instead of valid-empty state", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-health-unreadable-"));
  const file = join(root, "metrics.jsonl");
  const store = new HealthStore(file);
  mkdirSync(file);
  await expect(store.recent(10)).rejects.toThrow();
});

test.skipIf(process.platform === "win32")("store: directory and data file are private", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-health-mode-"));
  const file = join(dir, "metrics.jsonl");
  chmodSync(dir, 0o755);
  writeFileSync(file, "", { mode: 0o644 });

  const store = new HealthStore(file);
  await store.append(entry({ value: 82.4 }));

  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(file).mode & 0o777).toBe(0o600);

  const freshDir = mkdtempSync(join(tmpdir(), "cicero-health-new-mode-"));
  const freshFile = join(freshDir, "metrics.jsonl");
  const fresh = new HealthStore(freshFile);
  await fresh.append(entry({ value: 81.9 }));
  expect(statSync(freshFile).mode & 0o777).toBe(0o600);
});

// --------------------------------------------------------------- formatting

test("formatValue: value+unit, value+note, pure note", () => {
  expect(formatValue(entry({ value: 82.4, unit: "kg" }))).toBe("82.4 kg");
  expect(formatValue(entry({ value: 650, unit: "kcal", note: "chicken bowl" }))).toBe("650 kcal — chicken bowl");
  expect(formatValue(entry({ note: "rough day" }))).toBe("rough day");
});

test("briefLine: silent on empty, last weight, summed calories, counted notes", () => {
  expect(briefLine([])).toBeNull();
  const line = briefLine([
    entry({ t: 1, metric: "weight", value: 83, unit: "kg" }),
    entry({ t: 2, metric: "weight", value: 82.4, unit: "kg" }),
    entry({ t: 3, metric: "calories", value: 650 }),
    entry({ t: 4, metric: "calories", value: 1200 }),
    entry({ t: 5, metric: "mood", note: "rough day" }),
  ])!;
  expect(line).toContain("weight 82.4 kg"); // the LAST weigh-in, not the first
  expect(line).toContain("1850 kcal");      // calories SUM
  expect(line).toContain("1 mood note");
  expect(line.startsWith("Health log:")).toBe(true);
});

test("trendReport: numeric metric gets first/last/change, calories get per-day totals", () => {
  const day = 24 * 60 * 60 * 1000;
  const w = trendReport(
    [entry({ t: Date.now() - 2 * day, value: 83 }), entry({ t: Date.now(), value: 82.4 })],
    "weight", 30,
  );
  expect(w).toContain("first: 83");
  expect(w).toContain("last: 82.4");
  expect(w).toContain("change: -0.6");

  const c = trendReport(
    [
      entry({ t: Date.now(), metric: "calories", value: 650 }),
      entry({ t: Date.now(), metric: "calories", value: 1200 }),
    ],
    "calories", 7,
  );
  expect(c).toContain("1850 kcal");
  expect(c).toContain("average: 1850 kcal/day");

  expect(trendReport([], "weight", 30)).toContain("No weight entries");
});

// ---------------------------------------------------------------------- CLI

test("parseLogWords: default unit, explicit unit, note capture, note-only", () => {
  expect(parseLogWords("weight", ["82.4"])).toEqual({ value: 82.4, unit: "kg" });
  expect(parseLogWords("weight", ["181", "lbs"])).toEqual({ value: 181, unit: "lbs" });
  expect(parseLogWords("calories", ["650", "chicken", "bowl"])).toEqual({ value: 650, unit: "kcal", note: "chicken bowl" });
  expect(parseLogWords("sleep", ["6.5", "h", "restless"])).toEqual({ value: 6.5, unit: "h", note: "restless" });
  expect(parseLogWords("mood", ["rough", "day"])).toEqual({ note: "rough day" });
  expect(parseLogWords("steps", ["12000"])).toEqual({ value: 12000 }); // no default unit for unknown metrics
});

test("cli: log → recent → trend round-trips through one store", async () => {
  const store = tmpStore();
  expect(await healthLog("Weight", ["82.4"], store)).toBe("logged: weight 82.4 kg");
  expect(await healthLog("calories", ["650", "chicken", "bowl"], store)).toContain("650 kcal — chicken bowl");
  expect(await healthLog("mood", [], store)).toContain("nothing to log");

  const recent = await healthRecent(10, store);
  expect(recent).toContain("weight");
  expect(recent).toContain("chicken bowl");

  expect(await healthTrend("weight", 7, store)).toContain("last: 82.4 kg");
  expect(await healthTrend("blood-pressure", 7, store)).toContain("No blood-pressure entries");
});
