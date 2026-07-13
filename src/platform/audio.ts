import type { MacAudioPlayer } from "./audio-macos";
import type { LinuxAudioPlayer } from "./audio-linux";
import type { WindowsAudioPlayer } from "./audio-windows";
import type { SoxAudioRecorder } from "./recorder-sox";
import type { WindowsAudioRecorder } from "./recorder-windows";

export interface AudioPlayer {
  play(filePath: string): Promise<void>;
  stopAll(): Promise<void>;
}

export interface RecordOpts {
  sampleRate?: number;
  silenceDuration?: string;
  silenceThreshold?: string;
  maxDuration?: number;
}

export interface AudioRecorder {
  record(outPath: string, opts: RecordOpts): ReturnType<typeof Bun.spawn>;
}

export function createAudioPlayer(): AudioPlayer {
  switch (process.platform) {
    case "darwin": {
      const { MacAudioPlayer } = require("./audio-macos");
      return new MacAudioPlayer();
    }
    case "linux": {
      const { LinuxAudioPlayer } = require("./audio-linux");
      return new LinuxAudioPlayer();
    }
    case "win32": {
      const { WindowsAudioPlayer } = require("./audio-windows");
      return new WindowsAudioPlayer();
    }
    default: {
      const { LinuxAudioPlayer } = require("./audio-linux");
      return new LinuxAudioPlayer();
    }
  }
}

export function getPlayCommand(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
  which: (binary: string) => string | null = Bun.which,
): string[] {
  switch (platform) {
    case "darwin":
      return ["afplay", filePath];
    case "win32":
      return ["ffplay", "-nodisp", "-autoexit", "-audio_buffer_size", "64", filePath];
    default:
      return [which("aplay") ? "aplay" : "paplay", filePath];
  }
}

export function createAudioRecorder(): AudioRecorder {
  switch (process.platform) {
    case "win32": {
      const { WindowsAudioRecorder } = require("./recorder-windows");
      return new WindowsAudioRecorder();
    }
    default: {
      const { SoxAudioRecorder } = require("./recorder-sox");
      return new SoxAudioRecorder();
    }
  }
}
