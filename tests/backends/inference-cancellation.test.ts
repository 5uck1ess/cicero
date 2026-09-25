import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlink } from "node:fs/promises";
import { AudioCppProvider } from "../../src/backends/tts/audiocpp";
import { AudioCppSTTProvider } from "../../src/backends/stt/audiocpp";
import { KokoroProvider } from "../../src/backends/tts/kokoro";
import { WyomingTTSProvider } from "../../src/backends/tts/wyoming";
import type { WyomingTransport } from "../../src/backends/wyoming/client";
import { FallbackTTSProvider } from "../../src/backends/tts/fallback";
import { FallbackSTTProvider } from "../../src/backends/stt/fallback";
import { StreamingTTSSpeaker } from "../../src/speaker/streaming-tts";
import type { AudioCppReferenceLease } from "../../src/voice/audio-reference";
import type { TTSProvider } from "../../src/backends/tts/provider";
import type { STTProvider } from "../../src/backends/stt/provider";
import type { AudioPlayer } from "../../src/platform/audio";
import type { Speaker } from "../../src/types";

const originalFetch = globalThis.fetch;
const wavPath = join(tmpdir(), `cicero-inference-cancel-${process.pid}.wav`);
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await unlink(wavPath).catch(() => {});
});

test("aborted STT and TTS requests never start HTTP inference", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(); }) as typeof fetch;
  const abort = new AbortController();
  abort.abort(new Error("turn ended"));
  await expect(new AudioCppSTTProvider({ port: 19092 }).transcribe("missing.wav", abort.signal)).rejects.toHaveProperty("name", "AbortError");
  await expect(new AudioCppProvider({ port: 19092 }).generateAudio("hello", undefined, { signal: abort.signal })).rejects.toHaveProperty("name", "AbortError");
  expect(calls).toBe(0);
});

test("aborting audio.cpp STT rejects promptly and the same provider accepts the next request", async () => {
  await Bun.write(wavPath, new Uint8Array([0x52, 0x49, 0x46, 0x46]));
  let started!: () => void;
  const issued = new Promise<void>((resolve) => { started = resolve; });
  let released = false;
  let calls = 0;
  globalThis.fetch = ((_url: unknown, init: RequestInit) => {
    calls++;
    if (calls === 2) return Promise.resolve(Response.json({ text: "next transcript" }));
    started();
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => {
        released = true;
        reject(new DOMException("Request aborted", "AbortError"));
      }, { once: true });
    });
  }) as typeof fetch;
  const abort = new AbortController();
  const stt = new AudioCppSTTProvider({ port: 19092 });
  const pending = stt.transcribe(wavPath, abort.signal);
  await issued;
  abort.abort(new Error("superseded"));
  await expect(pending).rejects.toHaveProperty("name", "AbortError");
  expect(released).toBe(true);
  expect(await stt.transcribe(wavPath)).toBe("next transcript");
  expect(calls).toBe(2);
});

test("aborting audio.cpp TTS rejects promptly and the same provider accepts the next request", async () => {
  let started!: () => void;
  const issued = new Promise<void>((resolve) => { started = resolve; });
  let released = false;
  let calls = 0;
  globalThis.fetch = ((_url: unknown, init: RequestInit) => {
    calls++;
    if (calls === 2) return Promise.resolve(new Response(new Uint8Array([1, 2])));
    started();
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => {
        released = true;
        reject(new DOMException("cancelled", "AbortError"));
      }, { once: true });
    });
  }) as typeof fetch;
  const controller = new AbortController();
  const provider = new AudioCppProvider({ port: 19092 });
  const abandoned = provider.generateAudio("old", undefined, { signal: controller.signal });
  await issued;
  controller.abort(new Error("barge-in"));
  await expect(abandoned).rejects.toHaveProperty("name", "AbortError");
  expect(released).toBe(true);
  expect(new Uint8Array(await provider.generateAudio("recovered"))).toEqual(new Uint8Array([1, 2]));
  expect(calls).toBe(2);
});

test("audio.cpp STT and TTS requests can be in flight concurrently", async () => {
  await Bun.write(wavPath, new Uint8Array([0x52, 0x49, 0x46, 0x46]));
  let sttStarted!: () => void;
  let ttsStarted!: () => void;
  let completeStt!: (response: Response) => void;
  let completeTts!: (response: Response) => void;
  const sttIssued = new Promise<void>((resolve) => { sttStarted = resolve; });
  const ttsIssued = new Promise<void>((resolve) => { ttsStarted = resolve; });
  globalThis.fetch = ((url: string) => {
    if (url.endsWith("/v1/audio/transcriptions")) {
      sttStarted();
      return new Promise<Response>((resolve) => { completeStt = resolve; });
    }
    ttsStarted();
    return new Promise<Response>((resolve) => { completeTts = resolve; });
  }) as typeof fetch;
  const tts = new AudioCppProvider({ port: 19092 }).generateAudio("hello");
  const stt = new AudioCppSTTProvider({ port: 19092 }).transcribe(wavPath);
  await Promise.all([ttsIssued, sttIssued]);
  completeStt(Response.json({ text: "concurrent transcript" }));
  completeTts(new Response(new Uint8Array([1, 2])));
  expect(await stt).toBe("concurrent transcript");
  expect(new Uint8Array(await tts)).toEqual(new Uint8Array([1, 2]));
});

