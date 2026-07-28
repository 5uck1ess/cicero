import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import type { Listener } from "../types";
import type { STTProvider } from "../backends/stt/provider";
import type { AudioRecorder } from "../platform/audio";
import { log } from "../logger";
import { ciceroPath } from "../platform/paths";

/**
 * Native dictation: press to start, press again to stop, and the transcript
 * lands wherever it was asked to go.
 *
 * This replaces the previous listener, which drove a paid third-party macOS
 * dictation app by simulating its hotkey and then polling the clipboard for up
 * to thirty seconds to see what it produced. Cicero owns STT now, so it can
 * simply record and transcribe — no second dictation product, no clipboard
 * involvement, and it works on the platforms that app never supported.
 */
export type DictationState = "idle" | "recording" | "transcribing";

/** Where a finished transcript goes. */
export type DictationTarget =
  /** Type it into whatever window has focus — the dictation-app replacement. */
  | "focused-app"
  /** Hand it to Cicero as a spoken command — what the old hotkey listener did. */
  | "cicero";

export interface DictationDeps {
  stt: Pick<STTProvider, "transcribe">;
  recorder: AudioRecorder;
  /** Types text into the focused window. Required for the "focused-app" target. */
  typeText?: (text: string) => Promise<void>;
  target?: DictationTarget;
  /** Hard ceiling on one dictation, so a missed stop cannot record forever. */
  maxRecordingMs?: number;
  /** Directory for the in-flight capture. Defaults to the private Cicero dir. */
  audioDir?: string;
  /** Bound on waiting for an in-flight transcription during shutdown. */
  drainTimeoutMs?: number;
  /** Bound on waiting for the recorder process to exit after a kill. */
  recorderExitTimeoutMs?: number;
  /** Injectable for tests. */
  now?: () => number;
}

const DEFAULT_MAX_RECORDING_MS = 5 * 60_000;

/**
 * One dictation capture and its owned resources. A capture is created on start
 * and is the single owner of its recorder process and temp file until it is
 * finished exactly once — so a stop, a timeout, and a shutdown racing each other
 * cannot double-kill or double-unlink.
 */
interface Capture {
  file: string;
  proc: ReturnType<typeof Bun.spawn>;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Resolves when the recorder has exited and the file is on disk. */
  stopped: Promise<void>;
  finish: () => void;
  settled: boolean;
}

