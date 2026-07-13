import type { AudioPlayer } from "./audio";
import { OwnedAudioPlayer, type SpawnAudioPlayer } from "./owned-audio-player";

export class LinuxAudioPlayer extends OwnedAudioPlayer implements AudioPlayer {
  constructor(spawnPlayer?: SpawnAudioPlayer) {
    let binary: "aplay" | "paplay" | null = null;
    super((filePath) => [binary ??= Bun.which("aplay") ? "aplay" : "paplay", filePath], spawnPlayer);
  }
}