test("audio.cpp releases a reference lease that arrives after abort", async () => {
  let resolveLease!: (lease: AudioCppReferenceLease) => void;
  let released = 0;
  let fetches = 0;
  globalThis.fetch = (async () => { fetches++; return new Response(new Uint8Array([1])); }) as typeof fetch;
  const provider = new AudioCppProvider(
    { refAudio: "/synthetic/reference.wav" },
    () => new Promise<AudioCppReferenceLease>((resolve) => { resolveLease = resolve; }),
  );
  const controller = new AbortController();
  const pending = provider.generateAudio("old turn", undefined, { signal: controller.signal });
  await Promise.resolve();
  controller.abort(new DOMException("turn ended", "AbortError"));
  resolveLease({
    path: "/synthetic/owned-reference.wav",
    sourcePath: "/synthetic/reference.wav",
    sourceFingerprint: "synthetic",
    isCurrent: async () => true,
    release: () => { released++; },
  });
  await expect(pending).rejects.toHaveProperty("name", "AbortError");
  expect(released).toBe(1);
  expect(fetches).toBe(0);
});

test("abort during ordinary HTTP TTS rejects fetch and releases its request", async () => {
  let started!: () => void;
  const issued = new Promise<void>((resolve) => { started = resolve; });
  let released = false;
  globalThis.fetch = ((_url: unknown, init: RequestInit) => {
    started();
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => {
        released = true;
        reject(new DOMException("cancelled", "AbortError"));
      }, { once: true });
    });
  }) as typeof fetch;
  const controller = new AbortController();
  const provider = new KokoroProvider({});
  const pending = provider.generateAudio("hello", undefined, { signal: controller.signal });
  await issued;
  controller.abort(new Error("superseded"));
  await expect(pending).rejects.toThrow();
  expect(released).toBe(true);
});

test("aborting Wyoming synthesis closes its owned transport", async () => {
  let receiving!: () => void;
  const started = new Promise<void>((resolve) => { receiving = resolve; });
  let closes = 0;
  const transport: WyomingTransport = {
    send: async () => {},
    receive: () => { receiving(); return new Promise(() => {}); },
    receiveOfType: async () => { throw new Error("unused"); },
    describe: async () => { throw new Error("unused"); },
    close: () => { closes++; },
  };
  const provider = new WyomingTTSProvider({}, () => transport);
  const controller = new AbortController();
  const pending = provider.generateAudio("hello", undefined, { signal: controller.signal });
  await started;
  controller.abort(new Error("turn ended"));
  await expect(pending).rejects.toThrow("turn ended");
  expect(closes).toBeGreaterThan(0);
});

test("fallback providers forward cancellation and do not try a second engine", async () => {
  const abort = new AbortController();
  let ttsFallback = 0;
  let sttFallback = 0;
  const primaryTts: TTSProvider = {
    name: "primary", health: async () => true,
    generateAudio: async (_text, _voice, options) => {
      expect(options?.signal).toBe(abort.signal);
      abort.abort(new Error("interrupted"));
      throw new Error("request aborted");
    },
  };
  const secondaryTts: TTSProvider = {
    name: "secondary", health: async () => true,
    generateAudio: async () => { ttsFallback++; return new ArrayBuffer(0); },
  };
  await expect(new FallbackTTSProvider(primaryTts, secondaryTts).generateAudio("hello", undefined, { signal: abort.signal })).rejects.toThrow("interrupted");
  expect(ttsFallback).toBe(0);

  const sttAbort = new AbortController();
  const primaryStt: STTProvider = {
    name: "primary", health: async () => true,
    transcribe: async (_file, signal) => {
      expect(signal).toBe(sttAbort.signal);
      sttAbort.abort(new Error("interrupted"));
      throw new Error("request aborted");
    },
  };
  const secondaryStt: STTProvider = {
    name: "secondary", health: async () => true,
    transcribe: async () => { sttFallback++; return "late"; },
  };
  await expect(new FallbackSTTProvider(primaryStt, secondaryStt).transcribe("x.wav", sttAbort.signal)).rejects.toThrow("interrupted");
  expect(sttFallback).toBe(0);
});

test("interrupt aborts the streaming producer and active TTS request before another sentence is synthesized", async () => {
  let started!: () => void;
  const issued = new Promise<void>((resolve) => { started = resolve; });
  const calls: string[] = [];
  const provider: TTSProvider = {
    name: "held", health: async () => true,
    generateAudio: (text, _voice, options) => {
      calls.push(text);
      started();
      return new Promise<ArrayBuffer>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      });
    },
  };
  const fallback = { async speak() {}, async health() { return true; }, async stop() {} } as Speaker;
  const player = { async play() {} } as AudioPlayer;
  const speaker = new StreamingTTSSpeaker(provider, player, fallback);
  const abort = new AbortController();
  async function* sentences() { yield "first"; yield "second"; }
  const speaking = speaker.speakStream(sentences(), abort);
  await issued;
  speaker.interrupt();
  await speaking;
  expect(abort.signal.aborted).toBe(true);
  expect(calls).toEqual(["first"]);
  expect(speaker.getSnapshot().spoken).toEqual([]);
});

test("interrupt ends a stream stalled on its first producer read without coalescing", async () => {
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const provider: TTSProvider = {
    name: "unused", health: async () => true,
    generateAudio: async () => { throw new Error("should not synthesize"); },
  };
  const fallback = { async speak() {}, async health() { return true; }, async stop() {} } as Speaker;
  const speaker = new StreamingTTSSpeaker(provider, { async play() {} } as AudioPlayer, fallback);
  const controller = new AbortController();
  async function* source() {
    started();
    await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
    yield "late";
  }
  const pending = speaker.speakStream(source(), controller);
  await reading;
  speaker.interrupt();
  await pending;
  expect(controller.signal.aborted).toBe(true);
  expect(speaker.getSnapshot().spoken).toEqual([]);
});
