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
  private outstanding = new Map<number, { durationMs: number; sentAt: number; expectedEnd: number }>();
  private unplayedMs = 0;
  private waiter: { durationMs: number; resolve: () => void; reject: (error: Error) => void; signal: AbortSignal; onAbort: () => void; timer: ReturnType<typeof setTimeout>; deadline: number } | null = null;

  constructor(private readonly clock: PacingClock = realClock, private readonly maxMs = MAX_UNPLAYED_AUDIO_MS,
    private readonly maxClips = MAX_UNACKED_AUDIO_CLIPS, private readonly stallMs = AUDIO_ACK_STALL_MS) {}

  get pendingMs(): number { return this.unplayedMs; }
  get pendingClips(): number { return this.outstanding.size; }
  get expectedPlaybackEndMs(): number { return [...this.outstanding.values()].at(-1)?.expectedEnd ?? this.clock.now(); }
  canSend(durationMs: number): boolean { return this.hasCapacity(durationMs); }

  async waitForCapacity(durationMs: number, signal: AbortSignal): Promise<void> {
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("invalid reply audio duration");
    if (signal.aborted) throw new Error("web voice audio turn aborted");
    // Admission is owned by snapshotSynthesizedWav; any admitted clip may use
    // the empty queue even when its duration exceeds the ordinary credit cap.
    if (this.hasCapacity(durationMs)) return;
    if (this.waiter) throw new Error("concurrent web voice audio producers");
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => this.finish(new Error("web voice audio turn aborted"));
      const deadline = this.expectedPlaybackEndMs + this.stallMs;
      const timer = this.clock.setTimer(() => this.timeout(), Math.max(1, deadline - this.clock.now() + 1));
      this.waiter = { durationMs, resolve, reject, signal, onAbort, timer, deadline };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  track(sequence: number, durationMs: number): void {
    const sentAt = this.clock.now();
    const expectedEnd = Math.max(sentAt, this.expectedPlaybackEndMs) + durationMs;
    this.outstanding.set(sequence, { durationMs, sentAt, expectedEnd });
    this.unplayedMs += durationMs;
  }

  acknowledge(sequence: number): boolean {
    const clip = this.outstanding.get(sequence);
    if (clip === undefined) return false;
    this.outstanding.delete(sequence);
    this.unplayedMs = Math.max(0, this.unplayedMs - clip.durationMs);
    // The ack is observed playback progress. Rebase the remaining sequential
    // estimate from this observation, including any chunks queued behind it.
    let expectedEnd = this.clock.now();
    for (const pending of this.outstanding.values()) {
      pending.expectedEnd = expectedEnd += pending.durationMs;
    }
    if (this.waiter) {
      if (this.hasCapacity(this.waiter.durationMs)) this.finish();
      else {
        this.clock.clearTimer(this.waiter.timer);
        this.waiter.deadline = this.expectedPlaybackEndMs + this.stallMs;
        this.waiter.timer = this.clock.setTimer(() => this.timeout(), Math.max(1, this.waiter.deadline - this.clock.now() + 1));
      }
    }
    return true;
  }

  private hasCapacity(durationMs: number): boolean {
    return this.outstanding.size === 0 || (this.outstanding.size < this.maxClips
      && this.unplayedMs + durationMs <= this.maxMs);
  }

  private timeout(): void {
    if (!this.waiter) return;
    const remaining = this.waiter.deadline - this.clock.now();
    if (remaining >= 0) this.waiter.timer = this.clock.setTimer(() => this.timeout(), remaining + 1);
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