export class DictationListener implements Listener {
  private state: DictationState = "idle";
  private capture: Capture | null = null;
  /** In-flight transcribe+deliver, so shutdown can drain it instead of racing it. */
  private pending: Promise<void> | null = null;
  private callback: ((text: string) => void) | undefined;
  private running = false;
  private readonly target: DictationTarget;
  private readonly maxRecordingMs: number;
  private readonly audioDir: string;
  private readonly drainTimeoutMs: number;
  private readonly recorderExitTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: DictationDeps) {
    this.target = deps.target ?? "focused-app";
    this.maxRecordingMs = deps.maxRecordingMs ?? DEFAULT_MAX_RECORDING_MS;
    this.audioDir = deps.audioDir ?? ciceroPath("tmp");
    this.drainTimeoutMs = deps.drainTimeoutMs ?? 10_000;
    this.recorderExitTimeoutMs = deps.recorderExitTimeoutMs ?? 5_000;
    this.now = deps.now ?? Date.now;
    if (this.target === "focused-app" && !deps.typeText) {
      throw new Error('dictation target "focused-app" requires a typeText injector');
    }
  }

  getState(): DictationState { return this.state; }

  async start(): Promise<void> {
    mkdirSync(this.audioDir, { recursive: true });
    this.running = true;
    log("ok", `Dictation ready — press the dictation hotkey to start, press again to stop (target: ${this.target})`);
  }

  async stop(): Promise<void> {
    this.running = false;
    // Abandon a capture that is still RECORDING: kill the recorder, drop the
    // file, and do not transcribe. A daemon that is shutting down must not
    // start new work.
    const capture = this.capture;
    this.capture = null;
    if (capture) {
      await this.releaseCapture(capture);
      await this.discardCaptureFile(capture.file);
    }
    // A capture that already reached transcription is owned work, not new work.
    // Drain it so its typing cannot land after shutdown reports done, but bound
    // the wait so a wedged STT provider cannot hold the daemon open.
    const pending = this.pending;
    if (pending) {
      await Promise.race([
        pending,
        Bun.sleep(this.drainTimeoutMs).then(() => {
          log("warn", "Dictation did not finish transcribing within its shutdown drain — abandoning it");
        }),
      ]).catch(() => { /* finishRecording already logged */ });
    }
    this.state = "idle";
  }

  onCommand(callback: (text: string) => void): void {
    this.callback = callback;
  }

  /**
   * The hotkey. Press once to begin, press again to end and transcribe.
   *
   * Toggle rather than hold-to-talk because the macOS helper emits key-down
   * only — there is no key-up event to end a hold. Toggle is also kinder for
   * long dictation, where holding a chord for a paragraph is uncomfortable.
   */
  async toggle(): Promise<void> {
    if (!this.running) return;
    if (this.state === "transcribing") {
      // Deliberately ignored rather than queued: a second capture started while
      // the first is still decoding would race to type into the same field.
      log("info", "Dictation is still transcribing the previous capture — ignoring");
      return;
    }
    if (this.state === "recording") {
      await this.trackFinish();
      return;
    }
    this.beginRecording();
  }

  /**
   * Run finishRecording() and expose it as the drainable in-flight task.
   *
   * `tracked` must be the promise the field holds, not finishRecording()'s own:
   * comparing the field against the un-chained promise never matches, so the
   * latch would never clear and stop() would keep awaiting a stale task.
   */
  private trackFinish(): Promise<void> {
    const tracked: Promise<void> = this.finishRecording().finally(() => {
      if (this.pending === tracked) this.pending = null;
    });
    this.pending = tracked;
    return tracked;
  }

  private beginRecording(): void {
    const file = join(this.audioDir, `dictation-${this.now()}.wav`);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = this.deps.recorder.record(file, {
        // No silence-based auto-stop: the operator decides when a dictation ends.
        // A ceiling still applies so a forgotten session cannot record forever.
        maxDuration: Math.ceil(this.maxRecordingMs / 1000),
      });
    } catch (error: unknown) {
      log("error", `Dictation could not start recording: ${detail(error)}`);
      return;
    }

    let finish!: () => void;
    const stopped = new Promise<void>((resolve) => { finish = resolve; });
    const capture: Capture = { file, proc, timer: undefined, stopped, finish, settled: false };
    capture.timer = setTimeout(() => {
      log("warn", `Dictation hit its ${Math.round(this.maxRecordingMs / 1000)}s ceiling — stopping`);
      void this.trackFinish().catch((error: unknown) => {
        log("error", `Dictation ceiling stop failed: ${detail(error)}`);
      });
    }, this.maxRecordingMs);

    this.capture = capture;
    this.state = "recording";
    log("info", "Dictation recording — press the hotkey again to stop");
  }

  private async finishRecording(): Promise<void> {
    const capture = this.capture;
    if (!capture) return;
    this.capture = null;
    this.state = "transcribing";

    try {
      await this.releaseCapture(capture);
      const transcript = (await this.deps.stt.transcribe(capture.file))?.trim() ?? "";
      if (!transcript) {
        log("warn", "Dictation produced no transcript");
        return;
      }
      await this.deliver(transcript);
    } catch (error: unknown) {
      // A dictation failure must never take the daemon down with it.
      log("error", `Dictation failed: ${detail(error)}`);
    } finally {
      await this.discardCaptureFile(capture.file);
      this.state = "idle";
    }
  }

  /**
   * Stop the recorder and wait for the file to be complete. Safe to call twice.
   *
   * The wait for exit is BOUNDED: a recorder that ignores its kill must not
   * wedge the toggle or hold up daemon shutdown. On timeout the capture is
   * abandoned — the file may be short or absent, and transcription of it will
   * simply produce nothing.
   */
  private async releaseCapture(capture: Capture): Promise<void> {
    if (capture.settled) return capture.stopped;
    capture.settled = true;
    if (capture.timer !== undefined) {
      clearTimeout(capture.timer);
      capture.timer = undefined;
    }
    try {
      capture.proc.kill();
    } catch {
      // Already gone (hit its own ceiling, or the recorder died) — still await exit.
    }
    const exited = capture.proc.exited.catch(() => { /* exit status is not interesting here */ });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            log("warn", `Dictation recorder did not exit within ${this.recorderExitTimeoutMs}ms — abandoning the capture`);
            resolve();
          }, this.recorderExitTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    capture.finish();
  }

  /** Remove a capture file, reporting the path when it cannot be cleaned up. */
  private async discardCaptureFile(file: string): Promise<void> {
    try {
      await unlink(file);
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "ENOENT") return; // never written, or already gone
      log("warn", `Dictation could not remove its capture file ${file}: ${detail(error)}`);
    }
  }

  private async deliver(transcript: string): Promise<void> {
    if (this.target === "cicero") {
      if (!this.callback) {
        log("warn", "Dictation has no command handler attached — dropping the transcript");
        return;
      }
      this.callback(transcript);
      return;
    }
    await this.deps.typeText!(transcript);
  }
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
