/** Per-v2-turn credit gate. One producer waits at a time; the caller owns the WAV. */
export const MAX_UNPLAYED_AUDIO_MS = 12_000;
export const MAX_UNACKED_AUDIO_CLIPS = 64;
export const AUDIO_ACK_STALL_MS = 30_000;

export interface PacingClock {
  now(): number;
  setTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const realClock: PacingClock = {
  now: () => Date.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (timer) => clearTimeout(timer),
};

export class AudioPlaybackGate {
  private outstanding = new Map<number, number>();
  private unplayedMs = 0;
  private waiter: { durationMs: number; resolve: () => void; reject: (error: Error) => void; signal: AbortSignal; onAbort: () => void; timer: ReturnType<typeof setTimeout>; deadline: number } | null = null;

  constructor(private readonly clock: PacingClock = realClock, private readonly maxMs = MAX_UNPLAYED_AUDIO_MS,
    private readonly maxClips = MAX_UNACKED_AUDIO_CLIPS, private readonly stallMs = AUDIO_ACK_STALL_MS) {}

  get pendingMs(): number { return this.unplayedMs; }
  get pendingClips(): number { return this.outstanding.size; }
  canSend(durationMs: number): boolean { return this.hasCapacity(durationMs); }

  async waitForCapacity(durationMs: number, signal: AbortSignal): Promise<void> {
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 120_000) throw new Error("invalid reply audio duration");
    if (signal.aborted) throw new Error("web voice audio turn aborted");
    // One already admitted oversized clip is bounded by the protocol's 120 s
    // maximum; subsequent clips wait until it has been acknowledged.
    if (this.hasCapacity(durationMs)) return;
    if (this.waiter) throw new Error("concurrent web voice audio producers");
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => this.finish(new Error("web voice audio turn aborted"));
      const deadline = this.clock.now() + this.stallMs;
      const timer = this.clock.setTimer(() => this.timeout(), this.stallMs);
      this.waiter = { durationMs, resolve, reject, signal, onAbort, timer, deadline };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  track(sequence: number, durationMs: number): void {
    this.outstanding.set(sequence, durationMs);
    this.unplayedMs += durationMs;
  }

  acknowledge(sequence: number): boolean {
    const duration = this.outstanding.get(sequence);
    if (duration === undefined) return false;
    this.outstanding.delete(sequence);
    this.unplayedMs = Math.max(0, this.unplayedMs - duration);
    if (this.waiter) {
      if (this.hasCapacity(this.waiter.durationMs)) this.finish();
      else {
        this.clock.clearTimer(this.waiter.timer);
        this.waiter.deadline = this.clock.now() + this.stallMs;
        this.waiter.timer = this.clock.setTimer(() => this.timeout(), this.stallMs);
      }
    }
    return true;
  }

  private hasCapacity(durationMs: number): boolean {
    return this.outstanding.size < this.maxClips
      && (this.unplayedMs + durationMs <= this.maxMs || this.outstanding.size === 0);
  }

  private timeout(): void {
    if (!this.waiter) return;
    const remaining = this.waiter.deadline - this.clock.now();
    if (remaining > 0) this.waiter.timer = this.clock.setTimer(() => this.timeout(), remaining);
    else this.finish(new Error("web voice audio acknowledgement timed out"));
  }

  private finish(error?: Error): void {
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = null;
    this.clock.clearTimer(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    if (error) waiter.reject(error);
    else waiter.resolve();
  }
}

/** v1 call clients have no playback acknowledgements, so only v2 is paced. */
export function waitForPlaybackCredit(protocol: 1 | 2, gate: AudioPlaybackGate, durationMs: number, signal: AbortSignal): Promise<void> {
  return protocol === 2 ? gate.waitForCapacity(durationMs, signal) : Promise.resolve();
}
