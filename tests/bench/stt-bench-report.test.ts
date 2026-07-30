import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { median, renderTable, renderStreamingTable } from "../../bench/stt-bench";

const streamStats = { firstDeltaMs: 120, finalAfterAudioMs: 300, deltasDuringAudio: 4, deltas: 6 };

test("median reports no samples as n/a rather than zero", () => {
  // Every caller feeds this into a latency column. Returning 0 for "we never
  // measured anything" is indistinguishable from an instantaneous response.
  expect(median([])).toBeNaN();
  expect(median([5])).toBe(5);
  expect(median([1, 3])).toBe(2);
});

test("a candidate whose every clip failed is reported, not ranked first", () => {
  // The failing candidate is listed first and carries WER 0 under the old
  // aggregation, so an ascending sort by WER crowned the one that produced
  // nothing. errors/clips columns alone did not stop it being read as the
  // winner of the table.
  const table = renderTable([
    { name: "broken", available: true, meanWerPct: NaN, warmMs: NaN, coldMs: NaN, rtf: NaN, errors: 3, clips: 0 },
    { name: "working", available: true, meanWerPct: 12.5, warmMs: 400, coldMs: 900, rtf: 0.4, errors: 0, clips: 3 },
    { name: "missing", available: false, meanWerPct: NaN, warmMs: NaN, coldMs: NaN, rtf: NaN, errors: 0, clips: 0 },
  ]);
  const lines = table.split("\n");
  const rows = lines.filter((l) => l.startsWith("| ") && !l.startsWith("| Candidate"));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("working");
  expect(table).not.toMatch(/\| broken \|/);
  expect(table).toContain("**Failed:**");
  expect(table).toContain("- broken (reachable, but every clip failed — 3 errors; no metrics)");
  expect(table).toContain("**Skipped:**");
  expect(table).toContain("- missing (unavailable");
});

test("a streaming candidate whose every clip failed is reported, not ranked first", () => {
  const table = renderStreamingTable([
    {
      name: "broken-stream", available: true, meanWerPct: NaN, warmMs: NaN, coldMs: NaN, rtf: NaN,
      errors: 2, clips: 0, streaming: { firstDeltaMs: NaN, finalAfterAudioMs: NaN, deltasDuringAudio: 0, deltas: 0 },
    },
    {
      name: "working-stream", available: true, meanWerPct: 8, warmMs: 5_000, coldMs: 5_000, rtf: 1,
      errors: 0, clips: 3, streaming: streamStats,
    },
  ]);
  const rows = table.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Candidate"));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("working-stream");
  expect(table).toContain("- broken-stream (reachable, but every clip failed — 2 errors; no metrics)");
});

test("an all-failed streaming candidate is still reported when nothing succeeded", () => {
  // With no ranked rows at all the table used to render as the empty string,
  // so a total streaming failure disappeared from the report entirely.
  const table = renderStreamingTable([
    {
      name: "broken-stream", available: true, meanWerPct: NaN, warmMs: NaN, coldMs: NaN, rtf: NaN,
      errors: 1, clips: 0, streaming: { firstDeltaMs: NaN, finalAfterAudioMs: NaN, deltasDuringAudio: 0, deltas: 0 },
    },
  ]);
  expect(table).toContain("broken-stream");
  expect(table).toContain("1 error;");
});

test("batch and streaming candidates stay in their own tables", () => {
  const rows = [
    { name: "batch", available: true, meanWerPct: 10, warmMs: 300, coldMs: 800, rtf: 0.3, errors: 0, clips: 2 },
    {
      name: "stream", available: true, meanWerPct: 9, warmMs: 4_000, coldMs: 4_000, rtf: 1,
      errors: 0, clips: 2, streaming: streamStats,
    },
  ];
  expect(renderTable(rows)).toContain("| batch |");
  expect(renderTable(rows)).not.toContain("| stream |");
  expect(renderStreamingTable(rows)).toContain("| stream |");
  expect(renderStreamingTable(rows)).not.toContain("| batch |");
});

test("writing a report creates the archive directory it needs", async () => {
  // A RUNTIME-ASSUMPTION guard, not a bug fix. `bench/stt/results/` is
  // gitignored and absent from a fresh checkout, and main() archives there
  // without an explicit mkdir because Bun.write creates missing parents
  // (verified on the pinned Bun 1.3.14 by running the real entry point in a
  // fresh clone). If that ever changes, this fails here instead of the first
  // time somebody benchmarks a new checkout.
  const root = mkdtempSync(join(tmpdir(), "cicero-bench-report-"));
  try {
    const archivePath = join(root, "bench", "stt", "results", "2026-01-01T00-00-00-000Z.md");
    await Bun.write(archivePath, "report");
    expect(Bun.file(archivePath).size).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
