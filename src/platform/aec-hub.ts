import { log } from "../logger";
import { join, dirname } from "path";
import { existsSync } from "fs";
import {
  MAX_DECODED_WAV_DURATION_MS,
  MAX_WAV_SAMPLE_RATE,
  MIN_WAV_SAMPLE_RATE,
  decodeWav,
} from "./wav";
import { terminateDirectChild } from "../process/direct-child";

const DEFAULT_PLAYBACK_WRITE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_PENDING_PLAYBACK_BYTES = 512 * 1024;
const STDERR_TAIL_LIMIT_BYTES = 16 * 1024;

export interface AecAudioHubOptions {
  playbackWriteTimeoutMs?: number;
  maxPendingPlaybackBytes?: number;
}

interface AecCleanupAttempt {
  proc: ReturnType<typeof Bun.spawn>;
  task: Promise<void>;
  error: Error | null;
}

/**
 * The hub is down, but its exact helper has not yet been confirmed reaped. Raw
 * microphone capture or platform playback must not start while this is thrown:
 * either could contend with a native process that still owns the audio device.
 */
export class AecReleaseUnconfirmedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AecReleaseUnconfirmedError";
  }
}

/** Decode a TTS WAV (any rate/channels) to the 16 kHz mono s16le the hub plays. */
export function pcm16kFromWav(buffer: ArrayBuffer): Uint8Array {
  const { samples, sampleRate } = decodeWav(buffer);
  return floatToS16LE(resampleTo16k(samples, sampleRate));
}

/** Linear-interpolation resample of mono float PCM to 16 kHz. */
export function resampleTo16k(samples: Float32Array, srcRate: number): Float32Array {
  if (!Number.isInteger(srcRate) || srcRate < MIN_WAV_SAMPLE_RATE || srcRate > MAX_WAV_SAMPLE_RATE) {
    throw new Error(`unsupported source sample rate: ${srcRate}`);
  }
  const durationMs = (samples.length / srcRate) * 1_000;
  if (!Number.isFinite(durationMs) || durationMs > MAX_DECODED_WAV_DURATION_MS) {
    throw new Error(`source audio exceeds the ${MAX_DECODED_WAV_DURATION_MS}ms resample limit`);
  }
  if (srcRate === 16000 || samples.length === 0) return samples;
  const ratio = 16000 / srcRate;
  const outLen = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = pos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/** Mono float [-1,1] → signed 16-bit little-endian bytes. */
export function floatToS16LE(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(i * 2, Math.round(v * 32767), true);
  }
  return out;
}

/** Path to the built echo-cancelling helper (see `bun run build:aec`). */
export function aecBinaryPath(): string {
  // src/platform → src → repo root → helpers/cicero-aec-mic
  return join(dirname(dirname(import.meta.dir)), "helpers", "cicero-aec-mic");
}

/** AEC is macOS-only (Voice Processing) and needs the helper to be built. */
export function aecAvailable(binary: string = aecBinaryPath()): boolean {
  return process.platform === "darwin" && existsSync(binary);
}

/**
 * Owns the persistent macOS echo-cancelling audio helper (`cicero-aec-mic --play`).
 *
 * It is one DUPLEX device: PCM written via {@link play} is rendered to the speaker
 * AND used as the echo reference, so the mic frames it emits have Cicero's own
 * voice cancelled (~30 dB, measured). That's the thing sox can't do — it's why the
 * mic stops tripping on Cicero's TTS over open speakers, and can still hear you.
 *
 * The mic is a single stream with one consumer at a time (the listen loop is
 * sequential): {@link setMicSink} routes frames to whoever is capturing, and when
 * nobody is, frames are still drained and dropped so the helper never blocks on a
 * full stdout pipe (which would stall its audio thread).
 *
 * All audio is 16 kHz mono signed-16-bit little-endian, matching the rest of the
 * capture pipeline (VAD/clap/STT), so it's a drop-in for the `rec` byte stream.
 */
