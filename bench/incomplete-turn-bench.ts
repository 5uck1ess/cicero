// Synthetic pipeline overhead only. No network, acoustic or model accuracy claim.
// Run: bun run bench/incomplete-turn-bench.ts
import { IncompleteTurnFilter } from "../src/web-voice/incomplete";
import { streamWebTurn, type WebStreamDeps, type WebReplySink } from "../src/web-voice/turn";

const sink: WebReplySink = {
  transcript() {}, sentence() {}, audio() {}, control() {}, done() {},
  error(message) { throw new Error(message); }, aborted: () => false,
};
const baseline: WebStreamDeps = {
  streamFinal: Promise.resolve("run the tests"),
  stt: { transcribe: async () => "run the tests" },
  brain: { send: async () => "" },
  tts: { generateAudio: async () => new ArrayBuffer(0) },
};
const enabled = { ...baseline, incomplete: new IncompleteTurnFilter(async () => "complete") };
const samples: number[][] = [[], []];
for (let round = 0; round < 2200; round++) {
  // Alternate order to reduce JIT/order bias. First 200 pairs warm both paths.
  for (const index of round % 2 ? [1, 0] : [0, 1]) {
    const started = performance.now();
    await streamWebTurn(new ArrayBuffer(0), index ? enabled : baseline, sink);
    if (round >= 200) samples[index]!.push(performance.now() - started);
  }
}
for (const [i, label] of ["off (no classifier)", "on (instant complete classifier)"] .entries()) {
  const sorted = samples[i]!.sort((a, b) => a - b);
  console.log(`${label}: n=${sorted.length} median=${sorted[1000]!.toFixed(4)}ms p95=${sorted[1900]!.toFixed(4)}ms`);
}
console.log("Real enabled overhead adds classifier latency (default deadline 250ms); complete verdicts add no silence wait.");
