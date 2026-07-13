import { log } from "../logger";
import { VadGate, frameRms, type VadGateOptions } from "./vad-gate";
import { ClapDetector, framePeak } from "./clap-detector";
import { encodeWav } from "../platform/wav";
import type { AecAudioHub } from "../platform/aec-hub";
import { terminateDirectChild } from "../process/direct-child";

/** Result of running the VAD gate over a frame stream (source-agnostic). */
interface GateResult {
  outcome: "ok" | "silent" | null;
  started: boolean;
  clapped: boolean;
  captured: Uint8Array[];
}

interface StreamReadResult {
  done: boolean;
  value?: Uint8Array;
}

interface VadCaptureContext {
  cancelled: boolean;
  hubController: ReadableStreamDefaultController<Uint8Array> | null;
  task: Promise<VadCaptureResult> | null;
}

/**
 * Optional double-clap gesture, detected from this recorder's own audio stream so
 * there's no second mic process competing with the conversational capture. A clap
 * is a sharp transient that peaks *above* TTS playback, so (unlike energy-relative
 * voice detection) it cuts through Cicero's own voice without echo cancellation —
 * which is exactly why it's the reliable "interrupt / deactivate" signal on open
 * speakers. `onDoubleClap` fires (and the capture aborts) when two claps land in
 * the gap window; the caller decides what the gesture means by current state.
 */
export interface ClapGestureOptions {
  threshold?: number;
  minGapMs?: number;
  maxGapMs?: number;
  onDoubleClap: () => void;
}

/**
 * Outcome of one VAD-gated capture. Mirrors the conversational listener's
 * CaptureResult so it can be returned straight through.
 */
export type VadCaptureResult =
  | { status: "ok"; path: string }
  | { status: "silent" } // gate armed but no speech arrived before the timeout
  | { status: "cancelled" } // stopped mid-capture (voice mode turned off)
  | { status: "error"; message: string }; // recorder couldn't run (e.g. no mic access)

export interface VadRecorderOptions extends VadGateOptions {
  sampleRate?: number; // default 16000
  frameMs?: number; // analysis frame size (default 30ms)
  prerollMs?: number; // audio retained before the detected onset (default 240)
  onsetTimeoutMs?: number; // give up waiting for speech to begin (default 30000)
  maxDurationMs?: number; // hard cap on a single utterance (default 30000)
  clapGesture?: ClapGestureOptions; // double-clap gesture (interrupt / deactivate)
  micHub?: AecAudioHub; // read echo-cancelled mic from the AEC hub instead of sox
  /** Test/platform adapters; production defaults use the current host and Bun. */
  platform?: string;
  which?: (binary: string) => string | null;
  spawnHelper?: typeof Bun.spawn;
}

/**
 * Voice-activity-gated recorder — the streaming end-of-turn the good voice stacks
 * use. Captures raw mono PCM from sox (no silence gate, no companding — those
 * defeated end-of-turn detection), runs it through a {@link VadGate}, and writes
 * only the spoken span (plus a short pre-roll so the first phoneme isn't clipped)
 * to a WAV for STT. Ambient calibration is retained across captures so immediate
 * follow-up speech is not discarded. The turn ends ~`hangoverMs` after the speaker stops.
 */
export class VadRecorder {
  private readonly sampleRate: number;
  private readonly frameMs: number;
  private readonly prerollMs: number;
  private readonly onsetTimeoutMs: number;
  private readonly maxDurationMs: number;
  private readonly gateOpts: VadGateOptions;
  private readonly clapDetector: ClapDetector | null;
  private readonly onDoubleClap: (() => void) | null;
  private readonly micHub: AecAudioHub | null;
  private readonly platform: string;
  private readonly which: (binary: string) => string | null;
  private readonly spawnHelper: typeof Bun.spawn;
  // Learned once and carried across turns. Recalibrating from scratch at the
  // start of every capture swallowed users who began speaking immediately.
  private ambientNoiseFloor: number | null = null;

  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private procTermination: {
    proc: ReturnType<typeof Bun.spawn>;
    task: Promise<void>;
    error: Error | null;
  } | null = null;
  private activeCapture: VadCaptureContext | null = null;
  // CICERO_VAD_DEBUG=1 logs one line per capture: the calibrated floor, the open
  // threshold, and the loudest frame seen — so a barge-in/clap that "doesn't work"
  // tells us WHY (floor poisoned high by TTS residual, or near-end too quiet to
  // cross the threshold) instead of just failing silently.
  private readonly debug = !!process.env.CICERO_VAD_DEBUG;
  // Whether a detected double-clap may break the current capture. A clap only does
  // something useful in two windows — interrupting a reply, or deactivating while
  // idle (clap.deactivate). Outside those, a clap must NOT cancel the capture, or it
  // would silently break the listen loop. The caller arms/disarms this per phase.
  private clapEnabled = true;

