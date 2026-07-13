import { test, expect } from "bun:test";
import { StreamingTTSSpeaker } from "../src/speaker/streaming-tts";
import type { TTSProvider } from "../src/backends/tts/provider";
import type { Speaker } from "../src/types";
import type { AudioPlayer } from "../src/platform/audio";
import { AecReleaseUnconfirmedError, type AecAudioHub } from "../src/platform/aec-hub";
import { encodeWav } from "../src/platform/wav";

// Empty-buffer provider → playAudioInterruptible returns immediately (no audio).
const silentProvider: TTSProvider = {
  name: "silent",
  async generateAudio() { return new ArrayBuffer(0); },
  async health() { return true; },
};
const noopPlayer = { async play() {} } as unknown as AudioPlayer;
const noopFallback = { async speak() {}, async health() { return true; }, async stop() {} } as unknown as Speaker;

async function* fromArray(items: string[]): AsyncGenerator<string> {
  for (const i of items) yield i;
}

test("records all sentences as spoken after a full run", async () => {
  const sp = new StreamingTTSSpeaker(silentProvider, noopPlayer, noopFallback);
  await sp.speakStream(fromArray(["First sentence.", "Second sentence.", "Third."]));
  const snap = sp.getSnapshot();
  expect(snap.spoken).toEqual(["First sentence.", "Second sentence.", "Third."]);
  expect(snap.pending).toEqual([]);
});

test("plays the first synthesized sentence before a delayed second sentence arrives", async () => {
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let signalSecondRequested!: () => void;
  const secondRequested = new Promise<void>((resolve) => { signalSecondRequested = resolve; });

  async function* delayedSecond(): AsyncGenerator<string> {
    yield "First.";
    signalSecondRequested();
    await secondGate;
    yield "Second.";
  }

  const wav = encodeWav(new Int16Array([1])).buffer;
  const provider: TTSProvider = {
    name: "instant",
    async generateAudio() { return wav; },
    async health() { return true; },
  };
  const playback: Uint8Array[] = [];
  const hub = {
    isRunning: () => true,
    play(pcm: Uint8Array) { playback.push(pcm); },
  } as unknown as AecAudioHub;
  const sp = new StreamingTTSSpeaker(provider, noopPlayer, noopFallback, hub);

  const speaking = sp.speakStream(delayedSecond());
  await secondRequested;
  await Bun.sleep(0); // let already-resolved synthesis/playback continuations drain
  const playedBeforeSecondArrived = playback.length;

  releaseSecond();
  await speaking;

  expect(playedBeforeSecondArrived).toBe(1);
  expect(playback).toHaveLength(2);
  expect(sp.getSnapshot().spoken).toEqual(["First.", "Second."]);
});

test("speakStream resets spoken history each call", async () => {
  const sp = new StreamingTTSSpeaker(silentProvider, noopPlayer, noopFallback);
  await sp.speakStream(fromArray(["A.", "B."]));
  await sp.speakStream(fromArray(["C."]));
  expect(sp.getSnapshot().spoken).toEqual(["C."]);
});

test("interrupt before any playback leaves spoken empty", () => {
  const sp = new StreamingTTSSpeaker(silentProvider, noopPlayer, noopFallback);
  sp.interrupt();
  expect(sp.getSnapshot().spoken).toEqual([]);
  expect(sp.getSnapshot().pending).toEqual([]);
});

test("barge-in: a new turn after interrupt does not revive the interrupted one", async () => {
  // Regression for the "kept talking after interrupt" overlap: a shared interrupted
  // boolean got reset by the new turn's speakStream, so the old (still-unwinding)
  // turn resumed and both fed the speaker at once. The epoch guard must keep the
  // superseded turn dead forever.
  const sp = new StreamingTTSSpeaker(silentProvider, noopPlayer, noopFallback);
  let release1!: () => void;
  const gate1 = new Promise<void>((r) => { release1 = r; });
  async function* turn1(): AsyncGenerator<string> {
    yield "old-A.";
    await gate1;     // suspend mid-turn, as if playback were in progress
    yield "old-B.";  // must NOT be spoken once a newer turn has taken over
  }
  const p1 = sp.speakStream(turn1());
  await Bun.sleep(10);                                    // turn 1 buffers "old-A." and blocks at the gate
  sp.interrupt();                                         // barge-in halts the current reply
  await sp.speakStream(fromArray(["new-A.", "new-B."]));  // the interrupting utterance's reply
  release1();                                             // turn 1 tries to resume — it must stay dead
  await p1;
  expect(sp.getSnapshot().spoken).toEqual(["new-A.", "new-B."]);
});