export class AecAudioHub {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private micSink: ((chunk: Uint8Array) => void) | null = null;
  private micSinkEnded: (() => void) | null = null;
  private state: "stopped" | "starting" | "running" = "stopped";
  private desiredRunning = false;
  private lifecycleEpoch = 0;
  private startPromise: Promise<void> | null = null;
  private startPromiseEpoch = 0;
  private startupWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private micReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readonly binary: string;
  private readonly startupTimeoutMs: number;
  private readonly spawnHelper: typeof Bun.spawn;
  private readonly playbackWriteTimeoutMs: number;
  private readonly maxPendingPlaybackBytes: number;
  private playbackTail: Promise<void> = Promise.resolve();
  private pendingPlaybackBytes = 0;
  private processTasks: {
    proc: ReturnType<typeof Bun.spawn>;
    mic: Promise<void>;
    stderr: Promise<void>;
    exit: Promise<void>;
  } | null = null;
  private cleanupTasks = new WeakMap<object, AecCleanupAttempt>();
  private latestCleanup: AecCleanupAttempt | null = null;

  constructor(
    binary: string = aecBinaryPath(),
    startupTimeoutMs = 2000,
    spawnHelper: typeof Bun.spawn = Bun.spawn,
    options: AecAudioHubOptions = {},
  ) {
    this.binary = binary;
    this.startupTimeoutMs = startupTimeoutMs;
    this.spawnHelper = spawnHelper;
    this.playbackWriteTimeoutMs = positiveInteger(
      options.playbackWriteTimeoutMs ?? DEFAULT_PLAYBACK_WRITE_TIMEOUT_MS,
      "playbackWriteTimeoutMs",
    );
    this.maxPendingPlaybackBytes = positiveInteger(
      options.maxPendingPlaybackBytes ?? DEFAULT_MAX_PENDING_PLAYBACK_BYTES,
      "maxPendingPlaybackBytes",
    );
  }

  isRunning(): boolean {
    return this.state === "running";
  }