  constructor(opts: VadRecorderOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 16000;
    this.frameMs = opts.frameMs ?? 30;
    this.prerollMs = opts.prerollMs ?? 240;
    this.onsetTimeoutMs = opts.onsetTimeoutMs ?? 30000;
    this.maxDurationMs = opts.maxDurationMs ?? 30000;
    this.gateOpts = {
      calibrationMs: opts.calibrationMs,
      openFactor: opts.openFactor,
      closeFactor: opts.closeFactor,
      minOpenRms: opts.minOpenRms,
      minSpeechMs: opts.minSpeechMs,
      hangoverMs: opts.hangoverMs,
      floorFallMs: opts.floorFallMs,
      floorRiseMs: opts.floorRiseMs,
    };
    const clap = opts.clapGesture;
    this.onDoubleClap = clap?.onDoubleClap ?? null;
    this.clapDetector = clap
      ? new ClapDetector({ threshold: clap.threshold, minGapMs: clap.minGapMs, maxGapMs: clap.maxGapMs })
      : null;
    this.micHub = opts.micHub ?? null;
    this.platform = opts.platform ?? process.platform;
    this.which = opts.which ?? ((binary) => Bun.which(binary));
    this.spawnHelper = opts.spawnHelper ?? Bun.spawn;
  }

  /**
   * Arm or disarm the double-clap gesture for upcoming/active captures. Disarmed,
   * claps are ignored entirely (no cancellation), so a stray clap during the plain
   * listen can't break the loop. No-op when no clap gesture was configured.
   */
  setClapEnabled(enabled: boolean): void {
    this.clapEnabled = enabled;
  }

  /** Stop an in-progress capture (voice mode turned off). */
  async stop(): Promise<void> {
    const active = this.activeCapture;
    if (active) active.cancelled = true;
    // Hub path: stop consuming and close the bridge stream so a blocked read of
    // it returns done (we don't own the hub process, so never kill it).
    this.micHub?.setMicSink(null);
    try { active?.hubController?.close(); } catch { /* already closed */ }
    if (active) active.hubController = null;
    const proc = this.proc;
    const cleanup = proc ? this.terminateRecorder(proc) : Promise.resolve();
    const waits: Promise<unknown>[] = [cleanup];
    if (active?.task) waits.push(active.task);
    const [cleanupOutcome] = await Promise.allSettled(waits);
    if (cleanupOutcome?.status === "rejected") throw cleanupOutcome.reason;
  }

  /**
   * Capture one VAD-gated turn to `outPath`. `onsetTimeoutMs` overrides how long
   * to wait for speech to begin (used for bounded grace rounds); once speech is
   * flowing the timeout no longer applies. Reads from the AEC hub when configured,
   * else spawns sox.
   */
  capture(outPath: string, onsetTimeoutMs?: number): Promise<VadCaptureResult> {
    if (this.activeCapture) {
      return Promise.resolve({ status: "error", message: "capture already in progress" });
    }
    if (this.proc) {
      return Promise.resolve({ status: "error", message: "previous recorder has not been reaped" });
    }
    const context: VadCaptureContext = { cancelled: false, hubController: null, task: null };
    this.activeCapture = context;
    const operation = this.captureOwned(context, outPath, onsetTimeoutMs);
    const tracked = operation.finally(() => {
      if (this.activeCapture === context) this.activeCapture = null;
    });
    context.task = tracked;
    return tracked;
  }

