import type { AudioPlayer } from "./audio";
import { OwnedAudioPlayer, type SpawnAudioPlayer } from "./owned-audio-player";

export class MacAudioPlayer extends OwnedAudioPlayer implements AudioPlayer {
  constructor(spawnPlayer?: SpawnAudioPlayer) {
    super((filePath) => ["afplay", filePath], spawnPlayer);
  }
}
