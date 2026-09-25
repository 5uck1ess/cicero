import { expect, test } from "bun:test";
import { BENCH_ROSTER, report } from "../bench/intent-bench";
import { parseIntent } from "../src/brain/switchboard-intent";

test("intent fixtures have 150 distinct valid synthetic labels covering every intent", async () => {
  const rows = (await Bun.file(new URL("../bench/intent/cases.jsonl", import.meta.url)).text()).trim().split("\n").map((s) => JSON.parse(s));
  expect(rows.length).toBe(150);
  expect(new Set(rows.map((r) => r.utterance)).size).toBe(150);
  expect(new Set(rows.map((r) => r.intent)).size).toBe(6);
  for (const { utterance, ...label } of rows) {
    const parsed = parseIntent(JSON.stringify({ ...label, confidence: 0.9 }), BENCH_ROSTER);
    expect(parsed.intent).toBe(label.intent);
    expect(parsed.target).toBe(label.target);
    expect(parsed.request_now).toBe(label.request_now);
  }
});

test("bench false actions use request and confidence gates, with known confusion/percentiles", () => {
  const cases = Array.from({ length: 4 }, () => ({ utterance: "synthetic", intent: "none" as const, target: null, request_now: false }));
  const answers = [
    { intent: "rollcall" as const, target: null, request_now: true, confidence: 0.9 },
    { intent: "rollcall" as const, target: null, request_now: false, confidence: 0.9 },
    { intent: "rollcall" as const, target: null, request_now: true, confidence: 0.6 },
    { intent: "none" as const, target: null, request_now: false, confidence: 0 },
  ];
  const output = report(cases, answers, [10, 20, 30, 40], 0.7);
  expect(output).toContain("False-action rate on none: 1/4 (25.00%)");
  expect(output).toContain("none accuracy: 1/4 (25.0%)");
  expect(output).toContain("p50=20.0ms p95=40.0ms");
});

test("repeated bench separates timeouts and wrong answers and reports flips and misses", async () => {
  const { repeatedReport, parseRuns } = await import("../bench/intent-bench");
  const cases = [{ utterance: "synthetic case", intent: "rollcall" as const, target: null, request_now: true }];
  const answer = { intent: "none" as const, target: null, request_now: false, confidence: 0 };
  const output = repeatedReport(cases, [
    [{ answer, timedOut: true, failed: false, durationMs: 1501 }],
    [{ answer: { ...answer, intent: "rollcall", request_now: true, confidence: 0.9 }, timedOut: false, failed: false, durationMs: 350 }],
  ], 0.7, true);
  expect(output).toContain("Timeouts: 1; provider errors: 0; wrong answers excluding timeouts/errors: 0");
  expect(output).toContain('"timedOut":true');
  expect(output).toContain('"utterance":"synthetic case"');
  expect(output).toContain("1/1 flipped between runs");
  expect(parseRuns([])).toBe(1);
  expect(parseRuns(["--runs", "3"])).toBe(3);
  for (const bad of ["0", "-1", "1.5", "101", "oops"]) expect(() => parseRuns(["--runs", bad])).toThrow();
});
