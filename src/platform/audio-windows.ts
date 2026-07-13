import type { AudioPlayer } from "./audio";
import { OwnedAudioPlayer, type SpawnAudioPlayer } from "./owned-audio-player";

export class WindowsAudioPlayer extends OwnedAudioPlayer implements AudioPlayer {
  constructor(spawnPlayer?: SpawnAudioPlayer) {
    super(
      (filePath) => ["ffplay", "-nodisp", "-autoexit", "-audio_buffer_size", "64", filePath],
      spawnPlayer,
    );
  }
}
