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
  /**
   * Release whatever the injector still owns. A helper that ignored its kill is
   * retained inside the injector, and without this the listener — its only
   * owner — could not reach it at shutdown. Rejects when release is unconfirmed.
   */
  stopTyping?: () => Promise<void>;
  target?: DictationTarget;
  /** Hard ceiling on one dictation, so a missed stop cannot record forever. */
  maxRecordingMs?: number;
  /** Directory for the in-flight capture. Defaults to the private Cicero dir. */
  audioDir?: string;
  /** Bound on waiting for an in-flight transcription during shutdown. */
  drainTimeoutMs?: number;
  /** Bound on waiting for the recorder process to exit after a kill. */
  recorderExitTimeoutMs?: number;
  /**
   * Take exclusive ownership of the local microphone for one capture.
   *
   * Dictation is not the only microphone owner: clap detection holds a raw
   * recorder whenever voice mode is off, and conversational/AEC capture holds it
   * when voice mode is on. On an exclusive capture device a second recorder gets
   * a broken stream or none at all, so the daemon hands ownership over here
   * before anything is spawned. Rejecting refuses the capture — competing for
   * the device is never the better outcome.
   */
  acquireMicrophone?: () => Promise<void>;
  /** Hand the microphone back. Only called once the recorder is confirmed gone. */
  releaseMicrophone?: () => Promise<void>;
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
  /** True only once the recorder process is observed to have exited. */
  confirmed: boolean;
}

/**
 * Ask a recorder to exit, then insist. A capture device is held for as long as
 * its process lives, so a recorder that ignores the polite signal — the exact
 * case that strands the microphone and outlives the daemon — is escalated
 * rather than merely reported. Only an unkillable process (uninterruptible
 * sleep) survives this, and that is genuinely beyond the daemon.
 *
 * Returns true only when the process is observed to have exited.
 */
async function terminate(proc: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<boolean> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      proc.kill(signal);
    } catch {
      // Already gone (hit its own ceiling, or the recorder died) — still await exit.
    }
    if (await confirmExit(proc, timeoutMs)) return true;
  }
  return false;
}