test("interrupt in the sentence gap closes the still-live source", async () => {
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let reads = 0;
  let returned = false;
  const iterator: AsyncIterator<string> = {
    next() {
      reads += 1;
      if (reads === 1) return Promise.resolve({ value: "First.", done: false });
      if (reads === 2) {
        return secondGate.then(() => ({ value: "Second.", done: false }));
      }
      return Promise.resolve({ value: undefined, done: true });
    },
    return() {
      returned = true;
      return Promise.resolve({ value: undefined, done: true });
    },
  };
  const source: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => iterator,
  };
  const sp = new StreamingTTSSpeaker(silentProvider, noopPlayer, noopFallback);

  const speaking = sp.speakStream(source);
  const deadline = Date.now() + 1_000;
  while (sp.getSnapshot().spoken.length === 0 && Date.now() < deadline) {
    await Bun.sleep(1);
  }
  expect(sp.getSnapshot().spoken).toEqual(["First."]);

  sp.interrupt();
  releaseSecond();
  await speaking;

  expect(returned).toBe(true);
  expect(sp.getSnapshot().spoken).toEqual(["First."]);
});

test("falls back to the fallback voice when generation fails (no silent drop)", async () => {
  // Provider throws on the second sentence; that sentence must still be voiced.
  let calls = 0;
  const flakyProvider: TTSProvider = {
    name: "flaky",
    async generateAudio() {
      calls++;
      if (calls === 2) throw new Error("generation boom");
      return new ArrayBuffer(0);
    },
    async health() { return true; },
  };
  const spokenByFallback: string[] = [];
  const recordingFallback = {
    async speak(text: string) { spokenByFallback.push(text); },
    async health() { return true; },
    async stop() {},
  } as unknown as Speaker;

  const sp = new StreamingTTSSpeaker(flakyProvider, noopPlayer, recordingFallback);
  await sp.speakStream(fromArray(["First.", "Second.", "Third."]));

  // The failed sentence went to the fallback voice...
  expect(spokenByFallback).toEqual(["Second."]);
  // ...and all three still count as spoken (the response was not dropped).
  expect(sp.getSnapshot().spoken).toEqual(["First.", "Second.", "Third."]);
});

test("falls back when the platform player cannot be spawned", async () => {
  const wav = encodeWav(new Int16Array([1])).buffer;
  const provider: TTSProvider = {
    name: "audio",
    generateAudio: () => Promise.resolve(wav),
    health: () => Promise.resolve(true),
  };
  const spokenByFallback: string[] = [];
  const fallback = {
    speak: (text: string) => { spokenByFallback.push(text); return Promise.resolve(); },
    health: () => Promise.resolve(true),
    stop: () => Promise.resolve(),
  } as unknown as Speaker;
  const sp = new StreamingTTSSpeaker(provider, noopPlayer, fallback, null, () => {
    throw new Error("player missing");
  });

  await sp.speakStream(fromArray(["Still audible."]));

  expect(spokenByFallback).toEqual(["Still audible."]);
  expect(sp.getSnapshot().spoken).toEqual(["Still audible."]);
});

test("falls back only for a sentence whose player exits nonzero", async () => {
  const wav = encodeWav(new Int16Array([1])).buffer;
  const provider: TTSProvider = {
    name: "audio",
    generateAudio: () => Promise.resolve(wav),
    health: () => Promise.resolve(true),
  };
  const spokenByFallback: string[] = [];
  const fallback = {
    speak: (text: string) => { spokenByFallback.push(text); return Promise.resolve(); },
    health: () => Promise.resolve(true),
    stop: () => Promise.resolve(),
  } as unknown as Speaker;
  let players = 0;
  const sp = new StreamingTTSSpeaker(provider, noopPlayer, fallback, null, () => ({
    pid: 301 + players,
    exited: Promise.resolve(++players === 2 ? 7 : 0),
    kill() {},
  }));

  await sp.speakStream(fromArray(["First.", "Second.", "Third."]));

  expect(spokenByFallback).toEqual(["Second."]);
  expect(sp.getSnapshot().spoken).toEqual(["First.", "Second.", "Third."]);
});

test("a configured but stopped AEC hub falls back to the platform player", async () => {
  const wav = encodeWav(new Int16Array([1])).buffer as ArrayBuffer;
  const provider: TTSProvider = {
    name: "audio",
    async generateAudio() { return wav; },
    async health() { return true; },
  };
  let platformPlays = 0;
  let confirmRelease!: () => void;
  const released = new Promise<void>((resolve) => { confirmRelease = resolve; });
  const stoppedHub = {
    isRunning: () => false,
    waitForRelease: () => released,
    play() {},
  } as unknown as AecAudioHub;
  const sp = new StreamingTTSSpeaker(provider, noopPlayer, noopFallback, stoppedHub, () => {
    platformPlays++;
    return { pid: 310, exited: Promise.resolve(0), kill() {} };
  });

  const speaking = sp.speakStream(fromArray(["Still audible."])).catch((error: unknown) => { throw error; });
  await Bun.sleep(0);
  expect(platformPlays).toBe(0);
  confirmRelease();
  await speaking;

  expect(platformPlays).toBe(1);
  expect(sp.getSnapshot().spoken).toEqual(["Still audible."]);
});

