import { test, expect } from "bun:test";
import { FallbackTTSProvider } from "../../src/backends/tts/fallback";
import type { TTSProvider } from "../../src/backends/tts/provider";

test("fallback substitutes its default when it rejects a lane voice", async () => {
  const calls: Array<string | undefined> = [];
  const primary: TTSProvider = {
    name: "pocket",
    generateAudio: async () => { throw new Error("Pocket-TTS returned 500"); },
    health: async () => true,
  };
  const fallback: TTSProvider = {
    name: "kokoro",
    generateAudio: async (_t: string, voice?: string) => {
      calls.push(voice);
      if (voice) throw new Error("kokoro synthesis failed for voice 'cap': 404");
      return new ArrayBuffer(4);
    },
    health: async () => true,
  };
  const p = new FallbackTTSProvider(primary, fallback);
  const audio = await p.generateAudio("hello", "cap");
  expect(audio.byteLength).toBe(4);
  expect(calls).toEqual(["cap", undefined]);
});