/** Wait, bounded, for a process to actually exit. True only when confirmed gone. */
async function confirmExit(proc: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      proc.exited.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class DictationListener implements Listener {
  private state: DictationState = "idle";
  private capture: Capture | null = null;
  /** In-flight transcribe+deliver, so shutdown can drain it instead of racing it. */
  private pending: Promise<void> | null = null;
  private callback: ((text: string) => void) | undefined;
  private running = false;
  /**
   * A capture whose recorder ignored its kill. It may still be writing the file
   * and it still owns the microphone, so no new capture is admitted and the file
   * is not deleted until its exit is confirmed. Retried on the next toggle or
   * stop rather than latched, so recovery needs no daemon restart.
   */
  private unreaped: Capture | null = null;
  private micHeld = false;
  /** A start claimed but not yet reflected in `state`, so two presses cannot both spawn. */
  private starting = false;
  /** Distinguishes captures started inside the same millisecond. */
  private sequence = 0;
  /**
   * The in-flight transcription's abandonment flag. A transcription the shutdown
   * drain gave up on still settles eventually, and used to deliver whenever that
   * happened — typing into whatever the operator was doing minutes later, or
   * dispatching a command to a stopped daemon. Work the drain DOES complete
   * still delivers; that is what the drain is for.
   */
  private pendingToken: { abandoned: boolean } | null = null;
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
      const released = await this.releaseCapture(capture);
      // Deleting a file a live recorder is still writing does not stop it, and
      // the recorder keeps the microphone. releaseCapture has retained it; a
      // later stop() retries the reap.
      if (released) await this.discardCaptureFile(capture.file);
    }
    // A recorder retained by an earlier failed reap gets another chance here, so
    // an unconfirmed release is recoverable without restarting the daemon.
    await this.reapStuckRecorder();
    // Whatever the typing helper retained is owned by this listener too, and
    // nothing else can reach it once the daemon drops its reference. Released
    // BEFORE the drain so a helper already typing cannot hold the drain open for
    // the length of a transcript; its outcome is not the one reported, because
    // the release below supersedes it.
    await this.releaseTypingHelper();
    // A capture that already reached transcription is owned work, not new work.
    // Drain it so its typing cannot land after shutdown reports done, but bound
    // the wait so a wedged STT provider cannot hold the daemon open.
    const pending = this.pending;
    const token = this.pendingToken;
    if (pending) {
      await Promise.race([
        pending,
        Bun.sleep(this.drainTimeoutMs).then(() => {
          // Abandoning it means exactly that: whenever this transcription does
          // settle, it must not deliver. Without the flag, "abandoned" only
          // meant "no longer waited for", and the text still arrived later.
          if (token) token.abandoned = true;
          log("warn", "Dictation did not finish transcribing within its shutdown drain — abandoning it");
        }),
      ]).catch(() => { /* finishRecording already logged */ });
    }
    // And again after the drain. A transcription that settles INSIDE the drain
    // window is delivered — that is what the drain is for — so it reaches
    // typeText and can spawn a helper after the release above already found
    // nothing. The injector refuses to spawn once released, but a helper it
    // spawned just before that must still be reaped here rather than outliving a
    // shutdown that reported success. This is the outcome stop() reports: it
    // supersedes the earlier attempt, so a helper that refused the first kill and
    // died on the second counts as released.
    const typingReleased = await this.releaseTypingHelper();
    // The recorder is re-checked here for the same reason. finishRecording()
    // clears `capture` BEFORE it awaits the recorder's release, so a stop() that
    // lands in that window sees no capture and no retained recorder and computes
    // "released" — while the release it is racing goes on to time out DURING the
    // drain and retain one. The pre-drain result is a snapshot of a state the
    // drain itself can change, so only this one is reported.
    const reaped = await this.reapStuckRecorder();
    // Ordinary transcription hands the microphone back; a shutdown that killed
    // the recorder instead did not, so the daemon stayed convinced dictation
    // still owned the device and never re-armed clap or conversational capture.
    // Only once nothing is outstanding — an unconfirmed recorder still holds it,
    // and reapStuckRecorder hands it back itself when it finally exits.
    if (reaped) await this.handBackMicrophone();
    this.state = "idle";
    // Report an unconfirmed release rather than swallowing it. stop() used to
    // resolve regardless, and the daemon then cleared its only reference — so a
    // recorder still holding the microphone, or a helper still typing, had no
    // owner left at all. Throwing keeps the listener alive for a retry.
    if (!reaped || !typingReleased) {
      throw new Error(
        `dictation teardown is unconfirmed: ${[
          reaped ? null : "the recorder has not exited",
          typingReleased ? null : "the typing helper has not exited",
        ].filter(Boolean).join(" and ")}`,
      );
    }
  }

  /** Reap anything the typing helper retained. True when nothing is outstanding. */
  private async releaseTypingHelper(): Promise<boolean> {
    if (!this.deps.stopTyping) return true;
    try {
      await this.deps.stopTyping();
      return true;
    } catch (error: unknown) {
      log("warn", `Dictation typing helper cleanup is unconfirmed: ${detail(error)}`);
      return false;
    }
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
      // Deliberately not awaited: the transcription is owned, drainable work,
      // and awaiting it here kept the /api/dictate request charged for the whole
      // decode — which shutdown then had to wait out under the web drain
      // deadline before it could ever reach dictation.stop().
      void this.trackFinish().catch((error: unknown) => {
        log("error", `Dictation stop failed: ${detail(error)}`);
      });
      return;
    }
    // Claim the start SYNCHRONOUSLY. /api/dictate admits concurrent jobs, and
    // two presses both passed the idle check above and then yielded at the reap
    // below — so both spawned a recorder, and the second overwrote this.capture
    // and stranded the first on the microphone.
    if (this.starting) {
      log("info", "Dictation is already starting a capture — ignoring");
      return;
    }
    this.starting = true;
    try {
      if (!await this.reapStuckRecorder()) {
        log("warn", "Dictation cannot start: the previous recorder has not exited and still holds the microphone");
        return;
      }
      await this.beginRecording();
    } finally {
      this.starting = false;
    }
  }

  /** Await the in-flight transcription, if any. The toggle no longer blocks on it. */
  settled(): Promise<void> {
    return (this.pending ?? Promise.resolve()).catch(() => { /* already logged */ });
  }

  /**
   * Re-check a retained recorder. Returns true when nothing is outstanding —
   * either there never was, or it has finally exited and its file is cleaned up.
   */
  private async reapStuckRecorder(): Promise<boolean> {
    const stuck = this.unreaped;
    if (!stuck) return true;
    // Insist again rather than only re-observing: the first release already
    // asked politely and this process is still holding the microphone.
    if (!await terminate(stuck.proc, this.recorderExitTimeoutMs)) return false;
    this.unreaped = null;
    stuck.confirmed = true;
    await this.discardCaptureFile(stuck.file);
    await this.handBackMicrophone();
    return true;
  }

  /**
   * Run finishRecording() and expose it as the drainable in-flight task.
   *
   * `tracked` must be the promise the field holds, not finishRecording()'s own:
   * comparing the field against the un-chained promise never matches, so the
   * latch would never clear and stop() would keep awaiting a stale task.
   */
  private trackFinish(): Promise<void> {
    const token = { abandoned: false };
    this.pendingToken = token;
    const tracked: Promise<void> = this.finishRecording(token).finally(() => {
      if (this.pending === tracked) {
        this.pending = null;
        this.pendingToken = null;
      }
    });
    this.pending = tracked;
    return tracked;
  }

  private async beginRecording(): Promise<void> {
    // Take the microphone off whoever holds it before spawning anything.
    if (!await this.takeMicrophone()) return;
    // A shutdown can land while the handoff was in flight; that handoff is the
    // only await between the hotkey and the spawn.
    if (!this.running) {
      await this.handBackMicrophone();
      return;
    }
    // The counter is not decoration: two captures in one millisecond would
    // otherwise share a path and overwrite each other's audio.
    this.sequence += 1;
    const file = join(this.audioDir, `dictation-${this.now()}-${this.sequence}.wav`);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = this.deps.recorder.record(file, {
        // No silence-based auto-stop: the operator decides when a dictation ends.
        // A ceiling still applies so a forgotten session cannot record forever.
        stopOnSilence: false,
        maxDuration: Math.ceil(this.maxRecordingMs / 1000),
      });
    } catch (error: unknown) {
      log("error", `Dictation could not start recording: ${detail(error)}`);
      await this.handBackMicrophone();
      return;
    }

    let finish!: () => void;
    const stopped = new Promise<void>((resolve) => { finish = resolve; });
    const capture: Capture = { file, proc, timer: undefined, stopped, finish, settled: false, confirmed: false };
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

  private async finishRecording(token: { abandoned: boolean }): Promise<void> {
    const capture = this.capture;
    if (!capture) return;
    this.capture = null;
    this.state = "transcribing";

    try {
      if (!await this.releaseCapture(capture)) {
        // The recorder is still running: the file may still be growing and the
        // microphone is not free. Transcribing a partial capture and returning
        // to idle is how a second recorder got admitted on top of a live one.
        log("warn", "Dictation abandoned a capture whose recorder would not exit");
        return;
      }
      await this.handBackMicrophone();
      const transcript = (await this.deps.stt.transcribe(capture.file))?.trim() ?? "";
      if (!transcript) {
        log("warn", "Dictation produced no transcript");
        return;
      }
      await this.deliver(transcript, token);
    } catch (error: unknown) {
      // A dictation failure must never take the daemon down with it.
      log("error", `Dictation failed: ${detail(error)}`);
    } finally {
      // Leave a retained capture's file alone — its recorder may still write it.
      if (this.unreaped !== capture) await this.discardCaptureFile(capture.file);
      this.state = "idle";
    }
  }

  /** Acquire microphone ownership, reporting whether the capture may proceed. */
  private async takeMicrophone(): Promise<boolean> {
    if (!this.deps.acquireMicrophone || this.micHeld) return true;
    try {
      await this.deps.acquireMicrophone();
      this.micHeld = true;
      return true;
    } catch (error: unknown) {
      log("error", `Dictation could not take the microphone: ${detail(error)}`);
      return false;
    }
  }

  /** Hand it back so the daemon can re-arm whatever owned it before. */
  private async handBackMicrophone(): Promise<void> {
    if (!this.micHeld) return;
    this.micHeld = false;
    try {
      await this.deps.releaseMicrophone?.();
    } catch (error: unknown) {
      log("warn", `Dictation could not hand the microphone back: ${detail(error)}`);
    }
  }

  /**
   * Stop the recorder and wait for the file to be complete. Safe to call twice.
   *
   * The wait for exit is BOUNDED: a recorder that ignores its kill must not
   * wedge the toggle or hold up daemon shutdown. It is NOT forgotten on timeout,
   * though — reporting a clean release while the process still held the
   * microphone is what let a second recorder start on top of it. It is retained
   * instead, and the caller is told the release is unconfirmed.
   *
   * Returns true only when the recorder is observed to have exited.
   */
  private async releaseCapture(capture: Capture): Promise<boolean> {
    if (capture.settled) {
      await capture.stopped;
      return capture.confirmed;
    }
    capture.settled = true;
    if (capture.timer !== undefined) {
      clearTimeout(capture.timer);
      capture.timer = undefined;
    }
    capture.confirmed = await terminate(capture.proc, this.recorderExitTimeoutMs);
    if (!capture.confirmed) {
      log("warn", `Dictation recorder did not exit within ${this.recorderExitTimeoutMs}ms — it still holds the microphone`);
      this.unreaped = capture;
    }
    capture.finish();
    return capture.confirmed;
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

  private async deliver(transcript: string, token: { abandoned: boolean }): Promise<void> {
    // A transcription the shutdown drain gave up on still settles eventually.
    // Typing it lands text in whatever the operator is doing minutes later, and
    // the "cicero" callback reaches command dispatch on a stopped daemon.
    if (token.abandoned) {
      log("info", "Dictation discarded a transcript that arrived after its session ended");
      return;
    }
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
