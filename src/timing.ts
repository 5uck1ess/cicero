/**
 * Per-turn latency instrumentation for the voice loop — OFF by default.
 *
 * Enable by setting `CICERO_TIMING=1` (or true/yes/on) in the environment. When
 * disabled, {@link newTurnTimer} returns a shared no-op so the hot path pays
 * nothing and behavior is byte-identical to before — nothing in a live turn
 * changes unless you opt in.
 *
 * It answers the only latency question the user actually feels: where do the
 * milliseconds between "they stopped talking" and "first audio" go? Marks are
 * recorded as offsets from turn start; {@link TurnTimer.report} logs each mark
 * with the delta from the previous one, so a line reads e.g.:
 *   ⏱ web-turn: stt=140ms(+140)  brain_first_token=520ms(+380)  first_sentence=610ms(+90)  first_audio=650ms(+40)
 * making the dominant segment obvious at a glance.
 */
import { log } from "./logger";

export interface TurnTimer {
  /** Record a named checkpoint at the current time (offset from turn start). */
  mark(name: string): void;
  /** Log all marks (with inter-mark deltas) under `label`. No-op if never marked. */
  report(label?: string): void;
  /** Whether this timer actually records (i.e. instrumentation is enabled). */
  readonly enabled: boolean;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
export const timingEnabled = TRUTHY.has((process.env.CICERO_TIMING ?? "").toLowerCase());

class RealTurnTimer implements TurnTimer {
  readonly enabled = true;
  private readonly t0 = performance.now();
  private readonly marks: Array<{ name: string; at: number }> = [];

  mark(name: string): void {
    this.marks.push({ name, at: performance.now() - this.t0 });
  }

  report(label = "turn"): void {
    if (this.marks.length === 0) return;
    let prev = 0;
    const parts = this.marks.map(({ name, at }) => {
      const delta = at - prev;
      prev = at;
      return `${name}=${at.toFixed(0)}ms(+${delta.toFixed(0)})`;
    });
    log("info", `⏱ ${label}: ${parts.join("  ")}`);
  }
}

const NOOP: TurnTimer = {
  enabled: false,
  mark() {},
  report() {},
};

/** A fresh timer for one turn — real when CICERO_TIMING is set, else a no-op. */
export function newTurnTimer(): TurnTimer {
  return timingEnabled ? new RealTurnTimer() : NOOP;
}