test("an unreaped AEC helper blocks platform and fallback playback", async () => {
  try {
    const provider: TTSProvider = {
      name: "audio",
      generateAudio: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
      health: () => Promise.resolve(true),
    };
    let platformPlays = 0;
    let fallbackSpeaks = 0;
    const fallback = {
      speak: () => { fallbackSpeaks++; return Promise.resolve(); },
      health: () => Promise.resolve(true),
      stop: () => Promise.resolve(),
    } as unknown as Speaker;
    const blockedHub = {
      isRunning: () => false,
      waitForRelease: () => Promise.reject(new AecReleaseUnconfirmedError("old helper is unreaped")),
      play() {},
    } as unknown as AecAudioHub;
    const sp = new StreamingTTSSpeaker(provider, noopPlayer, fallback, blockedHub, () => {
      platformPlays++;
      return { pid: 311, exited: Promise.resolve(0), kill() {} };
    });

    await sp.speakStream(fromArray(["Must remain quiet."]));

    expect(platformPlays).toBe(0);
    expect(fallbackSpeaks).toBe(0);
    expect(sp.getSnapshot().spoken).toEqual([]);
  } catch (error: unknown) {
    throw error;
  }
});

test("an unreaped AEC helper also blocks generation-error fallback speech", async () => {
  try {
    const provider: TTSProvider = {
      name: "broken-audio",
      generateAudio: () => Promise.reject(new Error("generation failed")),
      health: () => Promise.resolve(true),
    };
    let fallbackSpeaks = 0;
    const fallback = {
      speak: () => { fallbackSpeaks++; return Promise.resolve(); },
      health: () => Promise.resolve(true),
      stop: () => Promise.resolve(),
    } as unknown as Speaker;
    const blockedHub = {
      isRunning: () => false,
      waitForRelease: () => Promise.reject(new AecReleaseUnconfirmedError("old helper is unreaped")),
      play() {},
    } as unknown as AecAudioHub;
    const sp = new StreamingTTSSpeaker(provider, noopPlayer, fallback, blockedHub);

    await sp.speakStream(fromArray(["No unsafe fallback."]));

    expect(fallbackSpeaks).toBe(0);
    expect(sp.getSnapshot().spoken).toEqual([]);
  } catch (error: unknown) {
    throw error;
  }
});

test("an active AEC helper blocks platform fallback speech", async () => {
  try {
    const provider: TTSProvider = {
      name: "broken-audio",
      generateAudio: () => Promise.reject(new Error("generation failed")),
      health: () => Promise.resolve(true),
    };
    let fallbackSpeaks = 0;
    let releaseWaits = 0;
    const fallback = {
      speak: () => { fallbackSpeaks++; return Promise.resolve(); },
      health: () => Promise.resolve(true),
      stop: () => Promise.resolve(),
    } as unknown as Speaker;
    const runningHub = {
      isRunning: () => true,
      waitForRelease: () => { releaseWaits++; return Promise.resolve(); },
      play() {},
    } as unknown as AecAudioHub;
    const sp = new StreamingTTSSpeaker(provider, noopPlayer, fallback, runningHub);

    await sp.speakStream(fromArray(["No overlapping fallback."]));

    expect(fallbackSpeaks).toBe(0);
    expect(releaseWaits).toBe(0);
    expect(sp.getSnapshot().spoken).toEqual([]);
  } catch (error: unknown) {
    throw error;
  }
});

test("fallback stays blocked when AEC activates during its release wait", async () => {
  try {
    const provider: TTSProvider = {
      name: "broken-audio",
      generateAudio: () => Promise.reject(new Error("generation failed")),
      health: () => Promise.resolve(true),
    };
    let running = false;
    let fallbackSpeaks = 0;
    const fallback = {
      speak: () => { fallbackSpeaks++; return Promise.resolve(); },
      health: () => Promise.resolve(true),
      stop: () => Promise.resolve(),
    } as unknown as Speaker;
    const hub = {
      isRunning: () => running,
      waitForRelease: () => { running = true; return Promise.resolve(); },
      play() {},
    } as unknown as AecAudioHub;
    const sp = new StreamingTTSSpeaker(provider, noopPlayer, fallback, hub);

    await sp.speakStream(fromArray(["No raced fallback."]));

    expect(fallbackSpeaks).toBe(0);
    expect(sp.getSnapshot().spoken).toEqual([]);
  } catch (error: unknown) {
    throw error;
  }
});

