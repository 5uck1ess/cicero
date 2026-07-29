import type { RuntimeConfig } from "../config";
import type { Listener } from "../types";
import type { STTProvider } from "../backends/stt/provider";
import type { AudioPlayer, AudioRecorder } from "../platform/audio";
import type { TurnDetector } from "../backends/turn/provider";
import type { AecAudioHub } from "../platform/aec-hub";
import { StdinListener } from "./stdin";
import { DictationListener } from "./dictation";
import { createTextInjector } from "../platform/text-inject-run";
import { ConversationalListener } from "./conversational";

export function createListener(config: RuntimeConfig): Listener {
  // Default: interactive stdin prompt (conversational mode available via toggle)
  return new StdinListener();
}

/**
 * Build the dictation listener, or return null with the reason it cannot run.
 * Returning the reason rather than throwing lets the daemon start normally and
 * tell the operator why dictation is off — a Wayland session or a missing
 * xdotool should not stop Cicero from running.
 */
export function createDictationListener(
  config: RuntimeConfig,
  sttProvider: STTProvider,
  recorder: AudioRecorder,
  /** Microphone handoff, so a capture never competes with clap or voice capture. */
  microphone?: { acquire: () => Promise<void>; release: () => Promise<void> },
): { listener: DictationListener } | { unavailable: string } {
  const dictation = config.dictation;
  const target = dictation.target ?? "focused-app";
  const maxSeconds = dictation.max_recording_seconds;
  try {
    return {
      listener: new DictationListener({
        stt: sttProvider,
        recorder,
        target,
        // Only the focused-app target types; the cicero target needs no injector,
        // so it stays available on sessions that cannot synthesize keystrokes.
        typeText: target === "focused-app" ? createTextInjector() : undefined,
        ...(maxSeconds ? { maxRecordingMs: maxSeconds * 1000 } : {}),
        ...(microphone
          ? { acquireMicrophone: microphone.acquire, releaseMicrophone: microphone.release }
          : {}),
      }),
    };
  } catch (error: unknown) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}

export function createConversationalListener(
  config: RuntimeConfig,
  sttProvider: STTProvider,
  recorder: AudioRecorder,
  audioPlayer: AudioPlayer,
  turnDetector?: TurnDetector,
  micHub?: AecAudioHub,
): ConversationalListener {
  const turn = config.turn;
  const vad = config.vad;
  const clap = config.clap;
  return new ConversationalListener(
    sttProvider,
    recorder,
    audioPlayer,
    config.bargeInEnabled,
    config.silenceDuration,
    config.silenceThreshold,
    turnDetector
      ? {
          detector: turnDetector,
          threshold: turn.threshold,
          graceAttempts: turn.graceAttempts,
          graceMaxDuration: turn.graceMaxDuration,
        }
      : undefined,
    vad.enabled
      ? {
          hangoverMs: vad.hangoverMs,
          openFactor: vad.openFactor,
          minSpeechMs: vad.minSpeechMs,
          calibrationMs: vad.calibrationMs,
          prerollMs: vad.prerollMs,
        }
      : undefined,
    config.earcons,
    config.fullDuplex,
    clap.enabled && (config.fullDuplex || clap.deactivate)
      ? { threshold: clap.threshold, minGapMs: clap.minGapMs, maxGapMs: clap.maxGapMs, deactivate: clap.deactivate }
      : undefined,
    micHub,
  );
}
