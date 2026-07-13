/**
 * Pure, deterministic end-of-turn fallback — a port of pipecat's `BaseSmartTurn`
 * silence-accumulation logic (also used by flowcat's `TurnSilenceTracker`).
 *
 * While speech is observed the silence counter resets; once silent, accumulated
 * silence past `stopMs` forces an end-of-turn — even with no ML model present.
 * Silence only accumulates *after* speech has been observed, so leading silence
 * never ends a turn.
 */
export class SilenceTracker {
  private stopMs: number;
  private silenceMs = 0;
  private speechSeen = false;

  constructor(stopSecs = 3.0) {
    this.stopMs = stopSecs * 1000;
  }

  /** Whether any speech has been observed in the current turn. */
  get speechTriggered(): boolean {
    return this.speechSeen;
  }

  setStopSecs(stopSecs: number): void {
    this.stopMs = stopSecs * 1000;
  }

  /** Clear all state for the next turn. */
  reset(): void {
    this.silenceMs = 0;
    this.speechSeen = false;
  }

  /**
   * Feed one analyzed frame. Returns true when accumulated silence now forces an
   * end-of-turn. A speech frame resets the silence counter; silence before any
   * speech is ignored.
   */
  update(isSpeech: boolean, frameMs: number): boolean {
    if (isSpeech) {
      this.speechSeen = true;
      this.silenceMs = 0;
      return false;
    }
    if (!this.speechSeen) return false;
    this.silenceMs += frameMs;
    return this.silenceMs >= this.stopMs;
  }
}
