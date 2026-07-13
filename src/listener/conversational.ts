import type { Listener } from "../types";
import type { STTProvider } from "../backends/stt/provider";
import type { AudioPlayer, AudioRecorder } from "../platform/audio";
import { log } from "../logger";
import { join, dirname } from "path";
import { statSync, unlinkSync } from "fs";
import { ciceroPath } from "../platform/paths";
import { isSelfEcho } from "./echo";
import type { TurnDetector, TurnPrediction } from "../backends/turn/provider";
import { decideEndOfTurn } from "../backends/turn/policy";
import { decodeWavFile } from "../platform/wav";
import { VadRecorder, type VadRecorderOptions } from "./vad-recorder";
import type { AecAudioHub } from "../platform/aec-hub";
import { terminateDirectChild } from "../process/direct-child";
import { ensurePrivateDirectorySync } from "../platform/secure-storage";

/** Optional semantic end-of-turn wiring for the conversational listener. */
export interface TurnOptions {
  detector: TurnDetector;
  threshold: number;
  graceAttempts: number;
  graceMaxDuration: number;
}

/**
 * Outcome of one silence-bounded recording attempt. Distinguishing "the user was
 * quiet" from "the recorder couldn't run" is what lets us surface a missing mic
 * permission instead of silently dropping out of the listen loop.
 */
type CaptureResult =
  | { status: "ok"; path: string }
  | { status: "silent" }    // recorder ran but caught no usable speech
  | { status: "cancelled" } // deactivated mid-recording
  | { status: "error"; message: string }; // recorder failed to run (e.g. no mic access)

const STOP_COMMANDS = new Set([
  "stop",
  "wait",
  "cancel",
  "hold on",
  "never mind",
  "nevermind",
  "stop talking",
  "shut up",
  "quiet",
  "be quiet",
]);

const DEACTIVATION_COMMANDS = new Set([
  "stop listening",
  "stop",
  "goodbye",
  "bye",
  "deactivate",
  "cicero stop",
  "go to sleep",
  "that's all",
  "thats all",
  "i'm done",
  "im done",
]);

const AUDIO_RELEASE_TIMEOUT_MS = 1000;
const AUDIO_RELEASE_ATTEMPTS = 2;
const LEGACY_RECORDING_WALL_SLACK_MS = 1000;

/**
 * True when an utterance is a bare "stop"-class command — it should interrupt
 * TTS but NOT be passed downstream as a new command.
 */
export function isStopCommand(text: string | null | undefined): boolean {
  const norm = normalizeVoicePhrase(text);
  return STOP_COMMANDS.has(norm);
}

/** Normalize terminal punctuation without turning command prefixes into matches. */
function normalizeVoicePhrase(text: string | null | undefined): string {
  return (text ?? "").toLowerCase().trim().replace(/[.!?]+$/g, "").trim();
}

/** What audio captured during TTS playback turned out to be. */
export type BargeInClass = "empty" | "echo" | "stop" | "command";

/**
 * Full-duplex policy: classify audio the mic captured *while Cicero was speaking*.
 *
 * On open speakers the mic hears Cicero's own TTS, so we cannot treat every
 * detected utterance as a barge-in — that would make Cicero interrupt itself
 * constantly. We compare the transcript against what Cicero is currently saying
 * (`speaking`) and only yield to genuinely new speech.
 *
 * Order matters: a bare "stop" is checked before echo so the user can always halt
 * playback even if "stop" happens to overlap Cicero's words (it never trips the
 * echo guard anyway — a single word is below the echo floor).
 */
export function classifyBargeIn(transcript: string | null | undefined, speaking: string): BargeInClass {
  const t = (transcript ?? "").trim();
  if (!t) return "empty";
  if (isStopCommand(t)) return "stop";
  if (speaking && isSelfEcho(t, speaking)) return "echo";
  return "command";
}

/**
 * ConversationalListener — Continuous voice conversation mode.
 *
 * Flow:
 * 1. Activated via hotkey or typing "voice"
 * 2. Records audio via AudioRecorder with silence detection (auto-stops on pause)
 * 3. Transcribes via STTProvider
 * 4. Fires command callback with transcript
 * 5. Waits for processing + TTS to finish, then resumes listening
 * 6. Deactivated via hotkey, "stop listening", or "goodbye"
 */
export class ConversationalListener implements Listener {
  private callback?: (text: string) => void;
  private bargeInCallback?: () => void;
  private stopCallback?: () => void;
  private deactivateCallback?: () => void;
  private active = false;
  private listening = false;
  // Every activate/deactivate transition advances the epoch. Async work from a
  // previous activation must never observe a later `active=true` and reopen the
  // mic. A new activation waits only for the prior capture to release the audio
  // device; an old command callback may finish independently.
  private activationEpoch = 0;
  private captureInFlight: Promise<string | null> | null = null;
  private bargeCaptureInFlight: Promise<string | null> | null = null;
  private oneShotCaptureInFlight: Promise<string> | null = null;
  private oneShotListening = false;
  private sttProvider: STTProvider;
  private recorder: AudioRecorder;
  private audioPlayer: AudioPlayer;
  private audioDir: string;
  private currentRecording: ReturnType<typeof Bun.spawn> | null = null;
  private recordingTermination: {
    proc: ReturnType<typeof Bun.spawn>;
    task: Promise<void>;
    error: Error | null;
  } | null = null;
  // Exact recorder release started by deactivate(). The callback that hands the
  // mic back to clap/AEC is synchronous, so it needs a durable promise it can
  // await instead of inferring release from `active=false`.
  private captureRelease: Promise<void> = Promise.resolve();
  private assetsDir: string;
  private processing = false;
  private bargeInEnabled = false;
  // Full-duplex: keep the mic open during TTS and yield to genuine user speech
  // (echo-rejected), instead of the half-duplex record→speak→record ping-pong.
  private fullDuplex = false;
  // True while we're listening for a barge-in over Cicero's own reply. A clap in
  // this window interrupts; a clap while idle-listening deactivates (if enabled).
  private detectingBargeIn = false;
  private clapDeactivateEnabled = false;
  // Text Cicero last spoke — guards the next transcript against self-echo.
  private lastSpoken: string | null = null;
  // Returns what Cicero is speaking *right now* (live) so a barge-in candidate can
  // be checked against it for self-echo. Set by the daemon from the streaming
  // speaker's snapshot; absent → no live echo reference (only lastSpoken is used).
  private speakingTextProvider?: () => string;

