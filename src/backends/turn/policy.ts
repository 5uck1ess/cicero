import type { TurnPrediction } from "./provider";

export type EndOfTurnReason = "model-complete" | "silence-timeout" | "waiting";

export interface EndOfTurnDecision {
  endTurn: boolean;
  reason: EndOfTurnReason;
}

/**
 * Combine a semantic turn prediction with the silence-timeout fallback — the
 * heart of the upgrade over plain silence detection:
 *
 * - model says complete (prob ≥ threshold) → end now (snappy turn-taking)
 * - else silence past the stop timeout → end (hard ceiling, never hang)
 * - else → waiting: likely a mid-thought pause, so keep the mic open instead of
 *   cutting the user off
 *
 * Pure and deterministic: `silenceForced` comes from {@link SilenceTracker} and
 * `prediction` is null when no model ran (then silence alone governs).
 */
export function decideEndOfTurn(opts: {
  prediction: TurnPrediction | null;
  silenceForced: boolean;
  threshold?: number;
}): EndOfTurnDecision {
  const threshold = opts.threshold ?? 0.6;
  const prediction = opts.prediction;

  if (prediction && prediction.complete && prediction.probability >= threshold) {
    return { endTurn: true, reason: "model-complete" };
  }
  if (opts.silenceForced) {
    return { endTurn: true, reason: "silence-timeout" };
  }
  return { endTurn: false, reason: "waiting" };
}
