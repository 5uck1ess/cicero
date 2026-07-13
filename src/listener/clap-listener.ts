import { log } from "../logger";
import { ClapDetector, framePeak } from "./clap-detector";
import type { AecAudioHub } from "../platform/aec-hub";
import { terminateDirectChild } from "../process/direct-child";

export interface ClapListenerOptions {
  /** Fired when a double-clap is detected. */
  onDoubleClap: () => void;
  threshold?: number;
  minGapMs?: number;
  maxGapMs?: number;
  sampleRate?: number;
  /** Samples per analysis frame (default 1024 ≈ 64ms at 16kHz). */
  frameSamples?: number;
  /**
   * When set, read the mic from the AEC hub instead of spawning sox. Required with
   * AEC on: the helper holds the input device via macOS Voice Processing, so a
   * second `rec` on the same device is starved (returns no audio). The hub feeds
   * the same s16le frames, so clap detection works without a contending recorder.
   */
  micHub?: AecAudioHub;
  /** Test/platform adapters; production defaults use the current host and Bun. */
  platform?: string;
  which?: (binary: string) => string | null;
  spawnHelper?: typeof Bun.spawn;
}

/**
 * Listens for a double-clap to activate voice mode, hands-free.
 *
 * Feeds per-frame peak amplitude to a pure ClapDetector. The mic comes from sox
 * (`rec`) normally, or — when AEC is on — from the persistent AEC hub, because the
 * Voice-Processing helper owns the input device and a second sox client gets no
 * audio. Runs ONLY while voice mode is off: the daemon stops it before the
 * conversational recorder takes the mic (or the hub sink), so the two never
 * contend. Frame time is a monotonic frame counter (not wall clock) so detection
 * is immune to scheduling jitter.
 */
export class ClapListener {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private readTask: Promise<void> | null = null;
  private procTermination: {
    proc: ReturnType<typeof Bun.spawn>;
    task: Promise<void>;
    error: Error | null;
  } | null = null;
  private desiredRunning = false;
  private lifecycleEpoch = 0;
  private startOperation: Promise<void> | null = null;
  private startOperationEpoch = 0;
  private running = false;
  private readonly detector: ClapDetector;
  private readonly onDoubleClap: () => void;
  private readonly sampleRate: number;
  private readonly frameSamples: number;
  private readonly micHub: AecAudioHub | null;
  private readonly platform: string;
  private readonly which: (binary: string) => string | null;
  private readonly spawnHelper: typeof Bun.spawn;
  // CICERO_VAD_DEBUG=1 logs the loudest clap peak seen each ~second, so you can see
  // whether claps actually clear the detector threshold through the mic path.
  private readonly debug = !!process.env.CICERO_VAD_DEBUG;
  private dbgMaxPeak = 0;
  private dbgWindowStart = 0;
  // Frame-buffering state, shared by the sox and hub feed paths.
  private carry = new Uint8Array(0);
  private frameIndex = 0;

  constructor(opts: ClapListenerOptions) {
    this.onDoubleClap = opts.onDoubleClap;
    this.sampleRate = opts.sampleRate ?? 16000;
    this.frameSamples = opts.frameSamples ?? 1024;
    this.micHub = opts.micHub ?? null;
    this.platform = opts.platform ?? process.platform;
    this.which = opts.which ?? ((binary) => Bun.which(binary));
    this.spawnHelper = opts.spawnHelper ?? Bun.spawn;
    this.detector = new ClapDetector({
      threshold: opts.threshold,
      minGapMs: opts.minGapMs,
      maxGapMs: opts.maxGapMs,
    });
  }

  async start(): Promise<void> {
    const epoch = this.setDesiredRunning(true);
    while (this.shouldRun(epoch)) {
      if (this.running) return;
      const pending = this.startOperation;
      if (pending) {
        const pendingEpoch = this.startOperationEpoch;
        await pending;
        if (pendingEpoch === epoch) return;
        continue;
      }

      const operation = this.startOwned(epoch);
      this.startOperation = operation;
      this.startOperationEpoch = epoch;
      try {
        await operation;
      } finally {
        if (this.startOperation === operation) {
          this.startOperation = null;
          this.startOperationEpoch = 0;
        }
      }
      return;
    }
  }

