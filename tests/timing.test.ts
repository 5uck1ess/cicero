import { test, expect } from "bun:test";
import { newTurnTimer, timingEnabled } from "../src/timing";

// The instrumentation must be OFF unless CICERO_TIMING is set, so the live voice
// loop is byte-identical by default. The test suite runs without that env var.

test("timing is disabled by default (no CICERO_TIMING)", () => {
  expect(timingEnabled).toBe(false);
  expect(newTurnTimer().enabled).toBe(false);
});

test("the no-op timer accepts marks and report without throwing", () => {
  const t = newTurnTimer();
  expect(() => {
    t.mark("stt");
    t.mark("brain_first_token");
    t.report("web-turn");
  }).not.toThrow();
});
