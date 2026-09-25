/** Live model evaluation only; no brains, calls, transfers or lane processes run. */
import { loadConfig } from "../src/config";
import { summarizerClassifier } from "../src/brain";
import { classifySwitchboardIntent, INTENTS, type SwitchboardIntent } from "../src/brain/switchboard-intent";
import { percentile } from "../src/latency";

// Fixed synthetic roster makes results comparable across operator installations.
export const BENCH_ROSTER = {
  coder: { aliases: ["Rick", "the coder", "programmer"] },
  reviewer: { aliases: ["Ada", "the reviewer"] },
};
interface Case extends Pick<SwitchboardIntent, "intent" | "target" | "request_now"> { utterance: string }
export function report(cases: Case[], answers: SwitchboardIntent[], durations: number[], threshold: number): string {
  const matrix = Object.fromEntries(INTENTS.map((i) => [i, Object.fromEntries(INTENTS.map((j) => [j, 0]))]));
  let falseActions = 0, negatives = 0, exact = 0, nonRequestActions = 0;
  const lines: string[] = [];
  for (let i = 0; i < cases.length; i++) {
    const expected = cases[i], actual = answers[i];
    const acts = actual.intent !== "none" && actual.request_now && actual.confidence >= threshold;
    matrix[expected.intent][actual.intent]++;
    if (expected.intent === "none") { negatives++; if (acts) falseActions++; }
    if (!expected.request_now && acts) nonRequestActions++;
    if (expected.intent === actual.intent && expected.target === actual.target && expected.request_now === actual.request_now) exact++;
  }
  lines.push(`Exact intent + target + request_now: ${exact}/${cases.length}`);
  for (const intent of INTENTS) {
    const total = cases.filter((c) => c.intent === intent).length;
    lines.push(`${intent} accuracy: ${matrix[intent][intent]}/${total} (${total ? (100 * matrix[intent][intent] / total).toFixed(1) : "n/a"}%)`);
  }
  lines.push("Confusion matrix (rows expected, columns predicted):", `          ${INTENTS.join("  ")}`);
  for (const intent of INTENTS) lines.push(`${intent.padEnd(10)}${INTENTS.map((i) => matrix[intent][i]).join("  ")}`);
  lines.push(`False-action rate on none: ${falseActions}/${negatives} (${negatives ? (100 * falseActions / negatives).toFixed(2) : "n/a"}%)`);
  lines.push(`Actions on any request_now=false case: ${nonRequestActions}`);
  lines.push(`Latency p50=${percentile(durations, 0.5)?.toFixed(1)}ms p95=${percentile(durations, 0.95)?.toFixed(1)}ms`);
  return lines.join("\n");
}

export interface Attempt {
  answer: SwitchboardIntent;
  durationMs: number;
  timedOut: boolean;
  failed: boolean;
}
const labelKey = (value: Pick<SwitchboardIntent, "intent" | "target" | "request_now">) =>
  JSON.stringify([value.intent, value.target, value.request_now]);

export function repeatedReport(cases: Case[], runs: Attempt[][], threshold: number, misses: boolean): string {
  const lines: string[] = [];
  for (const [index, attempts] of runs.entries()) {
    lines.push(`Run ${index + 1}:`, report(cases, attempts.map((a) => a.answer), attempts.map((a) => a.durationMs), threshold));
    const timeouts = attempts.filter((a) => a.timedOut).length;
    const errors = attempts.filter((a) => a.failed).length;
    const wrong = attempts.filter((a, i) => !a.timedOut && !a.failed && labelKey(a.answer) !== labelKey(cases[i])).length;
    lines.push(`Timeouts: ${timeouts}; provider errors: ${errors}; wrong answers excluding timeouts/errors: ${wrong}`);
    if (misses) attempts.forEach((attempt, i) => {
      if (labelKey(attempt.answer) !== labelKey(cases[i]) || attempt.timedOut || attempt.failed) {
        const { utterance, ...expected } = cases[i];
        lines.push(JSON.stringify({ run: index + 1, utterance, expected, got: attempt.answer, latencyMs: Math.round(attempt.durationMs), timedOut: attempt.timedOut, failed: attempt.failed }));
      }
    });
  }
  if (runs.length > 1) {
    let flipped = 0, actionFlipped = 0;
    for (let i = 0; i < cases.length; i++) {
      const keys = new Set(runs.map((run) => labelKey(run[i].answer)));
      const actions = new Set(runs.map((run) => {
        const a = run[i].answer;
        return a.intent !== "none" && a.request_now && a.confidence >= threshold ? labelKey(a) : "none";
      }));
      if (keys.size > 1) flipped++;
      if (actions.size > 1) actionFlipped++;
    }
    lines.push(`Per-case consistency: ${cases.length - flipped}/${cases.length} stable; ${flipped}/${cases.length} flipped between runs (intent/target/request_now).`);
    lines.push(`Action decisions flipped: ${actionFlipped}/${cases.length} (includes confidence gate and timeout fallback).`);
  }
  return lines.join("\n");
}

export function parseRuns(argv: string[]): number {
  const index = argv.indexOf("--runs");
  if (index === -1) return 1;
  const raw = argv[index + 1];
  if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) throw new Error("--runs must be an integer in 1..100");
  return Number(raw);
}

if (import.meta.main) {
  if (process.argv.includes("--help")) {
    console.log("bun run bench/intent-bench.ts [--home CONFIG_DIRECTORY] [--runs N] [--misses]\nUses web_voice.tldr and switchboard settings; fixed synthetic roster, no side effects. Runs default to 1 (maximum 100).");
  } else {
    try {
      const count = parseRuns(process.argv);
      const homeIndex = process.argv.indexOf("--home");
      if (homeIndex !== -1 && !process.argv[homeIndex + 1]) throw new Error("missing home");
      const config = loadConfig({}, { home: homeIndex === -1 ? undefined : process.argv[homeIndex + 1] });
      const classifier = summarizerClassifier(config.raw.web_voice?.tldr, true);
      if (!classifier) throw new Error("missing classifier");
      const cases: Case[] = (await Bun.file(new URL("./intent/cases.jsonl", import.meta.url)).text()).trim().split("\n").map((line) => JSON.parse(line));
      const runs: Attempt[][] = [];
      for (let run = 0; run < count; run++) {
        const attempts: Attempt[] = [];
        for (const item of cases) {
          let measurement = { timedOut: false, failed: false, durationMs: 0 };
          const answer = await classifySwitchboardIntent(classifier, item.utterance, BENCH_ROSTER, new AbortController().signal,
            config.raw.switchboard?.intent_timeout_ms ?? 1500, (value) => { measurement = value; });
          attempts.push({ answer, ...measurement });
        }
        runs.push(attempts);
      }
      console.log(repeatedReport(cases, runs, config.raw.switchboard?.intent_min_confidence ?? 0.7, process.argv.includes("--misses")));
    } catch {
      console.error("Intent bench failed. Check --runs (1..100), the config directory and web_voice.tldr.summarizer_url; provider details are not logged.");
      process.exitCode = 1;
    }
  }
}
