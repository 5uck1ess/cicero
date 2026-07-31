import { expect, test } from "bun:test";
import { ProviderSlot, SwappableTTSProvider } from "../../src/backends/hot-swap";
import type { TTSProvider } from "../../src/backends/tts/provider";
import type { AudioPlayer } from "../../src/platform/audio";
import { encodeWav } from "../../src/platform/wav";
import { StreamingTTSSpeaker } from "../../src/speaker/streaming-tts";
import type { Speaker } from "../../src/types";

const wav = encodeWav(new Int16Array([1])).buffer as ArrayBuffer;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fallbackSpeaker(): Speaker & { speaks: string[]; stops: number } {
  const speaks: string[] = [];
  return {
    speaks,
    stops: 0,
    speak(text) { speaks.push(text); return Promise.resolve(); },
    health: () => Promise.resolve(true),
    stop() { this.stops += 1; return Promise.resolve(); },
  };
}

const silentPlayer: AudioPlayer = {
  play: () => Promise.resolve(),
  stopAll: () => Promise.resolve(),
};

/**
 * The turn pin exists so a live swap cannot move a reply onto a different
 * provider, and so the retired generation is not stopped while it is still
 * working. speakStream pulls one sentence AHEAD of playback, so an interrupt can
 * break the loop while that look-ahead render is still in flight on the pinned
 * provider — and the pin used to be released without waiting for it. For a
 * managed provider (VibeVoice) stop() kills its server, so the reply's own
 * synthesis was being torn out from under it.
 */
test("an interrupt does not release the pin while the look-ahead is still rendering", async () => {
  const secondRender = deferred<ArrayBuffer>();
  let secondRenderStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { secondRenderStarted = resolve; });

  const retiring: TTSProvider & { stops: number } = {
    name: "tts-retiring",
    stops: 0,
    health: () => Promise.resolve(true),
    generateAudio: (text: string) => {
      if (text.includes("two")) {
        secondRenderStarted();
        return secondRender.promise;
      }
      return Promise.resolve(wav);
    },
    stop() { this.stops += 1; return Promise.resolve(); },
  };
  const replacement: TTSProvider = {
    name: "tts-replacement",
    health: () => Promise.resolve(true),
    generateAudio: () => Promise.resolve(wav),
  };

  const slot = new ProviderSlot<TTSProvider>(retiring);
  const speaker = new StreamingTTSSpeaker(
    new SwappableTTSProvider(slot),
    silentPlayer,
    fallbackSpeaker(),
  );

  const firstPlayed = deferred<void>();
  async function* sentences(): AsyncGenerator<string> {
    yield "sentence one.";
    firstPlayed.resolve();
    yield "sentence two.";
  }

  const speaking = speaker.speakStream(sentences());
  // Wait until the look-ahead for sentence two is actually rendering on the
  // pinned generation; that is the window the bug lived in.
  await secondStarted;

  // Interrupt: a replacement turn claims the speaker, so the loop goes stale and
  // breaks without ever consuming the look-ahead.
  await speaker.stop();

  // A swap now wants the retired generation reaped.
  let swapped = false;
  const swapping = slot.swap(replacement, () => {}).then(() => { swapped = true; });
  await Bun.sleep(20);

  // The render is still in flight, so the generation is NOT idle and its stop()
  // must not have run.
  expect(retiring.stops).toBe(0);
  expect(swapped).toBe(false);

  // Once the abandoned render settles, the pin drops and the reap proceeds.
  secondRender.resolve(wav);
  await speaking;
  await swapping;
  expect(retiring.stops).toBe(1);
  expect(swapped).toBe(true);
}, 15_000);