  private async captureOwned(
    context: VadCaptureContext,
    outPath: string,
    onsetTimeoutMs?: number,
  ): Promise<VadCaptureResult> {
    this.clapDetector?.reset();
    // A configured AEC helper may fail after activation. Its running state is
    // cleared before direct-child cleanup finishes, so raw sox may claim the mic
    // only after the hub confirms the exact old helper has been reaped.
    const hub = this.micHub;
    if (hub?.isRunning()) return this.captureViaHub(context, outPath, onsetTimeoutMs);
    if (hub) {
      try {
        await hub.waitForRelease();
      } catch (error: unknown) {
        // A concurrent activation can legitimately make the hub usable while we
        // were awaiting the old helper. Prefer it; never start a competing raw mic.
        if (hub.isRunning()) return this.captureViaHub(context, outPath, onsetTimeoutMs);
        return {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (context.cancelled) return { status: "cancelled" };
      if (hub.isRunning()) return this.captureViaHub(context, outPath, onsetTimeoutMs);
    }

    const binary = this.platform === "win32" ? "sox" : "rec";
    if (!this.which(binary)) {
      return { status: "error", message: `'${binary}' (sox) not found on PATH` };
    }

    const sr = this.sampleRate;
    // Raw signed 16-bit mono PCM to stdout. highpass 80 trims room rumble; NO
    // `silence` gate and NO compand — the VAD owns end-of-turn now.
    const raw = ["-q", "-t", "raw", "-e", "signed-integer", "-b", "16", "-c", "1", "-r", String(sr), "-", "highpass", "80"];
    const command = this.platform === "win32" ? ["sox", "-d", ...raw] : ["rec", ...raw];
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = this.spawnHelper(command, { stdout: "pipe", stderr: "pipe" });
    } catch (err: unknown) {
      return { status: "error", message: `recorder failed to start: ${err instanceof Error ? err.message : String(err)}` };
    }
    this.proc = proc;

    const stderr = proc.stderr;
    const stderrText =
      stderr && typeof stderr !== "number"
        ? collectStderrTail(stderr).catch(() => "")
        : Promise.resolve("");

    const stdout = proc.stdout;
    if (!stdout || typeof stdout === "number") {
      try {
        await this.terminateRecorder(proc);
      } catch (err: unknown) {
        return {
          status: "error",
          message: `recorder cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return { status: "error", message: "recorder produced no audio stream" };
    }

    const onset = onsetTimeoutMs ?? this.onsetTimeoutMs;
    const reader = stdout.getReader();
    let result: GateResult;
    let cleanupError: unknown;
    try {
      result = await this.runGate(reader, onset, context);
    } finally {
      await this.terminateRecorder(proc).catch((err: unknown) => { cleanupError = err; });
    }
    const exitCode = proc.exitCode ?? 0;

    if (cleanupError) {
      return {
        status: "error",
        message: `recorder cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      };
    }

    if (context.cancelled) return { status: "cancelled" };
    if (result.clapped) { this.onDoubleClap?.(); return { status: "cancelled" }; }

    let outcome = result.outcome;
    // Stream ended on its own without the gate deciding — distinguish a failed
    // recorder (bad exit, no speech) from a real, if abrupt, utterance.
    if (outcome === null) {
      if (!result.started) {
        if (exitCode !== 0) {
          const tail = (await stderrText).trim().split("\n").filter(Boolean).pop();
          return { status: "error", message: tail || `recorder exited with code ${exitCode}` };
        }
        return { status: "silent" };
      }
      outcome = "ok"; // sox stopped but we had speech — salvage it
    }
    return this.writeCaptured(outPath, outcome, result.captured);
  }

  /**
   * Capture from the AEC hub's echo-cancelled mic stream. The hub pushes frames
   * via a sink; we bridge that into a pull stream so the shared gate loop reads it
   * exactly like sox's stdout. We never own the hub process, so we only release
   * the sink — we don't kill anything.
   */
  private async captureViaHub(
    context: VadCaptureContext,
    outPath: string,
    onsetTimeoutMs?: number,
  ): Promise<VadCaptureResult> {
    const hub = this.micHub!;
    const onset = onsetTimeoutMs ?? this.onsetTimeoutMs;
    let sourceEnded = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        context.hubController = c;
      },
    });
    hub.setMicSink(
      (chunk) => { try { controller.enqueue(chunk); } catch { /* stream closed */ } },
      () => {
        sourceEnded = true;
        try { controller.close(); } catch { /* already closed */ }
      },
    );

