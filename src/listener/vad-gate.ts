/**
 * Streaming voice-activity gate — pure, frame-driven logic with no I/O.
 *
 * This is how production voice stacks end a turn, and why the old sox approach
 * hung: an absolute volume threshold (`silence 2%`) only fires when the raw
 * signal drops below a fixed loudness, so a room whose noise floor sits above
 * that level never registers silence and records to the cap. Instead this gate:
 *
 *   1. seeds the room's noise floor over `calibrationMs` (or resumes a floor
 *      learned by a previous capture),
 *   2. tracks that floor *continuously* with a fall-fast / rise-slow estimator,
 *      so it sits at the true ambient minimum regardless of what's being spoken —
 *      a single quiet calibration instant can't leave the close threshold stuck
 *      below the real between-sentence ambient (which made turns run to the cap),
 *   3. opens when energy rises an `openFactor` above the floor (relative, so it
 *      self-adjusts to any room),
 *   4. ends the turn a fixed `hangoverMs` after speech stops — the "slight pause
 *      after you finish talking" that makes it feel like a real conversation.
 *
 * Fed one frame's RMS energy at a time; reports onset/offset events. Keeping it
 * pure makes it deterministic and unit-testable — the audio plumbing lives in
 * VadRecorder.
 */

export interface VadGateOptions {
  /** Seed the room's noise floor over this long before listening (ms). */
  calibrationMs?: number; // default 300
  /** Open threshold = max(noiseFloor * openFactor, minOpenRms). */
  openFactor?: number; // default 3.0
  /** Hysteresis: stay "voiced" until energy falls below noiseFloor * closeFactor. */
  closeFactor?: number; // default 2.0
  /** Floor for the open threshold so a dead-silent room can't make it ~0. */
  minOpenRms?: number; // default 0.012
  /** Speech must persist this long before a turn officially starts (rejects clicks). */
  minSpeechMs?: number; // default 120
  /** End the turn this long after the last voiced frame. */
  hangoverMs?: number; // default 500
  /** Time constant for the floor falling toward a new quiet level (ms, fast). */
  floorFallMs?: number; // default 100
  /** Time constant for the floor rising through louder/speech energy (ms, slow). */
  floorRiseMs?: number; // default 4000
  /** Previously learned ambient floor; skips a fresh calibration window. */
  initialNoiseFloor?: number;
}

export type VadEvent = "start" | "end" | null;

type Phase = "calibrating" | "waiting" | "speaking";

export class VadGate {
  private readonly calibrationMs: number;
  private readonly openFactor: number;
  private readonly closeFactor: number;
  private readonly minOpenRms: number;
  private readonly minSpeechMs: number;
  private readonly hangoverMs: number;
  private readonly floorFallMs: number;
  private readonly floorRiseMs: number;
  private readonly initialNoiseFloor: number | null;

  private phase: Phase = "calibrating";
  private startMs: number | null = null; // first frame's timestamp
  private lastMs: number | null = null; // previous frame's timestamp (for dt)
  private noiseFloor = 0; // continuously-tracked ambient energy
  private calibFrames = 0;
  private openThreshold = 0;
  private closeThreshold = 0;
  private voicedSinceMs: number | null = null; // start of the current voiced run (while waiting)
  private lastVoiceMs = 0; // last frame above closeThreshold (while speaking)

  constructor(opts: VadGateOptions = {}) {
    this.calibrationMs = opts.calibrationMs ?? 300;
    this.openFactor = opts.openFactor ?? 3.0;
    this.closeFactor = opts.closeFactor ?? 2.0;
    this.minOpenRms = opts.minOpenRms ?? 0.012;
    this.minSpeechMs = opts.minSpeechMs ?? 120;
    this.hangoverMs = opts.hangoverMs ?? 500;
    this.floorFallMs = opts.floorFallMs ?? 100;
    this.floorRiseMs = opts.floorRiseMs ?? 4000;
    this.initialNoiseFloor = Number.isFinite(opts.initialNoiseFloor) && (opts.initialNoiseFloor ?? 0) > 0
      ? opts.initialNoiseFloor!
      : null;
    if (this.initialNoiseFloor !== null) {
      this.noiseFloor = this.initialNoiseFloor;
      this.phase = "waiting";
      this.recomputeThresholds();
    }
  }

