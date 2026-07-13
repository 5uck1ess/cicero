/**
 * Double-clap detector — pure, frame-driven logic with no I/O.
 *
 * A clap is a short, high-amplitude transient, so (unlike speech end-of-turn)
 * raw energy IS the right signal — no model needed. The detector is fed one
 * frame's peak amplitude at a time and reports when two claps land close
 * together. Keeping it pure makes it deterministic and unit-testable; the audio
 * plumbing lives in ClapListener.
 */

export interface ClapDetectorOptions {
  /** Peak amplitude in [0,1] that counts as a clap onset. */
  threshold?: number;
  /** Signal must fall below threshold*releaseRatio before another onset can fire. */
  releaseRatio?: number;
  /** Ignore a second onset closer than this (one clap's own ring/echo). */
  minGapMs?: number;
  /** Second onset must arrive within this of the first to count as a double. */
  maxGapMs?: number;
}

export type ClapEvent = "single" | "double" | null;

export class ClapDetector {
  private readonly threshold: number;
  private readonly releaseRatio: number;
  private readonly minGapMs: number;
  private readonly maxGapMs: number;
  // Hysteresis: after an onset we wait for the signal to drop before re-arming,
  // so a single loud clap spanning several frames can't register as many onsets.
  private armed = true;
  private lastClapMs: number | null = null;

  constructor(opts: ClapDetectorOptions = {}) {
    this.threshold = opts.threshold ?? 0.5;
    this.releaseRatio = opts.releaseRatio ?? 0.5;
    this.minGapMs = opts.minGapMs ?? 80;
    this.maxGapMs = opts.maxGapMs ?? 600;
  }

  /**
   * Feed one frame's peak amplitude (0..1) at monotonically increasing `tMs`.
   * Returns "double" when a second clap lands in the gap window, "single" for a
   * first clap, or null otherwise.
   */
  feed(peak: number, tMs: number): ClapEvent {
    // Drop a stale first clap so an old single can't pair with a much later one.
    if (this.lastClapMs !== null && tMs - this.lastClapMs > this.maxGapMs) {
      this.lastClapMs = null;
    }

    if (this.armed && peak >= this.threshold) {
      this.armed = false; // refractory until the signal releases
      if (this.lastClapMs !== null) {
        const gap = tMs - this.lastClapMs;
        if (gap >= this.minGapMs && gap <= this.maxGapMs) {
          this.lastClapMs = null;
          return "double";
        }
      }
      this.lastClapMs = tMs;
      return "single";
    }

    if (!this.armed && peak < this.threshold * this.releaseRatio) {
      this.armed = true; // signal dropped → ready for the next onset
    }
    return null;
  }

  reset(): void {
    this.armed = true;
    this.lastClapMs = null;
  }

  /** The configured clap onset threshold (peak amplitude 0..1). For diagnostics. */
  get onsetThreshold(): number {
    return this.threshold;
  }
}

/**
 * Peak absolute amplitude of a little-endian signed 16-bit PCM frame, normalized
 * to [0,1]. Decodes raw bytes directly so callers can pass any subarray without
 * worrying about Int16Array 2-byte alignment.
 */
export function framePeak(pcm: Uint8Array): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    let v = (pcm[i] ?? 0) | ((pcm[i + 1] ?? 0) << 8);
    if (v >= 0x8000) v -= 0x10000; // sign-extend
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return peak / 32768;
}