    const reader = stream.getReader();
    let result: GateResult;
    try {
      result = await this.runGate(reader, onset, context);
    } finally {
      // Only release the sink if we weren't force-stopped. On stop() (voice mode
      // turning off) another consumer — the idle clap listener — re-acquires the
      // hub sink synchronously; clearing it here would stomp that and silently kill
      // clap-to-activate. stop() already nulled our sink, so this is safe to skip.
      if (!context.cancelled) hub.setMicSink(null);
      try { controller.close(); } catch { /* already closed */ }
      if (context.hubController === controller) context.hubController = null;
    }

    if (context.cancelled) return { status: "cancelled" };
    if (result.clapped) { this.onDoubleClap?.(); return { status: "cancelled" }; }
    if (sourceEnded) return { status: "error", message: "AEC microphone stream ended" };
    // The hub stream doesn't fail like a recorder process — a null outcome just
    // means it ended, so keep whatever speech we have (or call it silence).
    const outcome = result.outcome ?? (result.started ? "ok" : "silent");
    return this.writeCaptured(outPath, outcome, result.captured);
  }

  /**
   * Run the VAD gate (and clap detector) over a frame stream until the turn ends,
   * speech onset times out, or a clap/cancel breaks it. Source-agnostic: the
   * reader is fed by sox or the AEC hub. Always releases the reader lock.
   */
  private async runGate(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onset: number,
    context: VadCaptureContext,
  ): Promise<GateResult> {
    const sr = this.sampleRate;
    const seededFloor = this.ambientNoiseFloor;
    const gate = new VadGate({ ...this.gateOpts, initialNoiseFloor: seededFloor ?? undefined });
    const frameBytes = Math.round((sr * this.frameMs) / 1000) * 2; // 16-bit samples
    // On the one initial unseeded capture, retain the whole calibration + onset
    // qualification window. Once ambient is learned, normal pre-roll is enough.
    const initialWarmupMs = seededFloor === null
      ? (this.gateOpts.calibrationMs ?? 300) + (this.gateOpts.minSpeechMs ?? 120)
      : 0;
    const prerollFrames = Math.max(0, Math.round(Math.max(this.prerollMs, initialWarmupMs) / this.frameMs));

    const preroll: Uint8Array[] = []; // recent frames kept until onset
    const captured: Uint8Array[] = []; // frames retained from onset onward
    let capturing = false;
    let started = false;
    let frameIndex = 0;
    let outcome: "ok" | "silent" | null = null;
    let clapped = false; // a double-clap gesture landed mid-capture
    let carry = new Uint8Array(0);
    let maxRms = 0; // loudest frame seen this capture (diagnostics)
    let maxPeak = 0; // loudest transient seen this capture (clap diagnostics)
    const wallStartedAt = Date.now();
    const onsetDeadlineAt = wallStartedAt + onset;
    const captureDeadlineAt = wallStartedAt + this.maxDurationMs;

    try {
      readloop: while (true) {
        const wallDeadlineAt = started
          ? captureDeadlineAt
          : Math.min(onsetDeadlineAt, captureDeadlineAt);
        const next = await this.readUntil(reader, wallDeadlineAt);
        if (next === null) {
          outcome = started ? "ok" : "silent";
          try { await reader.cancel(new Error("VAD capture wall deadline reached")); } catch {
            // The owning capture terminates the recorder immediately afterward.
          }
          break;
        }
        const { done, value } = next;
        if (done || context.cancelled) break;
        if (!value) continue;

        const buf = carry.length ? concat(carry, value) : value;
        let off = 0;
        while (buf.length - off >= frameBytes) {
          const frame = buf.slice(off, off + frameBytes); // copy: the view is reused next read
          off += frameBytes;
          const tMs = frameIndex * this.frameMs;
          frameIndex++;

          // Double-clap gesture, read from this same stream (no 2nd mic). Peak
          // (not RMS) is the clap signal; a transient survives one frame. Only
          // breaks the capture when armed (see setClapEnabled) — a clap during the
          // plain listen must not cancel it.
          if (this.clapDetector || this.debug) {
            const peak = framePeak(frame);
            if (peak > maxPeak) maxPeak = peak;
            if (this.clapDetector && this.clapEnabled && this.clapDetector.feed(peak, tMs) === "double") {
              clapped = true;
              break readloop;
            }
          }

          const rms = frameRms(frame);
          if (rms > maxRms) maxRms = rms;
          const event = gate.feed(rms, tMs);

          if (capturing) {
            captured.push(frame);
          } else {
            preroll.push(frame);
            while (preroll.length > prerollFrames) preroll.shift();
          }

          if (event === "start") {
            started = true;
            capturing = true;
            captured.unshift(...preroll); // pre-roll precedes the onset frame
            preroll.length = 0;
          } else if (event === "end") {
            outcome = "ok";
            break readloop;
          }

          if (!started && tMs >= onset) {
            outcome = "silent";
            break readloop;
          }
          if (tMs >= this.maxDurationMs) {
            outcome = started ? "ok" : "silent";
            break readloop;
          }
        }
        carry = buf.slice(off);
      }
    } catch (err: unknown) {
      if (!context.cancelled) {
        log("info", `VAD capture stream ended: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* stream already torn down */ }
    }

    if (this.debug) {
      const f = (n: number) => n.toFixed(4);
      log(
        "info",
        `vad-dbg: floor=${f(gate.floor)} openThr=${f(gate.openThresholdRms)} maxRms=${f(maxRms)} maxPeak=${f(maxPeak)} ` +
          `opened=${started} outcome=${outcome ?? "stream-end"} src=${this.micHub ? "hub" : "sox"}`,
      );
    }

    if (!context.cancelled && Number.isFinite(gate.floor) && gate.floor > 0) this.ambientNoiseFloor = gate.floor;

    return { outcome, started, clapped, captured };
  }

  /** One source read bounded by the capture's current absolute wall deadline. */
  private async readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    deadlineAt: number,
  ): Promise<StreamReadResult | null> {
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    if (remainingMs === 0) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remainingMs); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Idempotently terminate and reap the exact recorder owned by this capture. */
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
        // A failed reap keeps both the exact process and its observed failure so
        // a later stop can retry and capture cannot open a competing mic owner.
        if (attempt.error === null && this.procTermination === attempt) this.procTermination = null;
      });
    this.procTermination = attempt;
    return attempt.task;
  }

  /** Write the captured frames to a WAV, or report silence if there's too little. */
  private async writeCaptured(outPath: string, outcome: "ok" | "silent", captured: Uint8Array[]): Promise<VadCaptureResult> {
    if (outcome === "silent") return { status: "silent" };
    const samples = framesToInt16(captured);
    if (samples.length < this.sampleRate * 0.1) return { status: "silent" }; // < 100ms isn't a real turn
    await Bun.write(outPath, encodeWav(samples, this.sampleRate));
    return { status: "ok", path: outPath };
  }
}

/** Concatenate two byte buffers (frame remainder + next chunk). */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Flatten captured PCM byte frames into little-endian-decoded 16-bit samples. */
function framesToInt16(frames: Uint8Array[]): Int16Array {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const bytes = new Uint8Array(total);
  let p = 0;
  for (const f of frames) {
    bytes.set(f, p);
    p += f.length;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Int16Array(Math.floor(total / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
  return samples;
}

async function collectStderrTail(stream: ReadableStream<Uint8Array>, maxBytes = 16 * 1024): Promise<string> {
  let retained = new Uint8Array(0);
  try {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      if (chunk.byteLength >= maxBytes) {
        retained = chunk.slice(chunk.byteLength - maxBytes);
        continue;
      }
      const keep = Math.min(retained.byteLength, maxBytes - chunk.byteLength);
      const next = new Uint8Array(keep + chunk.byteLength);
      next.set(retained.subarray(retained.byteLength - keep));
      next.set(chunk, keep);
      retained = next;
    }
  } catch {
    // Recorder cleanup owns stream failures; diagnostics are best effort.
  }
  return new TextDecoder().decode(retained);
}