  private async startOwned(epoch: number): Promise<void> {
    if (!this.shouldRun(epoch)) return;
    const staleProc = this.proc;
    if (staleProc) {
      try {
        await this.terminateRecorder(staleProc);
      } catch (err: unknown) {
        log("info", `Clap-to-activate remains disarmed: prior recorder cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    if (!this.shouldRun(epoch) || this.running) return;
    this.running = true;
    this.detector.reset();
    this.carry = new Uint8Array(0);
    this.frameIndex = 0;

    // AEC on: read the echo-cancelled mic from the hub (no second recorder).
    if (this.micHub) {
      const hub = this.micHub;
      if (!hub.isRunning()) {
        this.running = false;
        hub.setMicSink(null);
        log("info", "Clap-to-activate unavailable: AEC microphone hub is stopped");
        return;
      }
      const onEnd = (): void => {
        // A late callback from an older stop/start epoch must not disarm the new
        // owner. The current epoch stays desired so an explicit start can retry.
        if (!this.shouldRun(epoch) || !this.running) return;
        this.running = false;
        hub.setMicSink(null);
        log("info", "Clap listener AEC stream ended — activation gesture disarmed");
      };
      hub.setMicSink(
        (chunk) => {
          if (this.shouldRun(epoch) && this.running) this.feedBytes(chunk);
        },
        onEnd,
      );
      // A helper failure between the first check and sink registration invokes
      // onEnd in the real hub. Keep this explicit check for adapters as well.
      if (!hub.isRunning()) {
        onEnd();
        return;
      }
      log("ok", "👏 Clap-to-activate armed (double-clap to start voice mode)");
      return;
    }

    // sox front-end differs by platform, matching recorder-sox/recorder-windows:
    // `rec` on macOS/Linux, `sox -d` (default device) on Windows.
    const binary = this.platform === "win32" ? "sox" : "rec";
    if (!this.which(binary)) {
      log("info", `Clap-to-activate unavailable: '${binary}' (sox) not found on PATH`);
      this.running = false;
      return;
    }
    // Raw signed 16-bit mono PCM straight to stdout — no silence gate or
    // companding, so transients survive intact for peak analysis.
    const raw = ["-q", "-t", "raw", "-e", "signed-integer", "-b", "16", "-c", "1", "-r", String(this.sampleRate), "-"];
    const command = this.platform === "win32" ? ["sox", "-d", ...raw] : ["rec", ...raw];
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = this.spawnHelper(command, { stdout: "pipe", stderr: "ignore" });
    } catch (err: unknown) {
      this.running = false;
      log("info", `Clap-to-activate could not start: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.proc = proc;
    const readTask = this.readLoop(proc);
    this.readTask = readTask;
    void readTask.catch((err: unknown) => {
      log("info", `Clap-listener cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    log("ok", "👏 Clap-to-activate armed (double-clap to start voice mode)");
  }

  async stop(): Promise<void> {
    this.setDesiredRunning(false);
    if (!this.running && !this.proc && !this.procTermination) return;
    this.running = false;
    // Release the hub sink so the conversational recorder can take the mic.
    this.micHub?.setMicSink(null);
    const proc = this.proc;
    const readTask = this.readTask;
    if (proc) await this.terminateRecorder(proc);
    if (readTask) await readTask;
  }

  private setDesiredRunning(desired: boolean): number {
    if (this.desiredRunning !== desired) {
      this.desiredRunning = desired;
      this.lifecycleEpoch++;
    }
    return this.lifecycleEpoch;
  }

  private shouldRun(epoch: number): boolean {
    return this.desiredRunning && this.lifecycleEpoch === epoch;
  }

  private async readLoop(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const stdout = proc.stdout;
    if (!stdout || typeof stdout === "number") {
      if (this.proc === proc) this.running = false;
      await this.terminateRecorder(proc);
      return;
    }
    const reader = stdout.getReader();

    try {
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) this.feedBytes(value);
      }
    } catch (err: unknown) {
      if (this.running) {
        log("info", `Clap listener stream ended: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* stream already torn down */ }
      if (this.proc === proc) {
        const endedUnexpectedly = this.running;
        this.running = false;
        if (endedUnexpectedly) log("info", "Clap listener audio stream ended — activation gesture disarmed");
        await this.terminateRecorder(proc);
      }
      if (this.proc === null) this.readTask = null;
    }
  }

  /** Idempotently terminate/reap the exact sox recorder before mic handoff. */
  private terminateRecorder(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const prior = this.procTermination;
    if (prior?.proc === proc && prior.error === null) return prior.task;
    if (this.procTermination === prior) this.procTermination = null;

    const attempt: {
      proc: ReturnType<typeof Bun.spawn>;
      task: Promise<void>;
      error: Error | null;
    } = { proc, task: Promise.resolve(), error: null };
    attempt.task = terminateDirectChild(proc)
      .then(() => {
        if (this.proc === proc) this.proc = null;
      })
      .catch((err: unknown) => {
        attempt.error = err instanceof Error ? err : new Error(String(err));
        throw attempt.error;
      })
      .finally(() => {
        if (attempt.error === null && this.procTermination === attempt) this.procTermination = null;
      });
    this.procTermination = attempt;
    return attempt.task;
  }

  /**
   * Frame a PCM byte chunk (any size) and feed each full frame's peak to the
   * detector. Source-agnostic: called from the sox read loop and the hub sink.
   */
  private feedBytes(value: Uint8Array): void {
    const frameBytes = this.frameSamples * 2; // 16-bit
    const frameMs = (this.frameSamples / this.sampleRate) * 1000;
    const buf = this.carry.length ? concat(this.carry, value) : value;
    let off = 0;
    while (buf.length - off >= frameBytes) {
      // subarray is a view (no copy, no alignment requirement); framePeak decodes
      // the little-endian PCM bytes itself.
      const peak = framePeak(buf.subarray(off, off + frameBytes));
      const tMs = this.frameIndex * frameMs;
      const event = this.detector.feed(peak, tMs);
      this.frameIndex++;
      off += frameBytes;
      if (event === "double" && this.running) {
        this.onDoubleClap();
      }
      if (this.debug) {
        if (peak > this.dbgMaxPeak) this.dbgMaxPeak = peak;
        if (tMs - this.dbgWindowStart >= 1000) {
          log("info", `clap-dbg: maxPeak=${this.dbgMaxPeak.toFixed(4)} (threshold ${this.detector.onsetThreshold.toFixed(2)})`);
          this.dbgMaxPeak = 0;
          this.dbgWindowStart = tMs;
        }
      }
    }
    this.carry = off < buf.length ? buf.slice(off) : new Uint8Array(0);
  }
}

/** Concatenate two byte buffers (frame remainder + next chunk). */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