test("interrupt during AEC release wait cannot launch stale platform playback", async () => {
  try {
    const provider: TTSProvider = {
      name: "audio",
      generateAudio: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
      health: () => Promise.resolve(true),
    };
    let markWaitStarted!: () => void;
    const waitStarted = new Promise<void>((resolve) => { markWaitStarted = resolve; });
    let confirmRelease!: () => void;
    const released = new Promise<void>((resolve) => { confirmRelease = resolve; });
    let platformPlays = 0;
    const stoppedHub = {
      isRunning: () => false,
      waitForRelease: () => { markWaitStarted(); return released; },
      play() {},
    } as unknown as AecAudioHub;
    const sp = new StreamingTTSSpeaker(provider, noopPlayer, noopFallback, stoppedHub, () => {
      platformPlays++;
      return { pid: 312, exited: Promise.resolve(0), kill() {} };
    });

    const speaking = sp.speakStream(fromArray(["Old sentence."]));
    await waitStarted;
    sp.interrupt();
    confirmRelease();
    await speaking;

    expect(platformPlays).toBe(0);
    expect(sp.getSnapshot().spoken).toEqual([]);
  } catch (error: unknown) {
    throw error;
  }
});

test("interrupt during AEC release wait cannot launch stale fallback speech", async () => {
  try {
    const provider: TTSProvider = {
      name: "broken-audio",
      generateAudio: () => Promise.reject(new Error("generation failed")),
      health: () => Promise.resolve(true),
    };
    let markWaitStarted!: () => void;
    const waitStarted = new Promise<void>((resolve) => { markWaitStarted = resolve; });
    let confirmRelease!: () => void;
    const released = new Promise<void>((resolve) => { confirmRelease = resolve; });
    let fallbackSpeaks = 0;
    const fallback = {
      speak: () => { fallbackSpeaks++; return Promise.resolve(); },
      health: () => Promise.resolve(true),
      stop: () => Promise.resolve(),
    } as unknown as Speaker;
    const stoppedHub = {
      isRunning: () => false,
      waitForRelease: () => { markWaitStarted(); return released; },
      play() {},
    } as unknown as AecAudioHub;
    const sp = new StreamingTTSSpeaker(provider, noopPlayer, fallback, stoppedHub);

    const speaking = sp.speakStream(fromArray(["Old fallback sentence."]));
    await waitStarted;
    sp.interrupt();
    confirmRelease();
    await speaking;

    expect(fallbackSpeaks).toBe(0);
    expect(sp.getSnapshot().spoken).toEqual([]);
  } catch (error: unknown) {
    throw error;
  }
});

test("a stale hub write cannot mutate the replacement turn's pacing clock", async () => {
  let markWriteStarted!: () => void;
  const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let writes = 0;
  const hub = {
    isRunning: () => true,
    play: () => {
      writes++;
      markWriteStarted();
      return writeGate;
    },
  } as unknown as AecAudioHub;
  const speaker = new StreamingTTSSpeaker(silentProvider, noopPlayer, noopFallback, hub) as StreamingTTSSpeaker & {
    epoch: number;
    hubClockStart: number;
    hubWrittenMs: number;
    playViaHub(audio: ArrayBuffer, epoch: number): Promise<void>;
  };
  speaker.epoch = 1;
  speaker.hubClockStart = Date.now();
  speaker.hubWrittenMs = 0;
  const wav = encodeWav(new Int16Array(3_200), 16_000).buffer;
  const oldPlayback = speaker.playViaHub(wav, 1);
  await writeStarted;

  speaker.epoch = 2;
  speaker.hubClockStart = Date.now();
  speaker.hubWrittenMs = 0;
  releaseWrite();
  await oldPlayback;

  expect(writes).toBe(1);
  expect(speaker.hubWrittenMs).toBe(0);
});

test("malformed streaming provider audio is never written or played", async () => {
  const provider: TTSProvider = {
    name: "malformed",
    generateAudio: () => Promise.resolve(new ArrayBuffer(8)),
    health: () => Promise.resolve(true),
  };
  const spokenByFallback: string[] = [];
  const fallback = {
    speak: (text: string) => { spokenByFallback.push(text); return Promise.resolve(); },
    health: () => Promise.resolve(true),
    stop: () => Promise.resolve(),
  } as unknown as Speaker;
  let players = 0;
  const sp = new StreamingTTSSpeaker(provider, noopPlayer, fallback, null, () => {
    players++;
    return { pid: 313, exited: Promise.resolve(0), kill() {} };
  });
  await sp.speakStream(fromArray(["Do not play this."]));
  expect(players).toBe(0);
  expect(spokenByFallback).toEqual(["Do not play this."]);
});
