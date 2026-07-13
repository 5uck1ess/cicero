import { test, expect } from "bun:test";
import { ClapDetector, framePeak, type ClapEvent } from "../../src/listener/clap-detector";

/** Feed a (peak, tMs) sequence and collect the non-null events it produces. */
function run(seq: Array<[number, number]>, opts = {}): ClapEvent[] {
  const det = new ClapDetector(opts);
  const out: ClapEvent[] = [];
  for (const [peak, t] of seq) {
    const e = det.feed(peak, t);
    if (e) out.push(e);
  }
  return out;
}

test("two claps inside the gap window report a double", () => {
  const events = run([
    [0.0, 0],
    [0.9, 64],   // first clap
    [0.0, 128],  // release (re-arm)
    [0.9, 192],  // second clap, gap 128ms ∈ [80,600]
  ]);
  expect(events).toEqual(["single", "double"]);
});

test("a single clap never reports a double", () => {
  const events = run([
    [0.0, 0],
    [0.9, 64],
    [0.0, 128],
    [0.0, 600],
  ]);
  expect(events).toEqual(["single"]);
});

test("claps farther apart than maxGap stay two singles", () => {
  const events = run([
    [0.9, 0],    // first clap
    [0.0, 64],   // release
    [0.9, 800],  // gap 800ms > 600 maxGap → fresh single, not a double
    [0.0, 864],
  ]);
  expect(events).toEqual(["single", "single"]);
});

test("a second onset faster than minGap is not a double", () => {
  const events = run([
    [0.9, 0],    // first clap
    [0.0, 30],   // brief release
    [0.9, 60],   // gap 60ms < 80 minGap → treated as the same clap's ring
    [0.0, 120],
  ]);
  expect(events).toEqual(["single", "single"]);
});

test("a sustained loud signal fires only once (hysteresis, no re-arm)", () => {
  const events = run([
    [0.9, 0],
    [0.9, 64],
    [0.9, 128],
    [0.9, 192],
  ]);
  expect(events).toEqual(["single"]);
});

test("framePeak decodes little-endian PCM and normalizes to [0,1]", () => {
  expect(framePeak(new Uint8Array([0, 0, 0, 0]))).toBe(0); // silence
  // 0x4000 = 16384 → 0.5
  expect(framePeak(new Uint8Array([0x00, 0x40]))).toBeCloseTo(0.5, 4);
  // 0x8000 = -32768 → full-scale magnitude 1.0
  expect(framePeak(new Uint8Array([0x00, 0x80]))).toBeCloseTo(1.0, 4);
  // peak is the max magnitude across the frame
  expect(framePeak(new Uint8Array([0x00, 0x10, 0x00, 0x80]))).toBeCloseTo(1.0, 4);
});