  // silence detection params — must be long enough for natural speech pauses
  private silenceDuration: string;
  private silenceThreshold: string;

  // Semantic end-of-turn detection (optional). `turnActive` is set from a
  // startup health check and cleared if the model server goes away mid-session,
  // so a dead detector never blindly engages the grace loop.
  private turnDetector: TurnDetector | null = null;
  private turnThreshold = 0.6;
  private turnGraceAttempts = 2;
  private turnGraceMaxDuration = 3;
  private turnActive = false;

  // Streaming VAD end-of-turn. When set, it replaces the sox absolute-volume
  // silence gate: the turn ends a short hangover after the speaker stops, the
  // way production voice stacks do it. Null = legacy sox silence detection.
  private vadRecorder: VadRecorder | null = null;
  // Master switch for the activate/ready/thinking/success/error beeps. Off makes
  // the loop feel less robotic and keeps earcon bleed out of the VAD calibration.
  private earconsEnabled = true;

  constructor(
    sttProvider: STTProvider,
    recorder: AudioRecorder,
    audioPlayer: AudioPlayer,
    bargeInEnabled = false,
    silenceDuration = "1.5",
    silenceThreshold = "3%",
    turn?: TurnOptions,
    vad?: VadRecorderOptions,
    earcons = true,
    fullDuplex = false,
    clap?: { threshold?: number; minGapMs?: number; maxGapMs?: number; deactivate?: boolean },
    micHub?: AecAudioHub,
  ) {
    this.sttProvider = sttProvider;
    this.recorder = recorder;
    this.audioPlayer = audioPlayer;
    this.audioDir = ciceroPath("tmp");
    this.bargeInEnabled = bargeInEnabled;
    this.fullDuplex = fullDuplex;
    this.silenceDuration = silenceDuration;
    this.silenceThreshold = silenceThreshold;
    this.clapDeactivateEnabled = clap?.deactivate ?? false;
    if (vad) {
      // The double-clap gesture rides on the conversational recorder's own stream
      // (no second mic). It's the reliable interrupt/deactivate signal on open
      // speakers — a clap peaks above TTS, so it cuts through without AEC. Wire it
      // when full-duplex (clap → interrupt mid-reply) or clap.deactivate (clap →
      // turn voice off); onClapGesture picks which by current state.
      const clapGesture =
        clap && (this.fullDuplex || clap.deactivate)
          ? { threshold: clap.threshold, minGapMs: clap.minGapMs, maxGapMs: clap.maxGapMs, onDoubleClap: () => this.onClapGesture() }
          : undefined;
      // When the AEC hub is present, the recorder reads the echo-cancelled mic from
      // it instead of sox — so the mic doesn't hear Cicero's own TTS and a real
      // barge-in (genuine speech over the speakers) can actually open the gate.
      const vadOpts: VadRecorderOptions = { ...vad };
      if (clapGesture) vadOpts.clapGesture = clapGesture;
      if (micHub) vadOpts.micHub = micHub;
      this.vadRecorder = new VadRecorder(vadOpts);
      // A clap is only meaningful in two windows: deactivate while idle-listening
      // (clap.deactivate) and interrupt during a reply (armed in runFullDuplexTurn).
      // Disarm it for the plain listen otherwise — a stray clap there would cancel
      // the capture and break the listen loop (the "voice didn't work" bug).
      this.vadRecorder.setClapEnabled(this.clapDeactivateEnabled);
    }
    this.earconsEnabled = earcons;
    if (turn) {
      this.turnDetector = turn.detector;
      this.turnThreshold = turn.threshold;
      this.turnGraceAttempts = turn.graceAttempts;
      this.turnGraceMaxDuration = turn.graceMaxDuration;
    }
    // Assets dir is at project root /assets/
    this.assetsDir = join(dirname(dirname(import.meta.dir)), "assets");
  }

  async start(): Promise<void> {
    ensurePrivateDirectorySync(this.audioDir);

    log("ok", "Conversational listener ready (say 'stop listening' or 'goodbye' to deactivate)");
  }

  async stop(): Promise<void> {
    this.deactivate();
    // stop() is also valid before activation, so explicitly request release even
    // when deactivate() was an idempotent no-op.
    const recordingStop = this.requestAudioCaptureStop();
    // Recorder/helper cleanup is expected to be immediate, but never let a
    // broken platform process hang daemon shutdown.
    await Promise.all([
      this.waitForAudioRelease([this.captureInFlight, this.bargeCaptureInFlight, this.oneShotCaptureInFlight]),
      recordingStop,
    ]);
  }

  onCommand(callback: (text: string) => void): void {
    this.callback = callback;
  }

