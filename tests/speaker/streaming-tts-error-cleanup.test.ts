import { expect, test } from "bun:test";
import { StreamingTTSSpeaker } from "../../src/speaker/streaming-tts";
import { AudioReleaseUnconfirmedError } from "../../src/platform/owned-audio-player";
import type { TTSProvider } from "../../src/backends/tts/provider";
import type { GenerationPin } from "../../src/backends/hot-swap";
import type { AudioPlayer } from "../../src/platform/audio";
import type { Speaker } from "../../src/types";
import { encodeSilentWav } from "../../src/platform/wav";

async function expectFatalTurnSettles(
  turn: Promise<void>,
  controller: AbortController,
  failure: AudioReleaseUnconfirmedError,
  released: () => number,
): Promise<void> {
  // This is a deadlock guard, not a delay used to order the test. If cleanup
  // stalls, the guard aborts the fixture's producer so the test can fail cleanly.
  let deadlineFired = false;
  const deadline = setTimeout(() => {
    deadlineFired = true;
    controller.abort();
  }, 2_000);
  try {
    await expect(turn).rejects.toBe(failure);
    expect(deadlineFired).toBe(false);
    expect(controller.signal.aborted).toBe(true);
    expect(released()).toBe(1);
  } finally {
    clearTimeout(deadline);
  }
}

test("streaming fallback release failure aborts stalled coalescing and releases its provider pin", async () => {
  const failure = new AudioReleaseUnconfirmedError("fallback child release is unconfirmed");
  let releases = 0;
  const provider: TTSProvider & { pinGeneration(): GenerationPin<TTSProvider> } = {
    name: "failing",
    health: async () => true,
    generateAudio: async () => { throw new Error("generation failed"); },
    pinGeneration() { return { provider, release: () => { releases++; } }; },
  };
  const fallback: Speaker = {
    speak: async () => { throw failure; },
    health: async () => true,
    stop: async () => {},
  };
  const speaker = new StreamingTTSSpeaker(
    provider,
    { play: async () => {} } as AudioPlayer,
    fallback,
    null,
    undefined,
    { maxChars: 240, passthroughFirst: 1 },
  );
  const controller = new AbortController();
  async function* source(): AsyncGenerator<string> {
    yield "First.";
    await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
    yield "late sentence";
  }

  await expectFatalTurnSettles(speaker.speakStream(source(), controller), controller, failure, () => releases);
});

test("streaming player release failure aborts stalled coalescing and releases its provider pin", async () => {
  const failure = new AudioReleaseUnconfirmedError("player child release is unconfirmed");
  let releases = 0;
  const provider: TTSProvider & { pinGeneration(): GenerationPin<TTSProvider> } = {
    name: "audio",
    health: async () => true,
    generateAudio: async () => encodeSilentWav().buffer as ArrayBuffer,
    pinGeneration() { return { provider, release: () => { releases++; } }; },
  };
  const fallback: Speaker = {
    speak: async () => { throw new Error("fallback must not start"); },
    health: async () => true,
    stop: async () => {},
  };
  const speaker = new StreamingTTSSpeaker(
    provider,
    { play: async () => {} } as AudioPlayer,
    fallback,
    null,
    () => { throw failure; },
    { maxChars: 240, passthroughFirst: 1 },
  );
  const controller = new AbortController();
  async function* source(): AsyncGenerator<string> {
    yield "First.";
    await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
    yield "late sentence";
  }

  await expectFatalTurnSettles(speaker.speakStream(source(), controller), controller, failure, () => releases);
});