  /**
   * Confirm that no stopped/failed helper still owns the audio device. A failed
   * reap remains a barrier and is retried here; callers may fall back to a raw
   * recorder/player only after this resolves.
   */
  async waitForRelease(): Promise<void> {
    if (this.proc || this.state !== "stopped") {
      throw new AecReleaseUnconfirmedError("AEC helper is still active");
    }
    try {
      await this.ensureLatestCleanup();
    } catch (error: unknown) {
      throw new AecReleaseUnconfirmedError(
        `AEC helper release could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    // A concurrent activation may have claimed the helper while the old cleanup
    // was settling. That is not a released platform device, so do not authorize
    // a raw fallback from this observation.
    if (this.proc || this.state !== "stopped" || this.latestCleanup) {
      throw new AecReleaseUnconfirmedError("AEC helper became active before release was confirmed");
    }
  }

  async start(): Promise<void> {
    const epoch = this.setDesiredRunning(true);
    while (this.shouldRun(epoch)) {
      if (this.isRunning()) return;

      const pending = this.startPromise;
      if (pending) {
        const pendingEpoch = this.startPromiseEpoch;
        try {
          await pending;
        } catch (error: unknown) {
          if (pendingEpoch === epoch) throw error;
        }
        continue;
      }

      const operation = this.ensureStarted(epoch);
      this.startPromise = operation;
      this.startPromiseEpoch = epoch;
      try {
        await operation;
      } finally {
        if (this.startPromise === operation) {
          this.startPromise = null;
          this.startPromiseEpoch = 0;
        }
      }
      return;
    }
  }

  private async ensureStarted(epoch: number): Promise<void> {
    await this.ensureLatestCleanup();
    if (!this.shouldRun(epoch) || this.isRunning()) return;
    await this.startHelper(epoch);
  }

  private async startHelper(epoch: number): Promise<void> {
    if (!this.shouldRun(epoch)) return;
    if (!existsSync(this.binary)) {
      throw new Error(`AEC helper not found at ${this.binary} — build it with: bun run build:aec`);
    }
    const proc = this.spawnHelper([this.binary, "--play"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.proc = proc;
    this.state = "starting";
    const ready = new Promise<void>((resolve, reject) => { this.startupWaiter = { resolve, reject }; });
    const micTask = this.drainMic(proc);
    const stderrTask = this.drainStderr(proc);
    const exitTask = this.watchExit(proc);
    this.processTasks = { proc, mic: micTask, stderr: stderrTask, exit: exitTask };
    void micTask.catch((err: unknown) => {
      void this.failProcess(proc, err instanceof Error ? err : new Error(String(err))).catch((cleanup: unknown) => {
        log("info", `AEC mic cleanup failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`);
      });
    });
    void stderrTask.catch((err: unknown) => {
      if (this.proc === proc) log("info", `AEC stderr drain ended: ${err instanceof Error ? err.message : String(err)}`);
    });
    void exitTask.catch((err: unknown) => {
      void this.failProcess(proc, err instanceof Error ? err : new Error(String(err))).catch((cleanup: unknown) => {
        log("info", `AEC exit cleanup failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`);
      });
    });
    // Wait until the mic actually produces audio (the VPIO engine takes a beat to
    // init) so the first capture after activation isn't reading a dead device.
    // A timeout is a failure, not a healthy-but-silent process: tear it down so a
    // future activation can retry instead of trusting stale `running` state.
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          startupTimer = setTimeout(
            () => reject(new Error(`AEC helper produced no microphone audio within ${this.startupTimeoutMs}ms`)),
            this.startupTimeoutMs,
          );
        }),
      ]);
    } catch (err: unknown) {
      await this.failProcess(proc, err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      if (startupTimer !== undefined) clearTimeout(startupTimer);
    }
    if (!this.shouldRun(epoch)) {
      await this.failProcess(proc, new Error("AEC helper startup was superseded"));
      return;
    }
    if (this.proc !== proc || !this.isRunning()) {
      throw new Error("AEC helper stopped during startup");
    }
    log("ok", "🎙️  AEC audio hub up (echo-cancelled mic + TTS playback)");
  }

  /**
   * Route AEC'd mic frames to a consumer, or null to drain-and-drop them.
   * `onEnd` closes a consumer bridge if the helper dies unexpectedly.
   */
  setMicSink(sink: ((chunk: Uint8Array) => void) | null, onEnd?: () => void): void {
    if (sink && this.state !== "running") {
      this.micSink = null;
      this.micSinkEnded = null;
      try { onEnd?.(); } catch { /* consumer cleanup is best effort */ }
      return;
    }
    this.micSink = sink;
    this.micSinkEnded = sink ? (onEnd ?? null) : null;
  }

  /**
   * Render PCM (16 kHz mono s16le) and wait for pipe backpressure. Concurrent
   * callers serialize, with a hard pending-byte ceiling so a stalled helper
   * cannot turn TTS into an unbounded in-memory queue.
   */
  async play(pcm: Uint8Array): Promise<void> {
    if (pcm.byteLength === 0) return;
    if (this.state !== "running") throw new Error("AEC helper is not running");
    const proc = this.proc;
    if (!proc) throw new Error("AEC helper is not running");
    if (pcm.byteLength > this.maxPendingPlaybackBytes
      || this.pendingPlaybackBytes > this.maxPendingPlaybackBytes - pcm.byteLength) {
      throw new Error(`AEC playback backlog exceeds ${this.maxPendingPlaybackBytes} bytes`);
    }

    const owned = pcm.slice();
    this.pendingPlaybackBytes += owned.byteLength;
    const previous = this.playbackTail.catch(() => {
      // A prior failed write already stopped its helper; the exact caller still
      // received that rejection, while the serialization chain can continue.
    });
    const operation = previous
      .then(async () => {
        if (this.proc !== proc || this.state !== "running") {
          throw new Error("AEC helper stopped before queued playback");
        }
        const stdin = proc.stdin;
        if (!stdin || typeof stdin === "number") throw new Error("AEC helper has no playback pipe");
        await withDeadline(
          (async () => {
            await stdin.write(owned);
            await stdin.flush();
          })(),
          this.playbackWriteTimeoutMs,
          `AEC playback write exceeded ${this.playbackWriteTimeoutMs}ms`,
        );
      })
      .catch(async (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (this.proc === proc) await this.failProcess(proc, error);
        throw error;
      })
      .finally(() => {
        this.pendingPlaybackBytes -= owned.byteLength;
      });
    this.playbackTail = operation;
    return operation;
  }

  async stop(): Promise<void> {
    this.setDesiredRunning(false);
    const proc = this.proc;
    const tasks = this.processTasks;
    const playbackTail = this.playbackTail;
    if (!proc) {
      this.state = "stopped";
      await this.ensureLatestCleanup();
    } else {
      await this.failProcess(proc, new Error("AEC helper stopped"));
    }
    await playbackTail.catch(() => { /* a failed/stopped write is already reported to its caller */ });
    if (tasks) {
      await Promise.allSettled([tasks.mic, tasks.stderr, tasks.exit]);
      if (this.processTasks === tasks) this.processTasks = null;
    }
  }

  private async drainMic(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const stdout = proc.stdout;
    if (!stdout || typeof stdout === "number") {
      await this.failProcess(proc, new Error("AEC helper produced no microphone stream"));
      return;
    }
    const reader = stdout.getReader();
    this.micReader = reader;
    try {
      while (this.proc === proc) {
        const { done, value } = await reader.read();
        if (done) {
          await this.failProcess(proc, new Error("AEC microphone stream ended"));
          break;
        }
        if (value) {
          if (this.state === "starting") {
            this.state = "running";
            const waiter = this.startupWaiter;
            this.startupWaiter = null;
            waiter?.resolve();
          }
          if (this.micSink) this.micSink(value);
        }
      }
    } catch (err: unknown) {
      if (this.proc === proc) {
        const failure = err instanceof Error ? err : new Error(String(err));
        log("info", `AEC mic stream ended: ${failure.message}`);
        await this.failProcess(proc, failure);
      }
    } finally {
      if (this.micReader === reader) this.micReader = null;
      try { reader.releaseLock(); } catch { /* already torn down */ }
    }
  }

  private async drainStderr(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const stderr = proc.stderr;
    if (!stderr || typeof stderr === "number") return;
    let tail = new Uint8Array(0);
    try {
      for await (const chunk of stderr as ReadableStream<Uint8Array>) {
        if (chunk.byteLength >= STDERR_TAIL_LIMIT_BYTES) {
          tail = chunk.slice(chunk.byteLength - STDERR_TAIL_LIMIT_BYTES);
          continue;
        }
        const keepFromTail = Math.min(tail.byteLength, STDERR_TAIL_LIMIT_BYTES - chunk.byteLength);
        const next = new Uint8Array(keepFromTail + chunk.byteLength);
        next.set(tail.subarray(tail.byteLength - keepFromTail));
        next.set(chunk, keepFromTail);
        tail = next;
      }
    } catch { /* process ended */ }
    const text = new TextDecoder().decode(tail).trim();
    if (text) log("info", `aec: ${text}`);
  }

  private async watchExit(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    try {
      const code = await proc.exited;
      if (this.proc === proc) await this.failProcess(proc, new Error(`AEC helper exited with code ${code}`));
    } catch (err: unknown) {
      if (this.proc === proc) await this.failProcess(proc, err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Clear state synchronously, then terminate/reap the exact failed helper. */
  private failProcess(proc: ReturnType<typeof Bun.spawn>, error: Error): Promise<void> {
    if (this.proc === proc) {
      this.proc = null;
      this.state = "stopped";
      const waiter = this.startupWaiter;
      this.startupWaiter = null;
      waiter?.reject(error);
      const reader = this.micReader;
      this.micReader = null;
      if (reader) {
        void reader.cancel(error).catch(() => { /* process termination is authoritative */ });
      }
      const ended = this.micSinkEnded;
      this.micSink = null;
      this.micSinkEnded = null;
      try { ended?.(); } catch { /* consumer cleanup is best effort */ }
    }

    return this.cleanupProcess(proc, false);
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

  /** Retry a previously failed reap before any new helper may claim the device. */
  private async ensureLatestCleanup(): Promise<void> {
    const prior = this.latestCleanup;
    if (!prior) return;
    if (prior.error === null) await prior.task;
    else await this.cleanupProcess(prior.proc, true);

    const tasks = this.processTasks?.proc === prior.proc ? this.processTasks : null;
    if (tasks) {
      await Promise.allSettled([tasks.mic, tasks.stderr, tasks.exit]);
      if (this.processTasks === tasks) this.processTasks = null;
    }
  }

  /** Track one exact helper cleanup; a failed attempt remains a restart barrier. */
  private cleanupProcess(proc: ReturnType<typeof Bun.spawn>, retryFailed: boolean): Promise<void> {
    const prior = this.cleanupTasks.get(proc);
    if (prior && (!retryFailed || prior.error === null)) return prior.task;
    if (prior && this.cleanupTasks.get(proc) === prior) this.cleanupTasks.delete(proc);

    const attempt: AecCleanupAttempt = { proc, task: Promise.resolve(), error: null };
    attempt.task = terminateDirectChild(proc).then(
      () => {
        if (this.cleanupTasks.get(proc) === attempt) this.cleanupTasks.delete(proc);
        if (this.latestCleanup === attempt) this.latestCleanup = null;
      },
      (err: unknown) => {
        attempt.error = err instanceof Error ? err : new Error(String(err));
        throw attempt.error;
      },
    );
    this.cleanupTasks.set(proc, attempt);
    this.latestCleanup = attempt;
    return attempt.task;
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
