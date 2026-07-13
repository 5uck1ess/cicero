import type { TurnDetector, TurnDetectorConfig } from "./provider";
import { SmartTurnProvider } from "./smart-turn";

export type { TurnDetector, TurnDetectorConfig, TurnPrediction } from "./provider";
export { SilenceTracker } from "./silence-tracker";
export { decideEndOfTurn } from "./policy";
export type { EndOfTurnDecision, EndOfTurnReason } from "./policy";
export { SmartTurnProvider } from "./smart-turn";

/**
 * Build a turn detector from config. Smart-Turn is the only backend in this spike;
 * the function is the extension point for future end-of-turn models.
 */
export function createTurnDetector(config: TurnDetectorConfig = {}): TurnDetector {
  return new SmartTurnProvider(config);
}
