import type { RuntimeConfig } from "../config";
import type { Speaker } from "../types";
import type { TTSProvider } from "../backends/tts/provider";
import type { AudioPlayer } from "../platform/audio";
import type { AecAudioHub } from "../platform/aec-hub";
import { TTSSpeaker } from "./tts-speaker";
import { StreamingTTSSpeaker } from "./streaming-tts";
import { SystemSpeaker } from "../platform/system-tts";
import { SilentSpeaker } from "./silent-speaker";

export function createSpeaker(config: RuntimeConfig, ttsProvider: TTSProvider, audioPlayer: AudioPlayer): Speaker {
  if (!config.ttsEnabled) return new SilentSpeaker();
  return new TTSSpeaker(ttsProvider, audioPlayer, new SystemSpeaker());
}

export function createStreamingSpeaker(
  config: RuntimeConfig,
  ttsProvider: TTSProvider,
  audioPlayer: AudioPlayer,
  hub: AecAudioHub | null = null,
): StreamingTTSSpeaker | null {
  if (!config.ttsEnabled) return null;
  return new StreamingTTSSpeaker(ttsProvider, audioPlayer, new SystemSpeaker(), hub);
}
