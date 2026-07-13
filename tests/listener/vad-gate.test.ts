import { test, expect } from "bun:test";
import { VadGate, frameRms } from "../../src/listener/vad-gate";

const FRAME_MS = 30;

/** Feed a run of frames at one energy level; return the first non-null event. */
function feedLevel(gate: VadGate, rms: number, frames: number, startFrame: number): { event: string | null; nextFrame: number } {
  let event: string | null = null;
  let f = startFrame;
  for (let i = 0; i < frames; i++) {
    const e = gate.feed(rms, f * FRAME_MS);
    f++;
    if (e && !event) event = e;
  }
  return { event, nextFrame: f };
}

test("calibrates the noise floor then ignores quiet frames", () => {
  const gate = new VadGate({ calibrationMs: 300, openFactor: 3, minOpenRms: 0.012 });
  // 10 calibration frames (300ms) at a 0.01 floor, then more quiet frames.
  const cal = feedLevel(gate, 0.01, 10, 0);
  expect(cal.event).toBeNull();
  const quiet = feedLevel(gate, 0.01, 30, cal.nextFrame); // 0.01 < max(0.03, 0.012) open threshold
  expect(quiet.event).toBeNull();
  expect(gate.speaking).toBe(false);
});

test("emits 'start' only after speech persists past minSpeechMs", () => {
  const gate = new VadGate({ calibrationMs: 300, openFactor: 3, minSpeechMs: 120, minOpenRms: 0.012 });
  feedLevel(gate, 0.01, 10, 0); // calibrate, floor ~0.01 → open threshold 0.03

  // One loud frame is below the 120ms persistence requirement → no start yet.
  expect(gate.feed(0.2, 10 * FRAME_MS)).toBeNull();
  expect(gate.speaking).toBe(false);

  // Keep speaking: by ~120ms of sustained energy it should fire exactly once.
  let starts = 0;
  for (let f = 11; f < 20; f++) {
    if (gate.feed(0.2, f * FRAME_MS) === "start") starts++;
  }
  expect(starts).toBe(1);
  expect(gate.speaking).toBe(true);
});

test("a voiced blip shorter than minSpeechMs never starts a turn", () => {
  const gate = new VadGate({ calibrationMs: 300, openFactor: 3, minSpeechMs: 150, minOpenRms: 0.012 });
  feedLevel(gate, 0.01, 10, 0);
  // Two loud frames (~60ms) then back to quiet — below the 150ms threshold.
  gate.feed(0.3, 10 * FRAME_MS);
  gate.feed(0.3, 11 * FRAME_MS);
  const after = feedLevel(gate, 0.01, 10, 12);
  expect(after.event).toBeNull();
  expect(gate.speaking).toBe(false);
});

test("a learned ambient floor skips per-turn calibration and catches immediate speech", () => {
  const gate = new VadGate({
    initialNoiseFloor: 0.01,
    calibrationMs: 300,
    openFactor: 3,
    minSpeechMs: 60,
    minOpenRms: 0.012,
  });

  // Speech starts with frame zero. A fresh 300ms calibration would consume this
  // whole short utterance; the carried floor opens after its 60ms qualification.
  const immediate = feedLevel(gate, 0.2, 4, 0);
  expect(immediate.event).toBe("start");
  expect(gate.speaking).toBe(true);
});

test("ends the turn one hangover after speech stops", () => {
  const gate = new VadGate({ calibrationMs: 300, openFactor: 3, minSpeechMs: 60, hangoverMs: 300, minOpenRms: 0.012 });
  feedLevel(gate, 0.01, 10, 0);
  const spoke = feedLevel(gate, 0.2, 10, 10); // sustained speech → start
  expect(spoke.event).toBe("start");

  // Go quiet. hangoverMs=300 ≈ 10 frames; "end" must arrive within that window.
  let endFrame: number | null = null;
  let f = spoke.nextFrame;
  for (let i = 0; i < 20; i++) {
    if (gate.feed(0.005, f * FRAME_MS) === "end") { endFrame = f; break; }
    f++;
  }
  expect(endFrame).not.toBeNull();
  // Ended ~300ms after the last voiced frame (spoke.nextFrame - 1), not instantly.
  const lastVoiced = spoke.nextFrame - 1;
  expect((endFrame! - lastVoiced) * FRAME_MS).toBeGreaterThanOrEqual(300);
});

test("a noisy room raises the bar — the same energy that opens a quiet room stays closed", () => {
  // Quiet room (floor ~0.01 → open threshold ~0.03): a 0.08 utterance opens.
  const quiet = new VadGate({ calibrationMs: 300, openFactor: 3, minSpeechMs: 60, minOpenRms: 0.012 });
  feedLevel(quiet, 0.01, 11, 0);
  expect(feedLevel(quiet, 0.08, 8, 11).event).toBe("start");

  // Noisy room (floor ~0.05 → open threshold ~0.15): the SAME 0.08 stays below it → no start.
  const noisy = new VadGate({ calibrationMs: 300, openFactor: 3, minSpeechMs: 60, minOpenRms: 0.012 });
  feedLevel(noisy, 0.05, 11, 0);
  expect(feedLevel(noisy, 0.08, 20, 11).event).toBeNull();
});

test("ends the turn on a pause whose ambient exceeds the seeded close threshold", () => {
  // Regression for the 30s-cap bug: calibration caught a very quiet instant
  // (0.002), so a static close threshold would sit at its ~0.0072 floor — below
  // the room's real between-sentence ambient (0.012) — and never register the
  // pause. The continuously-tracked floor must rise to ambient and end the turn.
  const gate = new VadGate({ calibrationMs: 300, openFactor: 3, closeFactor: 2, minSpeechMs: 60, hangoverMs: 500, minOpenRms: 0.012 });
  feedLevel(gate, 0.002, 10, 0); // quiet calibration → seeded floor 0.002
  const spoke = feedLevel(gate, 0.25, 25, 10); // a sentence
  expect(spoke.event).toBe("start");

  // Now a real pause at 0.012 ambient — above the old static floor (0.0072).
  let ended = false;
  let f = spoke.nextFrame;
  for (let i = 0; i < 60; i++) {
    if (gate.feed(0.012, f * FRAME_MS) === "end") { ended = true; break; }
    f++;
  }
  expect(ended).toBe(true);
});

test("frameRms is zero for silence and ~1 for a full-scale tone", () => {
  expect(frameRms(new Uint8Array(64))).toBe(0);

  // 16 samples pinned to +full-scale (0x7FFF) → RMS ≈ 1.
  const full = new Uint8Array(32);
  const view = new DataView(full.buffer);
  for (let i = 0; i < 16; i++) view.setInt16(i * 2, 32767, true);
  expect(frameRms(full)).toBeCloseTo(1, 2);
});
