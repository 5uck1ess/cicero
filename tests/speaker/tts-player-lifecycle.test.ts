import { expect, test } from "bun:test";
import type { TTSProvider } from "../../src/backends/tts/provider";
import type { AudioPlayer } from "../../src/platform/audio";
import {
  AudioReleaseUnconfirmedError,
  OwnedAudioPlayer,
  type AudioPlayerProcess,
} from "../../src/platform/owned-audio-player";
import { encodeWav } from "../../src/platform/wav";
import { StreamingTTSSpeaker } from "../../src/speaker/streaming-tts";
import { TTSSpeaker } from "../../src/speaker/tts-speaker";
import { SystemSpeaker } from "../../src/platform/system-tts";
import type { Speaker } from "../../src/types";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function settlesWithin<T>(promise: PromiseLike<T>, label: string, timeoutMs = 100): Promise<T> {
  return Promise.race([
    Promise.resolve(promise),
    Bun.sleep(timeoutMs).then(() => { throw new Error(`${label} did not settle`); }),
  ]);
}

function controlledPlayer(pid: number, exitOnKill = true): AudioPlayerProcess & {
  signals: Array<NodeJS.Signals | number | undefined>;
  finish(code: number): void;
} {
  const exit = deferred<number>();
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  let settled = false;
  return {
    pid,
    exited: exit.promise,
    signals,
    kill(signal) {
      signals.push(signal);
      if (settled || !exitOnKill) return;
      settled = true;
      exit.resolve(143);
    },
    finish(code) {
      if (settled) return;
      settled = true;
      exit.resolve(code);
    },
  };
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

const wav = encodeWav(new Int16Array([1])).buffer as ArrayBuffer;

test("TTSSpeaker stop reaps owned playback without restarting fallback speech", async () => {
  const child = controlledPlayer(201);
  const spawned = deferred<void>();
  const audioPlayer = new OwnedAudioPlayer(
    (path) => ["fixture-player", path],
    () => {
      spawned.resolve();
      return child;
    },
  );
  const provider: TTSProvider = {
    name: "fixture",
    health: () => Promise.resolve(true),
    generateAudio: () => Promise.resolve(wav),
  };
  const fallback = fallbackSpeaker();
  const speaker = new TTSSpeaker(provider, audioPlayer, fallback);

  const speaking = speaker.speak("stop this clip");
  await spawned.promise;
  await speaker.stop();
  await speaking;

  expect(child.signals).toEqual(["SIGTERM"]);
  expect(fallback.speaks).toEqual([]);
  expect(fallback.stops).toBe(1);
});

test("TTSSpeaker stop revokes a health check before it can generate or fall back", async () => {
  const health = deferred<boolean>();
  let generations = 0;
  const provider: TTSProvider = {
    name: "fixture",
    health: () => health.promise,
    generateAudio: () => { generations += 1; return Promise.resolve(wav); },
  };
  const audioPlayer: AudioPlayer = {
    play: () => Promise.resolve(),
    stopAll: () => Promise.resolve(),
  };
  const fallback = fallbackSpeaker();
  const speaker = new TTSSpeaker(provider, audioPlayer, fallback);

  const speaking = speaker.speak("late health");
  await speaker.stop();
  health.resolve(false);
  await speaking;

  expect(generations).toBe(0);
  expect(fallback.speaks).toEqual([]);
});

test("StreamingTTSSpeaker stop reaps its raw interruptible player", async () => {
  const child = controlledPlayer(202);
  const spawned = deferred<void>();
  const audioPlayer: AudioPlayer = {
    play: () => Promise.resolve(),
    stopAll: () => Promise.resolve(),
  };
  const provider: TTSProvider = {
    name: "fixture",
    health: () => Promise.resolve(true),
    generateAudio: () => Promise.resolve(wav),
  };
  const fallback = fallbackSpeaker();
  const speaker = new StreamingTTSSpeaker(
    provider,
    audioPlayer,
    fallback,
    null,
    () => {
      spawned.resolve();
      return child;
    },
  );
  async function* sentence(): AsyncGenerator<string> {
    yield "streaming clip";
  }

  const speaking = speaker.speakStream(sentence());
  await spawned.promise;
  await speaker.stop();
  await speaking;

  expect(child.signals).toEqual(["SIGTERM"]);
  expect(fallback.speaks).toEqual([]);
  expect(fallback.stops).toBe(1);
});

test("StreamingTTSSpeaker retries an exact player after an unconfirmed reap", async () => {
  const child = controlledPlayer(205);
  const audioPlayer: AudioPlayer = {
    play: () => Promise.resolve(),
    stopAll: () => Promise.resolve(),
  };
  const provider: TTSProvider = {
    name: "fixture",
    health: () => Promise.resolve(true),
    generateAudio: () => Promise.resolve(wav),
  };
  const speaker = new StreamingTTSSpeaker(provider, audioPlayer, fallbackSpeaker());
  const releaseState = speaker as unknown as {
    unreleasedPlayers: Set<AudioPlayerProcess>;
    playerReleaseFailure: Error | null;
  };
  // Model a prior bounded termination attempt that timed out just before the
  // child became observable. A fresh stop must retry this exact process.
  releaseState.unreleasedPlayers.add(child);
  releaseState.playerReleaseFailure = new Error("first reap was unconfirmed");

  await expect(speaker.stop()).resolves.toBeUndefined();
  expect(child.signals).toEqual(["SIGTERM"]);
  expect(releaseState.unreleasedPlayers.size).toBe(0);
  expect(releaseState.playerReleaseFailure).toBeNull();
});

test("streaming barge-in blocks replacement playback until the old player is reaped", async () => {
  const oldPlayer = controlledPlayer(203, false);
  const replacementPlayer = controlledPlayer(204);
  const firstSpawn = deferred<void>();
  const secondSpawn = deferred<void>();
  let spawns = 0;
  const audioPlayer: AudioPlayer = {
    play: () => Promise.resolve(),
    stopAll: () => Promise.resolve(),
  };
  const provider: TTSProvider = {
    name: "fixture",
    health: () => Promise.resolve(true),
    generateAudio: () => Promise.resolve(wav),
  };
  const speaker = new StreamingTTSSpeaker(
    provider,
    audioPlayer,
    fallbackSpeaker(),
    null,
    () => {
      spawns += 1;
      if (spawns === 1) {
        firstSpawn.resolve();
        return oldPlayer;
      }
      secondSpawn.resolve();
      queueMicrotask(() => replacementPlayer.finish(0));
      return replacementPlayer;
    },
  );
  async function* sentence(text: string): AsyncGenerator<string> {
    yield text;
  }

  const oldTurn = speaker.speakStream(sentence("old turn"));
  await firstSpawn.promise;
  speaker.interrupt();
  const replacementTurn = speaker.speakStream(sentence("replacement turn"));

  await Bun.sleep(10);
  expect(spawns).toBe(1);
  expect(oldPlayer.signals).toEqual(["SIGTERM"]);

  oldPlayer.finish(143);
  await secondSpawn.promise;
  await Promise.all([oldTurn, replacementTurn]);
  expect(spawns).toBe(2);
});

test("TTSSpeaker never retries a system fallback that already failed", async () => {
  let fallbackCalls = 0;
  const provider: TTSProvider = {
    name: "offline",
    health: () => Promise.resolve(false),
    generateAudio: () => { throw new Error("must not generate"); },
  };
  const audioPlayer: AudioPlayer = {
    play: () => Promise.resolve(),
    stopAll: () => Promise.resolve(),
  };
  const fallback: Speaker = {
    speak: async () => {
      fallbackCalls++;
      throw new Error("system voice failed");
    },
    stop: () => Promise.resolve(),
    health: () => Promise.resolve(true),
  };
  const speaker = new TTSSpeaker(provider, audioPlayer, fallback);

  await expect(speaker.speak("say once")).rejects.toThrow("system voice failed");
  expect(fallbackCalls).toBe(1);
});

test("TTSSpeaker retries and clears an unconfirmed fallback release before primary playback", async () => {
  const releaseFailure = new AudioReleaseUnconfirmedError("system child ownership is uncertain");
  let healthy = false;
  let generations = 0;
  let plays = 0;
  let fallbackStops = 0;
  const provider: TTSProvider = {
    name: "fixture",
    health: () => Promise.resolve(healthy),
    generateAudio: () => {
      generations++;
      return Promise.resolve(wav);
    },
  };
  const audioPlayer: AudioPlayer = {
    play: () => { plays++; return Promise.resolve(); },
    stopAll: () => Promise.resolve(),
  };
  const fallback: Speaker = {
    speak: () => Promise.reject(releaseFailure),
    stop: () => { fallbackStops++; return Promise.resolve(); },
    health: () => Promise.resolve(true),
  };
  const speaker = new TTSSpeaker(provider, audioPlayer, fallback);

  await expect(speaker.speak("fallback fails")).rejects.toBe(releaseFailure);
  healthy = true;
  await expect(speaker.speak("primary recovers")).resolves.toBeUndefined();
  expect(fallbackStops).toBe(1);
  expect(generations).toBe(1);
  expect(plays).toBe(1);
});

test("StreamingTTSSpeaker retries and clears unconfirmed fallback ownership", async () => {
  const releaseFailure = new AudioReleaseUnconfirmedError("system child ownership is uncertain");
  let generationFails = true;
  let playerSpawns = 0;
  let fallbackStops = 0;
  const provider: TTSProvider = {
    name: "fixture",
    health: () => Promise.resolve(true),
    generateAudio: () => generationFails
      ? Promise.reject(new Error("generation failed"))
      : Promise.resolve(wav),
  };
  const audioPlayer: AudioPlayer = {
    play: () => Promise.resolve(),
    stopAll: () => Promise.resolve(),
  };
  const fallback: Speaker = {
    speak: () => Promise.reject(releaseFailure),
    stop: () => { fallbackStops++; return Promise.resolve(); },
    health: () => Promise.resolve(true),
  };
  const speaker = new StreamingTTSSpeaker(
    provider,
    audioPlayer,
    fallback,
    null,
    () => {
      playerSpawns++;
      const child = controlledPlayer(205);
      queueMicrotask(() => child.finish(0));
      return child;
    },
  );
  const sentence = (text: string): AsyncIterable<string> => ({
    async *[Symbol.asyncIterator]() { yield text; },
  });

  await expect(speaker.speakStream(sentence("fallback fails"))).rejects.toBe(releaseFailure);
  generationFails = false;
  await expect(speaker.speakStream(sentence("primary recovers"))).resolves.toBeUndefined();
  expect(fallbackStops).toBe(1);
  expect(playerSpawns).toBe(1);
});

test("TTSSpeaker remains fail-closed until a later cleanup retry succeeds", async () => {
  const releaseFailure = new AudioReleaseUnconfirmedError("system child ownership is uncertain");
  let healthy = false;
  let stopAttempts = 0;
  let generations = 0;
  const provider: TTSProvider = {
    name: "fixture",
    health: () => Promise.resolve(healthy),
    generateAudio: () => { generations++; return Promise.resolve(wav); },
  };
  const audioPlayer: AudioPlayer = {
    play: () => Promise.resolve(),
    stopAll: () => Promise.resolve(),
  };
  const fallback: Speaker = {
    speak: () => Promise.reject(releaseFailure),
    stop: () => {
      stopAttempts++;
      return stopAttempts === 1
        ? Promise.reject(new Error("child still owns audio"))
        : Promise.resolve();
    },
    health: () => Promise.resolve(true),
  };
  const speaker = new TTSSpeaker(provider, audioPlayer, fallback);

  await expect(speaker.speak("fallback fails")).rejects.toBe(releaseFailure);
  healthy = true;
  await expect(speaker.speak("cleanup still uncertain")).rejects.toThrow(
    "one or more speaker outputs did not stop",
  );
  expect(generations).toBe(0);
  await expect(speaker.speak("cleanup finally succeeds")).resolves.toBeUndefined();
  expect(stopAttempts).toBe(2);
  expect(generations).toBe(1);
});

test("a replacement stream waits for live system fallback ownership", async () => {
  const fallbackChild = controlledPlayer(206);
  const fallbackSpawned = deferred<void>();
  const replacementSpawned = deferred<void>();
  let generations = 0;
  let playerSpawns = 0;
  const provider: TTSProvider = {
    name: "fixture",
    health: () => Promise.resolve(true),
    generateAudio: () => {
      generations++;
      return generations === 1
        ? Promise.reject(new Error("generation failed"))
        : Promise.resolve(wav);
    },
  };
  const audioPlayer: AudioPlayer = {
    play: () => Promise.resolve(),
    stopAll: () => Promise.resolve(),
  };
  const fallback = new SystemSpeaker("darwin", () => {
    fallbackSpawned.resolve();
    return { process: fallbackChild };
  });
  const speaker = new StreamingTTSSpeaker(
    provider,
    audioPlayer,
    fallback,
    null,
    () => {
      playerSpawns++;
      replacementSpawned.resolve();
      const child = controlledPlayer(207);
      queueMicrotask(() => child.finish(0));
      return child;
    },
  );
  const sentence = (text: string): AsyncIterable<string> => ({
    async *[Symbol.asyncIterator]() { yield text; },
  });

  const first = speaker.speakStream(sentence("system fallback"));
  await fallbackSpawned.promise;
  const replacement = speaker.speakStream(sentence("replacement"));
  await Bun.sleep(10);
  expect(playerSpawns).toBe(0);

  fallbackChild.finish(0);
  await replacementSpawned.promise;
  await Promise.all([first, replacement]);
  expect(playerSpawns).toBe(1);
});

test("fallback stop failures propagate through both speaker layers", async () => {
  const releaseFailure = new AudioReleaseUnconfirmedError("system stop failed");
  const provider: TTSProvider = {
    name: "fixture",
    health: () => Promise.resolve(true),
    generateAudio: () => Promise.resolve(wav),
  };
  const audioPlayer: AudioPlayer = {
    play: () => Promise.resolve(),
    stopAll: () => Promise.resolve(),
  };
  const failingFallback = (): Speaker => ({
    speak: () => Promise.resolve(),
    stop: () => Promise.reject(releaseFailure),
    health: () => Promise.resolve(true),
  });

  const batch = new TTSSpeaker(provider, audioPlayer, failingFallback());
  const streaming = new StreamingTTSSpeaker(provider, audioPlayer, failingFallback());
  await expect(batch.stop()).rejects.toBeInstanceOf(AggregateError);
  await expect(streaming.stop()).rejects.toBeInstanceOf(AggregateError);
});

test("a synchronous audio-stop failure cannot skip fallback shutdown", async () => {
  let fallbackStops = 0;
  const provider: TTSProvider = {
    name: "fixture",
    health: () => Promise.resolve(true),
    generateAudio: () => Promise.resolve(wav),
  };
  const audioPlayer: AudioPlayer = {
    play: () => Promise.resolve(),
    stopAll: () => { throw new Error("synchronous audio stop failure"); },
  };
  const fallback: Speaker = {
    speak: () => Promise.resolve(),
    stop: () => { fallbackStops++; return Promise.resolve(); },
    health: () => Promise.resolve(true),
  };
  const speaker = new TTSSpeaker(provider, audioPlayer, fallback);

  await expect(speaker.stop()).rejects.toBeInstanceOf(AggregateError);
  expect(fallbackStops).toBe(1);
});

test("fallback stop failure is reported without waiting on its hung speak promise", async () => {
  const fallbackStarted = deferred<void>();
  const releaseFailure = new AudioReleaseUnconfirmedError("fallback child did not reap");
  const provider: TTSProvider = {
    name: "offline",
    health: () => Promise.resolve(false),
    generateAudio: () => Promise.resolve(wav),
  };
  const audioPlayer: AudioPlayer = {
    play: () => Promise.resolve(),
    stopAll: () => Promise.resolve(),
  };
  const fallback: Speaker = {
    speak: () => {
      fallbackStarted.resolve();
      return new Promise<void>(() => { /* intentionally never settles */ });
    },
    stop: () => Promise.reject(releaseFailure),
    health: () => Promise.resolve(true),
  };
  const speaker = new TTSSpeaker(provider, audioPlayer, fallback);

  const speaking = speaker.speak("hung fallback");
  void speaking.catch(() => {});
  await fallbackStarted.promise;
  const queued = speaker.speak("queued behind fallback");
  await expect(settlesWithin(speaker.stop(), "TTSSpeaker stop"))
    .rejects.toBeInstanceOf(AggregateError);
  await settlesWithin(queued, "queued TTSSpeaker speak");
});
