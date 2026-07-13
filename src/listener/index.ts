import type { RuntimeConfig } from "../config";
import type { Listener } from "../types";
import type { STTProvider } from "../backends/stt/provider";
import type { AudioPlayer, AudioRecorder } from "../platform/audio";
import type { TurnDetector } from "../backends/turn/provider";
import type { AecAudioHub } from "../platform/aec-hub";
import { StdinListener } from "./stdin";
import { WisprFlowListener } from "./wispr-flow";
import { ConversationalListener } from "./conversational";

export function createListener(config: RuntimeConfig): Listener {
  if (config.wakeWordEnabled) {
    // Wispr Flow mode: global hotkey activates Wispr, captures dictation
    return new WisprFlowListener(config.wisprHotkey);
  }

  // Default: interactive stdin prompt (conversational mode available via toggle)
  return new StdinListener();
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
