import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { median, renderTable, renderStreamingTable } from "../../bench/stt-bench";

const streamStats = { firstDeltaMs: 120, finalAfterAudioMs: 300, deltasDuringAudio: 4, deltas: 6, paced: true };

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
    { name: "broken", kind: "batch", available: true, meanWerPct: NaN, warmMs: NaN, coldMs: NaN, rtf: NaN, errors: 3, clips: 0 },
    { name: "working", kind: "batch", available: true, meanWerPct: 12.5, warmMs: 400, coldMs: 900, rtf: 0.4, errors: 0, clips: 3 },
    { name: "missing", kind: "batch", available: false, meanWerPct: NaN, warmMs: NaN, coldMs: NaN, rtf: NaN, errors: 0, clips: 0 },
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
      name: "broken-stream", kind: "stream", available: true, meanWerPct: NaN, warmMs: NaN, coldMs: NaN, rtf: NaN,
      errors: 2, clips: 0, streaming: { firstDeltaMs: NaN, finalAfterAudioMs: NaN, deltasDuringAudio: 0, deltas: 0, paced: true },
    },
    {
      name: "working-stream", kind: "stream", available: true, meanWerPct: 8, warmMs: 5_000, coldMs: 5_000, rtf: 1,
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
      name: "broken-stream", kind: "stream", available: true, meanWerPct: NaN, warmMs: NaN, coldMs: NaN, rtf: NaN,
      errors: 1, clips: 0, streaming: { firstDeltaMs: NaN, finalAfterAudioMs: NaN, deltasDuringAudio: 0, deltas: 0, paced: true },
    },
  ]);
  expect(table).toContain("broken-stream");
  expect(table).toContain("1 error;");
});

test("batch and streaming candidates stay in their own tables", () => {
  const rows = [
    { name: "batch", kind: "batch", available: true, meanWerPct: 10, warmMs: 300, coldMs: 800, rtf: 0.3, errors: 0, clips: 2 },
    {
      name: "stream", kind: "stream", available: true, meanWerPct: 9, warmMs: 4_000, coldMs: 4_000, rtf: 1,
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

test("a fast probe is ranked on accuracy but never reports a latency", () => {
  // pace:"fast" uploads the whole clip as quickly as the socket takes it, so
  // "before the audio ended" is measured against an instant that never
  // happened — a 10s clip answered at 100ms records -9,900ms time-to-final and
  // counts every delta as arriving during audio. Those numbers went into a
  // table headed "Streaming (real-time feed)" with nothing marking them.
  const table = renderStreamingTable([
    {
      name: "probe", kind: "stream", available: true, meanWerPct: 5, warmMs: 900, coldMs: 900, rtf: 0.1,
      errors: 0, clips: 2,
      streaming: { firstDeltaMs: NaN, finalAfterAudioMs: NaN, deltasDuringAudio: NaN, deltas: 3, paced: false },
    },
    {
      name: "real", kind: "stream", available: true, meanWerPct: 9, warmMs: 5_000, coldMs: 5_000, rtf: 1,
      errors: 0, clips: 2, streaming: streamStats,
    },
  ]);
  const rows = table.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Candidate"));
  expect(rows).toHaveLength(2);
  // Ranked on WER like any other row — accuracy does not depend on pacing.
  expect(rows[0]).toContain("probe (fast probe)");
  expect(rows[1]).toContain("real");
  // ...but every latency column on that row is withheld, not printed.
  expect(rows[0]).not.toContain("-9900");
  expect(rows[0]!.match(/n\/a/g) ?? []).toHaveLength(3);
  expect(table).toContain("Re-run it without");
  // The genuinely paced row still reports its numbers.
  expect(rows[1]).toContain("120");
  expect(rows[1]).toContain("4 / 6");
});

test("an unreachable streaming server is skipped under Streaming, not Batch", () => {
  // A candidate that never started has no metrics, so a renderer that decides
  // where a row belongs by looking for streaming stats put an unreachable
  // audio.cpp under "Batch (whole-clip transcribe)" — the one heading it can
  // never belong to.
  const rows = [
    { name: "closed stream", kind: "stream" as const, available: false, meanWerPct: NaN, warmMs: NaN, coldMs: NaN, rtf: NaN, errors: 0, clips: 0 },
    { name: "missing binary", kind: "batch" as const, available: false, meanWerPct: NaN, warmMs: NaN, coldMs: NaN, rtf: NaN, errors: 0, clips: 0 },
  ];
  const batch = renderTable(rows);
  expect(batch).toContain("- missing binary (unavailable");
  expect(batch).not.toContain("closed stream");

  const streaming = renderStreamingTable(rows);
  expect(streaming).toContain("- closed stream (unavailable");
  expect(streaming).not.toContain("missing binary");
  // The streaming table has to appear at all for that line to be readable.
  expect(streaming).toContain("Streaming (real-time feed");
});
