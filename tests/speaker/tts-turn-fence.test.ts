import { expect, test } from "bun:test";
import { ProviderSlot, SwappableTTSProvider } from "../../src/backends/hot-swap";
import type { TTSProvider } from "../../src/backends/tts/provider";
import type { AudioPlayer } from "../../src/platform/audio";
import { encodeWav } from "../../src/platform/wav";
import { TTSSpeaker } from "../../src/speaker/tts-speaker";
import type { Speaker } from "../../src/types";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const silentPlayer: AudioPlayer = {
  play: () => Promise.resolve(),
  stopAll: () => Promise.resolve(),
};

const silentFallback: Speaker = {
  speak: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  health: () => Promise.resolve(true),
};

function wav(sample: number): ArrayBuffer {
  return encodeWav(new Int16Array([sample])).buffer as ArrayBuffer;
}

class RecordingSpeaker extends TTSSpeaker {
  readonly played: number[] = [];

  protected override async playAudio(
    audioData: ArrayBuffer,
    stale: () => boolean = () => this.stopped,
  ): Promise<void> {
    if (stale()) return;
    this.played.push(new DataView(audioData).getInt16(audioData.byteLength - 2, true));
  }
}

test("a superseded local turn cannot play retired-generation audio after its replacement", async () => {
  const oldAudio = deferred<ArrayBuffer>();
  const oldRenderStarted = deferred<void>();
  const newerRenderStarted = deferred<void>();
  const cutover = deferred<void>();

  const retiring: TTSProvider = {
    name: "retiring",
    health: () => Promise.resolve(true),
    generateAudio: () => {
      oldRenderStarted.resolve();
      return oldAudio.promise;
    },
    stop: () => Promise.resolve(),
  };
  const replacement: TTSProvider = {
    name: "replacement",
    start: () => Promise.resolve(),
    warmup: () => Promise.resolve(),
    health: () => Promise.resolve(true),
    generateAudio: () => {
      newerRenderStarted.resolve();
      return Promise.resolve(wav(2));
    },
    stop: () => Promise.resolve(),
  };

  const slot = new ProviderSlot<TTSProvider>(retiring);
  const speaker = new RecordingSpeaker(
    new SwappableTTSProvider(slot),
    silentPlayer,
    silentFallback,
  );
  const oldTurn = new AbortController();
  const speakingOld = speaker.speak("turn A", oldTurn.signal);
  await oldRenderStarted.promise;

  const swapping = slot.swap(replacement, () => {}, {
    onCutover: () => cutover.resolve(),
  });
  await cutover.promise;

  oldTurn.abort("superseded by turn B");
  const speakingNew = speaker.speak("turn B", new AbortController().signal);
  await newerRenderStarted.promise;
  await speakingNew;
  expect(speaker.played).toEqual([2]);

  oldAudio.resolve(wav(1));
  await Promise.all([speakingOld, swapping]);

  // This final ordering assertion is the regression: without the turn fence,
  // the retired generation appends 1 after the newer turn has already played 2.
  expect(speaker.played).toEqual([2]);
  await slot.stop();
});