  /**
   * Feed one frame's RMS energy (0..1) at monotonically increasing `tMs`.
   * Returns "start" when speech begins, "end" when the turn is complete (a
   * `hangoverMs` pause after the last speech), or null otherwise.
   */
  feed(rms: number, tMs: number): VadEvent {
    if (this.startMs === null) this.startMs = tMs;

    if (this.phase === "calibrating") {
      // Incremental mean to seed the floor; continuous tracking takes over after.
      this.noiseFloor += (rms - this.noiseFloor) / (this.calibFrames + 1);
      this.calibFrames++;
      if (tMs - this.startMs >= this.calibrationMs) {
        this.recomputeThresholds();
        this.phase = "waiting";
      }
      this.lastMs = tMs;
      return null;
    }

    // Continuously track the noise floor: fall fast toward quiet, rise slowly
    // through speech. This pins the floor at the true ambient minimum, so the
    // close threshold (floor × closeFactor) reliably stays *above* the ambient
    // in the gaps between sentences and a real pause is detected as silence.
    const dt = this.lastMs === null ? 0 : tMs - this.lastMs;
    this.lastMs = tMs;
    const tau = rms < this.noiseFloor ? this.floorFallMs : this.floorRiseMs;
    const alpha = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
    this.noiseFloor += alpha * (rms - this.noiseFloor);
    this.recomputeThresholds();

    if (this.phase === "waiting") {
      if (rms >= this.openThreshold) {
        if (this.voicedSinceMs === null) this.voicedSinceMs = tMs;
        if (tMs - this.voicedSinceMs >= this.minSpeechMs) {
          this.phase = "speaking";
          this.lastVoiceMs = tMs;
          return "start";
        }
      } else {
        this.voicedSinceMs = null; // run broken before it qualified as speech
      }
      return null;
    }

    // speaking: end the turn once we've gone quiet for the full hangover.
    if (rms >= this.closeThreshold) {
      this.lastVoiceMs = tMs;
    } else if (tMs - this.lastVoiceMs >= this.hangoverMs) {
      return "end";
    }
    return null;
  }

  private recomputeThresholds(): void {
    this.openThreshold = Math.max(this.noiseFloor * this.openFactor, this.minOpenRms);
    this.closeThreshold = Math.max(this.noiseFloor * this.closeFactor, this.minOpenRms * 0.6);
  }

  /** True once a turn has started — the caller keeps audio from here on. */
  get speaking(): boolean {
    return this.phase === "speaking";
  }

  /** Current tracked ambient noise floor (RMS). For diagnostics/tuning. */
  get floor(): number {
    return this.noiseFloor;
  }

  /** Current open threshold (RMS a frame must cross to start speech). Diagnostics. */
  get openThresholdRms(): number {
    return this.openThreshold;
  }

  reset(): void {
    this.phase = this.initialNoiseFloor === null ? "calibrating" : "waiting";
    this.startMs = null;
    this.lastMs = null;
    this.noiseFloor = this.initialNoiseFloor ?? 0;
    this.calibFrames = 0;
    this.openThreshold = 0;
    this.closeThreshold = 0;
    if (this.initialNoiseFloor !== null) this.recomputeThresholds();
    this.voicedSinceMs = null;
    this.lastVoiceMs = 0;
  }
}

/**
 * Root-mean-square energy of a little-endian signed 16-bit PCM frame, normalized
 * to [0,1]. RMS (not peak) is the right speech-presence signal — it tracks
 * sustained loudness rather than transient spikes. Decodes raw bytes directly so
 * callers can pass any subarray without worrying about Int16Array alignment.
 */
export function frameRms(pcm: Uint8Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    let v = (pcm[i] ?? 0) | ((pcm[i + 1] ?? 0) << 8);
    if (v >= 0x8000) v -= 0x10000; // sign-extend
    const f = v / 32768;
    sum += f * f;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}