  /**
   * Invoke the command callback, awaiting it whether it returns void or a
   * promise. Errors are logged and swallowed so one bad turn can't kill the loop.
   */
  private async fireCallback(text: string): Promise<void> {
    try {
      await this.callback?.(text);
    } catch (err: unknown) {
      log("warn", `Command callback error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Record what Cicero just spoke so the next captured utterance can be checked
   * for self-echo (mic picking up our own TTS through open speakers).
   */
  noteSpoken(text: string): void {
    this.lastSpoken = text?.trim() || null;
  }

  /**
   * Register callback to interrupt TTS playback when barge-in is detected.
   */
  onBargeIn(callback: () => void): void {
    this.bargeInCallback = callback;
  }

  /**
   * Provide a live snapshot of the text Cicero is currently speaking. Full-duplex
   * uses it to tell a real barge-in apart from the mic re-capturing our own TTS.
   */
  setSpeakingTextProvider(fn: () => string): void {
    this.speakingTextProvider = fn;
  }

  /**
   * A double-clap landed (from our own capture stream). Meaning depends on state:
   * mid-reply it interrupts so you can speak; idle-listening it deactivates voice
   * mode if clap.deactivate is on. A clap is used because it peaks above TTS and
   * stays detectable over the speakers without echo cancellation.
   */
  private onClapGesture(): void {
    if (this.detectingBargeIn && this.bargeInCallback) {
      log("ok", "👏👏 Double-clap — interrupting");
      this.bargeInCallback();
      return;
    }
    if (this.clapDeactivateEnabled) {
      log("ok", "👏👏 Double-clap — deactivating voice mode");
      this.deactivate();
    }
  }

  /** What Cicero is saying right now (live), falling back to the last full turn. */
  private currentlySpeaking(): string {
    try {
      const live = this.speakingTextProvider?.().trim();
      if (live) return live;
    } catch (err: unknown) {
      log("info", `Speaking-text provider failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.lastSpoken ?? "";
  }

  /**
   * Register a callback fired when a barge-in turns out to be a bare "stop"
   * command (TTS interrupted, no new command dispatched). Lets the daemon
   * discard any pending interruption-recovery state.
   */
  onStopCommand(callback: () => void): void {
    this.stopCallback = callback;
  }

  /**
   * Register a callback fired whenever voice mode turns off — however it was
   * triggered (button, hotkey, "goodbye", or a mic failure). The daemon uses it
   * to resume clap-to-activate once the mic is free again.
   */
  onDeactivate(callback: () => void): void {
    this.deactivateCallback = callback;
  }

  activate(): void {
    if (this.active) return;
    this.active = true;
    const epoch = ++this.activationEpoch;
    log("ok", "Conversational mode activated — listening...");
    this.playSound("activate");
    const priorCapture = this.captureInFlight;
    const priorBargeCapture = this.bargeCaptureInFlight;
    const priorOneShotCapture = this.oneShotCaptureInFlight;
    void (async () => {
      // The previous epoch's capture owns the mic until deactivate tears it
      // down. Hand off only after it settles; command processing does not own
      // the audio device and therefore does not block reactivation.
      const captures = [priorCapture, priorBargeCapture, priorOneShotCapture];
      let released = false;
      for (let attempt = 1; attempt <= AUDIO_RELEASE_ATTEMPTS; attempt++) {
        released = await this.waitForAudioRelease(captures);
        if (!this.isCurrentActivation(epoch)) return;
        if (released) break;
        if (attempt < AUDIO_RELEASE_ATTEMPTS) {
          log("warn", "Previous microphone capture is still releasing — retrying cleanup once");
          void this.requestAudioCaptureStop();
        }
      }
      if (!released) {
        this.reportAudioReleaseFailure();
        this.deactivate();
        return;
      }
      if (this.isCurrentActivation(epoch)) await this.listenLoop(epoch);
    })().catch((err: unknown) => {
      if (this.isCurrentActivation(epoch)) {
        log("warn", `Listener activation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.activationEpoch++;
    this.listening = false;
    this.detectingBargeIn = false;
    void this.requestAudioCaptureStop();
    this.playSound("deactivate");
    log("ok", "Conversational mode deactivated");
    try {
      this.deactivateCallback?.();
    } catch (err: unknown) {
      log("info", `Deactivate callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Wait until the recorder release requested by the latest deactivate/stop is
   * confirmed. If another request supersedes it while awaiting, follow that new
   * barrier too so callers never observe an obsolete completion.
   */
  async waitForCaptureRelease(): Promise<void> {
    while (true) {
      const release = this.captureRelease;
      await release;
      if (this.captureRelease === release) return;
    }
  }

  /**
   * Request (or retry) exact microphone release and return its durable barrier.
   * Unlike the observer above, a fresh call can recover a recorder whose prior
   * termination attempt failed but whose next direct-child reap succeeds.
   */
  releaseAudioCapture(): Promise<void> {
    return this.requestAudioCaptureStop();
  }

  /** Ask every recorder implementation to relinquish its microphone handle. */
  private requestAudioCaptureStop(): Promise<void> {
    // Kill any in-progress recording (sox silence path or streaming VAD path).
    // Preserve a rejected task as the public handoff barrier: logging an error
    // must not accidentally authorize another microphone owner.
    const recordingStop = this.currentRecording
      ? this.terminateRecording(this.currentRecording)
      : (this.recordingTermination?.task ?? Promise.resolve());
    const vadStop = this.vadRecorder?.stop() ?? Promise.resolve();
    const prior = this.captureRelease;
    // Wait for every older operation to settle so none can escape this barrier.
    // Its rejection alone is not permanent: the exact current cleanup attempt
    // below may be a successful retry of that same recorder.
    const release = Promise.all([prior.catch(() => {}), recordingStop, vadStop]).then(() => {});
    this.captureRelease = release;
    void release.catch((err: unknown) => {
      log("info", `Audio capture cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return release;
  }

  /** Idempotently escalate and reap the exact legacy sox capture being stopped. */
  private terminateRecording(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const prior = this.recordingTermination;
    if (prior?.proc === proc && prior.error === null) return prior.task;
    if (this.recordingTermination === prior) this.recordingTermination = null;

    const attempt: {
      proc: ReturnType<typeof Bun.spawn>;
      task: Promise<void>;
      error: Error | null;
    } = { proc, task: Promise.resolve(), error: null };
    attempt.task = terminateDirectChild(proc)
      .then(() => {
        if (this.currentRecording === proc) this.currentRecording = null;
      })
      .catch((err: unknown) => {
        attempt.error = err instanceof Error ? err : new Error(String(err));
        throw attempt.error;
      })
      .finally(() => {
        if (attempt.error === null && this.recordingTermination === attempt) this.recordingTermination = null;
      });
    this.recordingTermination = attempt;
    return attempt.task;
  }

  /**
   * Observe natural exit, external cancellation, and cleanup failure without an
   * unbounded wait. `shouldStop` is polled only for the legacy grace deadline;
   * normal deactivate/stop calls terminateRecording immediately themselves.
   */
  private async waitForRecordingExit(
    proc: ReturnType<typeof Bun.spawn>,
    shouldStop?: () => boolean,
  ): Promise<number> {
    let timer: ReturnType<typeof setInterval> | undefined;
    let polling = true;
    const terminationFailure = new Promise<never>((_, reject) => {
      const stopPolling = (): void => {
        polling = false;
        if (timer !== undefined) clearInterval(timer);
      };
      const poll = (): void => {
        if (!polling) return;
        try {
          let termination: Promise<void> | null = null;
          if (shouldStop?.()) termination = this.terminateRecording(proc);
          else if (this.recordingTermination?.proc === proc) termination = this.recordingTermination.task;
          if (!termination) return;
          stopPolling();
          void termination.catch((error: unknown) => { reject(error); });
        } catch (error: unknown) {
          stopPolling();
          reject(error);
        }
      };
      // Check cancellation/grace immediately, then keep one constant-space poll
      // timer. proc.exited itself participates in exactly one Promise.race below.
      poll();
      if (polling) timer = setInterval(poll, 200);
    });

    try {
      const code = await Promise.race([proc.exited, terminationFailure]);
      if (this.recordingTermination?.proc === proc) this.recordingTermination = null;
      return code;
    } finally {
      polling = false;
      if (timer !== undefined) clearInterval(timer);
    }
  }

  isActive(): boolean {
    return this.active;
  }

  commandProcessed(): void {
    // The listen loop checks this.active and resumes automatically
  }

  /**
   * Main listen loop: record → transcribe → callback → repeat
   */
  private async listenLoop(epoch: number): Promise<void> {
    await this.initTurnDetection(epoch);
    if (!this.isCurrentActivation(epoch)) return;
    while (this.isCurrentActivation(epoch)) {
      try {
        this.listening = true;

        // Capture one full user turn. With turn detection off this is a single
        // silence-bounded recording (legacy behavior); with it on, a brief
        // silence is only a candidate end-of-turn and the mic may stay open.
        const capture = this.captureTurn(epoch);
        this.captureInFlight = capture;
        let transcript: string | null;
        try {
          transcript = await capture;
        } finally {
          if (this.captureInFlight === capture) this.captureInFlight = null;
        }

        this.listening = false;

        if (transcript === null || !this.isCurrentActivation(epoch)) break; // cancelled/deactivated
        if (!transcript) continue;                       // nothing intelligible

        // Drop our own TTS if the mic captured it (open-speaker feedback loop).
        // The guard only covers the first utterance after speaking.
        if (this.lastSpoken && isSelfEcho(transcript, this.lastSpoken)) {
          log("info", `🔇 Ignored self-echo: "${transcript}"`);
          this.lastSpoken = null;
          continue;
        }
        this.lastSpoken = null;

        // Check for deactivation phrases
        const lower = transcript.toLowerCase().trim();
        if (this.isDeactivationPhrase(lower)) {
          this.deactivate();
          break;
        }

        // Fire callback (handleCommand logs "Heard:" — no need to duplicate here)
        if (this.callback) {
          this.processing = true;
          const callbackPromise = this.fireCallback(transcript);

          if (this.fullDuplex && this.bargeInCallback) {
            // Full-duplex: mic stays open through TTS; yield to genuine, echo-
            // rejected user speech and re-arm immediately for a continuous flow.
            await this.runFullDuplexTurn(callbackPromise, epoch);
            this.processing = false;
          } else if (this.bargeInEnabled && this.bargeInCallback) {
            // Legacy barge-in used to arm only one 10-second recording; once its
            // cap elapsed, a long-thinking agent became impossible to interrupt.
            // Keep re-arming until the callback finishes or genuine speech wins.
            await this.runLegacyBargeInTurn(callbackPromise, epoch);
            this.processing = false;
          } else {
            // No barge-in: wait for callback to finish
            await callbackPromise;
            this.processing = false;
          }
        }

        // Half-duplex: a ready beep + brief settle before re-arming. Full-duplex
        // re-arms immediately for a continuous feel — no beep, no gap.
        if (this.isCurrentActivation(epoch) && !this.fullDuplex) {
          this.playSound("ready");
          await Bun.sleep(200);
        }
      } catch (err: unknown) {
        if (this.isCurrentActivation(epoch)) {
          const msg = err instanceof Error ? err.message : String(err);
          log("warn", `Listen loop error: ${msg}`);
          await Bun.sleep(1000);
        }
      }
    }
  }

  private isCurrentActivation(epoch: number): boolean {
    return this.active && this.activationEpoch === epoch;
  }

  private async waitForAudioRelease(captures: Array<Promise<unknown> | null>): Promise<boolean> {
    const pending = captures.filter((capture): capture is Promise<unknown> => capture !== null);
    if (pending.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.allSettled(pending).then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), AUDIO_RELEASE_TIMEOUT_MS); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Capture and transcribe a single spoken turn — used for spoken confirmations
   * during voice-driven computer use. Returns "" if nothing intelligible was heard.
   *
   * Any in-flight barge detector is suspended first so the confirmation capture
   * owns the mic exclusively; full-duplex detection re-arms after it settles.
   */
  listenOnce(): Promise<string> {
    if (this.oneShotCaptureInFlight) return this.oneShotCaptureInFlight;
    const capture = this.runOneShotCapture(this.activationEpoch);
    const tracked = capture.finally(() => {
      if (this.oneShotCaptureInFlight === tracked) this.oneShotCaptureInFlight = null;
    });
    this.oneShotCaptureInFlight = tracked;
    return tracked;
  }

  private async runOneShotCapture(epoch: number): Promise<string> {
    try {
      this.oneShotListening = true;
      const bargeCapture = this.bargeCaptureInFlight;
      if (this.currentRecording) {
        void this.terminateRecording(this.currentRecording).catch((err: unknown) => {
          log("info", `Recorder handoff cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      const vadStop = this.vadRecorder?.stop() ?? Promise.resolve();
      const [released, vadStopped] = await Promise.all([
        this.waitForAudioRelease([bargeCapture]),
        vadStop.then(() => true, (err: unknown) => {
          log("info", `VAD handoff cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }),
      ]);
      if (!released || !vadStopped) {
        log("warn", "Could not release barge-in capture for one-shot listening");
        return "";
      }
      // Deactivation can complete its recorder-release barrier while this
      // one-shot is still awaiting the preliminary barge/VAD handoff. Recheck
      // the epoch at the last boundary before opening a new microphone capture;
      // otherwise a stale continuation could start `rec` after clap was rearmed.
      if (!this.isCurrentActivation(epoch)) return "";

      const result = await this.recordUntilSilence();
      if (!this.isCurrentActivation(epoch)) {
        if (result.status === "ok") { try { unlinkSync(result.path); } catch { /* stale capture cleanup */ } }
        return "";
      }
      if (result.status === "error") this.reportMicFailure(result.message);
      if (result.status !== "ok") return "";
      try {
        const transcript = (await this.sttProvider.transcribe(result.path)) ?? "";
        return this.isCurrentActivation(epoch) ? transcript : "";
      } finally {
        try { unlinkSync(result.path); } catch { /* best-effort cleanup */ }
      }
    } finally {
      this.oneShotListening = false;
    }
  }

  /**
   * One-time check (per activation) of whether the turn detector is reachable.
   * Only a healthy detector engages the grace loop — otherwise a model that's
   * down would report "not complete" forever and stall every turn.
   */
  private async initTurnDetection(epoch?: number): Promise<void> {
    const stillCurrent = () => epoch === undefined || this.isCurrentActivation(epoch);
    if (!this.turnDetector) {
      if (stillCurrent()) this.turnActive = false;
      return;
    }
    let healthy: boolean;
    try {
      healthy = await Promise.race([
        this.turnDetector.health(),
        Bun.sleep(2000).then(() => false),
      ]);
    } catch (err: unknown) {
      if (stillCurrent()) {
        this.turnActive = false;
        log("info", `Turn detector health check failed — using silence detection: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (!stillCurrent()) return;
    this.turnActive = healthy;
    if (this.turnActive) {
      log("ok", `🗣️  Semantic end-of-turn detection active (${this.turnDetector.name})`);
    } else {
      log("info", "Turn detector unavailable — using silence detection");
    }
  }

  /**
   * Capture one full user turn.
   *
   * Without a healthy turn detector: a single silence-bounded recording (legacy).
   *
   * With one: each silence-bounded recording is a *candidate* end-of-turn. The
   * model judges whether the speaker is actually done; if not, the mic reopens
   * for a bounded grace window (so a mid-thought pause isn't cut off) and the
   * continuation is appended. Bounded by `turnGraceAttempts` so it never hangs.
   *
   * Returns the joined transcript, "" if nothing intelligible was heard, or null
   * if the initial recording was cancelled/silent (caller exits the loop).
   */
  private async captureTurn(epoch: number = this.activationEpoch): Promise<string | null> {
    const segments: string[] = [];
    let attempts = 0;

    while (this.isCurrentActivation(epoch)) {
      const isGrace = attempts > 0;
      // Grace rounds bound how long we wait for the user to resume; the initial
      // recording uses the normal open-ended silence gate.
      const result = await this.recordUntilSilence(isGrace ? this.turnGraceMaxDuration : undefined);
      if (!this.isCurrentActivation(epoch)) {
        if (result.status === "ok") { try { unlinkSync(result.path); } catch { /* stale capture cleanup */ } }
        return null;
      }

      if (result.status === "cancelled") return null;

      if (result.status === "error") {
        // The recorder couldn't open the mic — almost always a missing OS
        // permission. Surface it and turn voice mode off rather than leaving a
        // zombie "active" loop the user gets no feedback from.
        this.reportMicFailure(result.message);
        this.deactivate();
        return null;
      }

      if (result.status === "silent") {
        if (isGrace) break;   // grace window elapsed → finalize what we have
        continue;             // quiet pause before any speech → stay armed, keep listening
      }

      const wav = result.path;
      const tStt = Date.now();
      const transcript = await this.transcribeSafe(wav);
      if (!this.isCurrentActivation(epoch)) {
        try { unlinkSync(wav); } catch { /* stale capture cleanup */ }
        return null;
      }
      log("info", `⏱  STT ${Date.now() - tStt}ms`);

      // Predict before deleting the audio (decode reads the file).
      let prediction: TurnPrediction | null = null;
      if (this.turnActive) prediction = await this.predictTurn(wav, epoch);
      try { unlinkSync(wav); } catch {}
      if (!this.isCurrentActivation(epoch)) return null;

      if (transcript) segments.push(transcript);

      // No detector, or it just went away → single-shot, legacy behavior.
      if (!this.turnActive) break;

      const silenceForced = attempts >= this.turnGraceAttempts;
      const { endTurn } = decideEndOfTurn({ prediction, silenceForced, threshold: this.turnThreshold });
      if (endTurn) break;

      log("info", `⏳ Turn likely unfinished (p=${prediction?.probability.toFixed(2) ?? "n/a"}) — keeping the mic open`);
      attempts++;
    }

    if (!this.isCurrentActivation(epoch)) return null;
    return segments.join(" ").trim();
  }

  /** Transcribe a wav, swallowing errors to "" so one STT hiccup can't kill the loop. */
  private async transcribeSafe(wav: string): Promise<string> {
    try {
      return (await this.sttProvider.transcribe(wav))?.trim() ?? "";
    } catch (err: unknown) {
      log("info", `Transcribe failed: ${err instanceof Error ? err.message : String(err)}`);
      return "";
    }
  }

  /**
   * Run the turn model on a recorded wav. Returns null (defer to silence) on any
   * failure. If the model returns its server-unreachable sentinel, re-check
   * health and disable turn detection for the session so we stop grace-looping.
   */
  private async predictTurn(wav: string, epoch?: number): Promise<TurnPrediction | null> {
    const stillCurrent = () => epoch === undefined || this.isCurrentActivation(epoch);
    if (!this.turnDetector) return null;
    try {
      const { samples, sampleRate } = await decodeWavFile(wav);
      if (!stillCurrent()) return null;
      const prediction = await this.turnDetector.predict(samples, sampleRate);
      if (!stillCurrent()) return null;
      if (
        typeof prediction.complete !== "boolean" ||
        !Number.isFinite(prediction.probability) ||
        prediction.probability < 0 ||
        prediction.probability > 1
      ) {
        if (stillCurrent()) this.disableTurnDetection("returned an invalid prediction");
        return null;
      }
      if (prediction.probability === 0 && !prediction.complete) {
        const healthy = await Promise.race([
          this.turnDetector.health(),
          Bun.sleep(2000).then(() => false),
        ]);
        if (!stillCurrent()) return null;
        if (!healthy) {
          this.disableTurnDetection("went away");
          return null;
        }
      }
      return prediction;
    } catch (err: unknown) {
      if (stillCurrent()) this.disableTurnDetection(`prediction failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private disableTurnDetection(reason: string): void {
    this.turnActive = false;
    log("info", `Turn detector ${reason} — reverting to silence detection`);
  }

  /**
   * Record audio from mic using AudioRecorder, auto-stop on silence.
   * Returns path to the recorded wav file, or null if cancelled.
   *
   * `graceDeadlineSec`, when set, bounds how long to wait for the user to start
   * speaking: if no meaningful audio has been captured by the deadline, the
   * recorder is stopped (the user didn't resume). Once speech is flowing the
   * deadline is ignored, so a long continuation isn't truncated.
   */
  private async recordUntilSilence(graceDeadlineSec?: number): Promise<CaptureResult> {
    if (this.vadRecorder) return this.recordViaVad(graceDeadlineSec);
    if (this.currentRecording) {
      return { status: "error", message: "previous recorder has not been reaped" };
    }

    const audioFile = join(this.audioDir, `utterance-${Date.now()}.wav`);
    const maxDurationSec = 30;

    const startedAt = Date.now();
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = this.recorder.record(audioFile, {
        sampleRate: 16000,
        silenceDuration: this.silenceDuration,
        silenceThreshold: this.silenceThreshold,
        maxDuration: maxDurationSec,
      });
    } catch (err: unknown) {
      return { status: "error", message: `recorder failed to start: ${err instanceof Error ? err.message : String(err)}` };
    }

    this.currentRecording = proc;

    // Drain stderr concurrently so a failing recorder (e.g. no mic permission)
    // gives us an actionable message — and the pipe can't fill and stall sox.
    const stderr = proc.stderr;
    const stderrText = stderr && typeof stderr !== "number"
      ? collectRecorderStderrTail(stderr).catch(() => "")
      : Promise.resolve("");

    let killedForSilence = false;
    let killedForDuration = false;
    let exitCode: number;
    try {
      exitCode = await this.waitForRecordingExit(proc, () => {
        if (!this.active) return true;
        const now = Date.now();
        // Sox's own max-duration option is not trusted as the only bound: a
        // wedged helper must be stopped even when it emits zero/header-only data.
        if (now - startedAt >= maxDurationSec * 1000 + LEGACY_RECORDING_WALL_SLACK_MS) {
          killedForDuration = true;
          return true;
        }
        let size = 0;
        try { size = statSync(audioFile).size; } catch {}
        // Grace deadline: give up only if no speech has landed yet (file still
        // sub-1KB). If audio is already flowing, let sox stop on natural silence.
        if (graceDeadlineSec !== undefined && (now - startedAt) / 1000 >= graceDeadlineSec) {
          if (size < 1024) {
            killedForSilence = true;
            return true;
          }
        }
        return false;
      });
    } catch (err: unknown) {
      try { unlinkSync(audioFile); } catch { /* best effort */ }
      return {
        status: "error",
        message: `recorder cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (this.currentRecording === proc) this.currentRecording = null;

    const recordedMs = Date.now() - startedAt;
    const hitCap = killedForDuration || (!killedForSilence && recordedMs >= maxDurationSec * 1000 - 500);
    log("info", `⏱  Recorded ${recordedMs}ms${hitCap ? ` — hit ${maxDurationSec}s cap (silence gate never fired; threshold ${this.silenceThreshold} is below your room noise floor)` : ""}`);

    if (!this.active) {
      try { unlinkSync(audioFile); } catch {}
      return { status: "cancelled" };
    }

    let size = 0;
    try { size = statSync(audioFile).size; } catch {}

    // A WAV header alone is ~44 bytes; < 1KB means no real audio was captured.
    if (size < 1024) {
      try { unlinkSync(audioFile); } catch {}
      // A non-zero exit we didn't trigger means the recorder itself failed to
      // run (missing binary, no input device, denied mic permission) — not just
      // a quiet user. Surface that distinctly so the caller can tell the user.
      if (exitCode !== 0 && !killedForSilence) {
        const tail = (await stderrText).trim().split("\n").filter(Boolean).pop();
        return { status: "error", message: tail || `recorder exited with code ${exitCode}` };
      }
      return { status: "silent" };
    }

    return { status: "ok", path: audioFile };
  }

  /**
   * Streaming VAD capture path. Replaces the sox absolute-volume silence gate:
   * the recorder uses its learned room floor, opens on speech, and ends the turn
   * a short hangover after the speaker stops. `graceDeadlineSec` bounds how long to wait
   * for speech to begin (grace rounds); otherwise the recorder's default applies.
   */
  private async recordViaVad(graceDeadlineSec?: number): Promise<CaptureResult> {
    const audioFile = join(this.audioDir, `utterance-${Date.now()}.wav`);
    const startedAt = Date.now();
    const onsetTimeoutMs = graceDeadlineSec !== undefined ? graceDeadlineSec * 1000 : undefined;

    const result = await this.vadRecorder!.capture(audioFile, onsetTimeoutMs);
    log("info", `⏱  Recorded ${Date.now() - startedAt}ms (vad: ${result.status})`);

    if (!this.active) {
      try { unlinkSync(audioFile); } catch { /* may not have been written */ }
      return { status: "cancelled" };
    }
    return result;
  }

  /**
   * Full-duplex turn: keep the mic open while Cicero speaks (`callbackPromise`
   * drives the reply's TTS). Each cycle races "TTS finished" against "speech
   * captured". A capture is classified against what Cicero is saying *right now*:
   * our own TTS bleeding through the speakers is ignored (keep talking), a "stop"
   * halts playback, and genuine speech interrupts and becomes a new turn.
   */
  private async runFullDuplexTurn(callbackPromise: Promise<void>, epoch: number = this.activationEpoch): Promise<void> {
    if (!this.isCurrentActivation(epoch)) return;
    const done = callbackPromise.then(() => "done" as const);
    this.detectingBargeIn = true; // a clap in this window interrupts (see onClapGesture)
    this.vadRecorder?.setClapEnabled(true); // arm clap-to-interrupt for the reply
    try {
      await this.bargeInLoop(done, epoch);
    } finally {
      if (this.isCurrentActivation(epoch)) {
        this.detectingBargeIn = false;
        this.vadRecorder?.setClapEnabled(this.clapDeactivateEnabled); // back to idle policy
      }
    }
  }

  /**
   * Half-duplex compatibility barge-in. Each detector has a finite recording cap,
   * so re-arm after a silent/capped attempt while the command is still thinking.
   * This keeps legacy `barge_in_enabled` interruptible for arbitrarily long turns.
   */
  private async runLegacyBargeInTurn(callbackPromise: Promise<void>, epoch: number = this.activationEpoch): Promise<void> {
    let done = callbackPromise.then(() => "done" as const);
    while (this.isCurrentActivation(epoch)) {
      const detect = this.detectBargeIn();
      const winner = await Promise.race([done, detect.then((audio) => ({ audio }))]);

      if (!this.isCurrentActivation(epoch)) {
        if (winner !== "done" && winner.audio) {
          try { unlinkSync(winner.audio); } catch { /* stale capture cleanup */ }
        } else {
          const leftover = await detect;
          if (leftover) { try { unlinkSync(leftover); } catch { /* stale capture cleanup */ } }
        }
        return;
      }

      if (winner === "done") {
        if (this.currentRecording) {
          void this.terminateRecording(this.currentRecording).catch((err: unknown) => {
            log("info", `Barge recorder cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        try {
          await this.vadRecorder?.stop();
        } catch (err: unknown) {
          log("info", `VAD barge cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const leftover = await detect;
        if (leftover) { try { unlinkSync(leftover); } catch { /* best effort */ } }
        return;
      }

      if (!winner.audio) {
        // A cap/silent attempt is not the end of the interruption window. Avoid
        // a tight retry loop if a platform recorder fails synchronously.
        await Bun.sleep(25);
        continue;
      }

      log("info", "Barge-in detected — interrupting TTS");
      this.bargeInCallback?.();
      if (!this.isCurrentActivation(epoch)) {
        try { unlinkSync(winner.audio); } catch { /* stale capture cleanup */ }
        return;
      }
      const bargeTranscript = await this.transcribeSafe(winner.audio);
      try { unlinkSync(winner.audio); } catch { /* best effort */ }
      if (!this.isCurrentActivation(epoch)) return;

      if (isStopCommand(bargeTranscript)) {
        log("info", `Stop command "${bargeTranscript}" — interrupting TTS only, no new command`);
        this.stopCallback?.();
        return;
      }
      if (bargeTranscript && this.isCurrentActivation(epoch)) {
        // The replacement turn owns the interruption window now. Keep the mic
        // armed around its reply instead of waiting for it with no detector.
        done = this.fireCallback(bargeTranscript).then(() => "done" as const);
        const immediate = await Promise.race([
          done,
          Bun.sleep(0).then(() => "pending" as const),
        ]);
        if (immediate === "done") return;
        continue;
      }
      return;
    }
  }

  /** The detect→classify→act loop, run while {@link runFullDuplexTurn} holds the window. */
  private async bargeInLoop(done: Promise<"done">, epoch: number): Promise<void> {
    while (this.isCurrentActivation(epoch)) {
      const detect = this.detectBargeIn();
      const winner = await Promise.race([done, detect.then((audio) => ({ audio }))]);

      if (!this.isCurrentActivation(epoch)) {
        if (winner !== "done" && winner.audio) {
          try { unlinkSync(winner.audio); } catch { /* stale capture cleanup */ }
        } else {
          const leftover = await detect;
          if (leftover) { try { unlinkSync(leftover); } catch { /* stale capture cleanup */ } }
        }
        return;
      }

      if (winner === "done") {
        try {
          await this.vadRecorder?.stop();
        } catch (err: unknown) {
          log("info", `VAD barge cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (this.currentRecording) {
          void this.terminateRecording(this.currentRecording).catch((err: unknown) => {
            log("info", `Barge recorder cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        const leftover = await detect;
        if (leftover) { try { unlinkSync(leftover); } catch { /* best-effort */ } }
        return;
      }

      const audio = winner.audio;
      if (!audio) {
        // A detector's onset/capture cap elapsed while the callback is still
        // thinking or speaking. Re-arm so hands-free interruption remains live.
        await Bun.sleep(25);
        continue;
      }

      const bargeTranscript = await this.transcribeSafe(audio);
      try { unlinkSync(audio); } catch { /* best-effort */ }
      if (!this.isCurrentActivation(epoch)) return;

      const cls = classifyBargeIn(bargeTranscript, this.currentlySpeaking());
      if (cls === "empty" || cls === "echo") {
        // Silence/noise, or the mic re-captured our own TTS — keep speaking and
        // re-arm detection rather than interrupting ourselves.
        if (cls === "echo") log("info", `🔇 Ignored self-echo during playback: "${bargeTranscript}"`);
        continue;
      }

      // Genuine user speech — interrupt the current reply immediately.
      log("info", "Barge-in detected — interrupting TTS");
      this.bargeInCallback!();
      if (!this.isCurrentActivation(epoch)) return;

      if (cls === "stop") {
        this.stopCallback?.();
        return;
      }

      // Process the interrupting utterance as a fresh turn and transfer this
      // same detector loop to it. Awaiting the callback here would leave the
      // replacement reply uninterruptible until it finished.
      if (this.isCurrentActivation(epoch)) {
        done = this.fireCallback(bargeTranscript).then(() => "done" as const);
        const immediate = await Promise.race([
          done,
          Bun.sleep(0).then(() => "pending" as const),
        ]);
        if (immediate === "done") return;
        continue;
      }
      return;
    }
  }

  /**
   * Listen for speech during TTS playback (barge-in detection).
   * Returns the recorded audio file path if speech detected, null if TTS finishes first.
   *
   * Uses the streaming VAD when available — it opens on speech *relative* to the
   * room (and to Cicero's own playback), which the legacy absolute-volume sox gate
   * can't do. The transcript-level echo check in {@link runFullDuplexTurn} is the
   * backstop when the VAD does open on speaker bleed.
   */
  private async detectBargeIn(): Promise<string | null> {
    if (this.oneShotListening) return null;
    if (this.bargeCaptureInFlight) return this.bargeCaptureInFlight;
    const capture = this.captureBargeIn();
    const tracked = capture.finally(() => {
      if (this.bargeCaptureInFlight === tracked) this.bargeCaptureInFlight = null;
    });
    this.bargeCaptureInFlight = tracked;
    return tracked;
  }

  private async captureBargeIn(): Promise<string | null> {
    if (this.vadRecorder) return this.detectBargeInVad();
    if (this.currentRecording) {
      log("info", "Barge-in recorder not started: previous recorder has not been reaped");
      return null;
    }

    const audioFile = join(this.audioDir, `bargein-${Date.now()}.wav`);

    const startedAt = Date.now();
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = this.recorder.record(audioFile, {
        sampleRate: 16000,
        silenceThreshold: "5%",
        silenceDuration: "0.8",
        maxDuration: 10,
      });
    } catch (err: unknown) {
      log("info", `Barge-in recorder failed to start: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    this.currentRecording = proc;
    // Keep the recorder's diagnostic pipe drained even during long replies; a
    // full stderr buffer must not freeze the barge-in window.
    const stderr = proc.stderr;
    const stderrText = stderr && typeof stderr !== "number"
      ? collectRecorderStderrTail(stderr).catch(() => "")
      : Promise.resolve("");
    let exitCode: number;
    try {
      exitCode = await this.waitForRecordingExit(proc, () => {
        // Absolute from spawn: zero-byte and sub-threshold files still get a
        // bounded host-side cap if sox ignores its own max-duration setting.
        return Date.now() - startedAt >= 10_000 + LEGACY_RECORDING_WALL_SLACK_MS;
      });
    } catch (err: unknown) {
      try { unlinkSync(audioFile); } catch { /* best effort */ }
      log("info", `Barge recorder cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (this.currentRecording === proc) this.currentRecording = null;

    if (!this.active) {
      try { unlinkSync(audioFile); } catch {}
      return null;
    }

    // Check if meaningful audio was captured
    try {
      const file = Bun.file(audioFile);
      if (file.size < 1024) {
        try { unlinkSync(audioFile); } catch {}
        const tail = (await stderrText).trim().split("\n").filter(Boolean).pop();
        if (exitCode !== 0 && tail) log("info", `Barge-in recorder failed: ${tail}`);
        return null;
      }
    } catch {
      await stderrText;
      return null;
    }

    return audioFile;
  }

  /**
   * VAD-gated barge-in detection. Reuses the streaming recorder (free during the
   * speak phase) to detect a spoken utterance over the playback. Only a completed,
   * speech-bearing capture is a candidate; silent/cancelled/error mean nothing the
   * user said. The recorder is cancelled by {@link runFullDuplexTurn} via
   * `vadRecorder.stop()` when the reply finishes first.
   */
  private async detectBargeInVad(): Promise<string | null> {
    const audioFile = join(this.audioDir, `bargein-${Date.now()}.wav`);
    const result = await this.vadRecorder!.capture(audioFile);
    if (!this.active) {
      try { unlinkSync(audioFile); } catch { /* may not have been written */ }
      return null;
    }
    return result.status === "ok" ? result.path : null;
  }

  /**
   * Surface a recorder failure the user can act on. The overwhelmingly common
   * cause on macOS is the terminal/host lacking Microphone permission, which
   * otherwise fails completely silently (empty recordings, no error).
   */
  private reportMicFailure(detail: string): void {
    log("error", `🎙️  Microphone capture failed: ${detail}`);
    log("warn", "Grant mic access to your terminal: System Settings → Privacy & Security → Microphone, then re-activate voice.");
    this.playSound("error");
  }

  /** Surface a stuck prior recorder distinctly from a missing mic permission. */
  private reportAudioReleaseFailure(): void {
    log("error", "🎙️  Previous microphone capture stayed busy after two release attempts — voice mode was stopped");
    log("warn", "Re-activate voice mode. If this repeats, restart Cicero and check for another process holding the microphone.");
    this.playSound("error");
  }

  playSound(name: "activate" | "deactivate" | "ready" | "error" | "success" | "thinking"): void {
    if (!this.earconsEnabled) return;
    const file = join(this.assetsDir, `${name}.wav`);
    // Fire-and-forget — don't block on sound playback
    this.audioPlayer.play(file).catch((err: unknown) => {
      log("info", `Sound '${name}' failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  isDeactivationPhrase(text: string): boolean {
    // Exact matching is intentional: `startsWith("stop")` used to deactivate
    // voice mode for legitimate requests such as "stop the deploy".
    return DEACTIVATION_COMMANDS.has(normalizeVoicePhrase(text));
  }
}

/** Drain recorder diagnostics concurrently while retaining only a useful tail. */
async function collectRecorderStderrTail(
  stream: ReadableStream<Uint8Array>,
  maxBytes = 16 * 1024,
): Promise<string> {
  const retained = new Uint8Array(maxBytes);
  let start = 0;
  let length = 0;
  try {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      if (chunk.byteLength >= maxBytes) {
        retained.set(chunk.subarray(chunk.byteLength - maxBytes));
        start = 0;
        length = maxBytes;
        continue;
      }
      for (const byte of chunk) {
        retained[(start + length) % maxBytes] = byte;
        if (length < maxBytes) length++;
        else start = (start + 1) % maxBytes;
      }
    }
  } catch {
    // The process termination path owns recorder failures; diagnostics are best effort.
  }
  const output = new Uint8Array(length);
  const first = Math.min(length, maxBytes - start);
  output.set(retained.subarray(start, start + first));
  if (first < length) output.set(retained.subarray(0, length - first), first);
  return new TextDecoder().decode(output);
}
