import { test, expect } from "bun:test";
import { SilenceTracker } from "../../../src/backends/turn/silence-tracker";

test("leading silence (before any speech) never forces an end-of-turn", () => {
  const t = new SilenceTracker(1.0); // 1000ms
  for (let i = 0; i < 50; i++) {
    expect(t.update(false, 100)).toBe(false); // 5s of silence, no speech yet
  }
  expect(t.speechTriggered).toBe(false);
});

test("silence accumulates after speech and forces end-of-turn past the timeout", () => {
  const t = new SilenceTracker(1.0); // 1000ms
  expect(t.update(true, 100)).toBe(false); // speech
  expect(t.speechTriggered).toBe(true);
  expect(t.update(false, 400)).toBe(false); // 400ms silence
  expect(t.update(false, 400)).toBe(false); // 800ms
  expect(t.update(false, 400)).toBe(true); // 1200ms >= 1000ms → end
});

test("a speech frame resets the accumulated silence", () => {
  const t = new SilenceTracker(1.0);
  t.update(true, 100);
  t.update(false, 900); // 900ms silence — not yet
  expect(t.update(true, 100)).toBe(false); // speech resets
  expect(t.update(false, 900)).toBe(false); // back to 900ms, still under
});

test("reset clears speech + silence state", () => {
  const t = new SilenceTracker(1.0);
  t.update(true, 100);
  t.update(false, 1500);
  t.reset();
  expect(t.speechTriggered).toBe(false);
  expect(t.update(false, 2000)).toBe(false); // silence ignored again until speech
});
