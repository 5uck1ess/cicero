import { test, expect } from "bun:test";
import { decideEndOfTurn } from "../../../src/backends/turn/policy";

test("a confident complete prediction ends the turn immediately", () => {
  const d = decideEndOfTurn({ prediction: { complete: true, probability: 0.9 }, silenceForced: false });
  expect(d).toEqual({ endTurn: true, reason: "model-complete" });
});

test("a complete prediction below threshold does not end on its own", () => {
  const d = decideEndOfTurn({ prediction: { complete: true, probability: 0.4 }, silenceForced: false, threshold: 0.6 });
  expect(d).toEqual({ endTurn: false, reason: "waiting" });
});

test("an incomplete prediction keeps the mic open until the silence ceiling", () => {
  const waiting = decideEndOfTurn({ prediction: { complete: false, probability: 0.1 }, silenceForced: false });
  expect(waiting).toEqual({ endTurn: false, reason: "waiting" });

  const ceiling = decideEndOfTurn({ prediction: { complete: false, probability: 0.1 }, silenceForced: true });
  expect(ceiling).toEqual({ endTurn: true, reason: "silence-timeout" });
});

test("with no model, silence alone governs", () => {
  expect(decideEndOfTurn({ prediction: null, silenceForced: false })).toEqual({ endTurn: false, reason: "waiting" });
  expect(decideEndOfTurn({ prediction: null, silenceForced: true })).toEqual({ endTurn: true, reason: "silence-timeout" });
});
