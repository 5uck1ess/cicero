/** Owns one tentative interruption. Expiry resumes audio but keeps the token
 * valid so delayed real speech can still replace that same reply. */
export class FalseInterruption {
  private sequence = 0;
  private active = 0;
  private timer: ReturnType<typeof setTimeout> | number | undefined;
  constructor(private readonly timeoutMs: number, private readonly clock = {
    setTimer: (fn: () => void, ms: number): ReturnType<typeof setTimeout> | number => setTimeout(fn, ms),
    clearTimer: (id: ReturnType<typeof setTimeout> | number) => clearTimeout(id),
  }) {}
  start(resume: () => void): number {
    this.cancel();
    const token = this.active = ++this.sequence;
    this.timer = this.clock.setTimer(() => {
      this.timer = undefined;
      if (this.active === token) resume();
    }, this.timeoutMs);
    return token;
  }
  finish(token: number): boolean {
    if (!token || token !== this.active) return false;
    this.cancel();
    return true;
  }
  cancel(): void {
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined;
    this.active = 0;
  }
}
