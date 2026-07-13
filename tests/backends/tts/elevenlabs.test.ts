import { afterEach, expect, test } from "bun:test";
import { ElevenLabsProvider } from "../../../src/backends/tts/elevenlabs";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ELEVENLABS_API_KEY;
});

function captureFetch(body: BodyInit, status = 200): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(body, { status });
  }) as typeof fetch;
  return calls;
}

test("uses the current ElevenLabs TTS endpoint and wraps 24k PCM as WAV", async () => {
  const calls = captureFetch(new Uint8Array([1, 0, 2, 0]));
  const provider = new ElevenLabsProvider({
    backend: "elevenlabs",
    voice: "voice/id",
    apiKey: "secret-key",
    model: "eleven_flash_v2_5",
  });
  const audio = new Uint8Array(await provider.generateAudio("hello", undefined, { speed: 1.05 }));

  expect(new TextDecoder().decode(audio.slice(0, 4))).toBe("RIFF");
  expect(calls[0].url).toBe(
    "https://api.elevenlabs.io/v1/text-to-speech/voice%2Fid?output_format=pcm_24000",
  );
  expect(new Headers(calls[0].init?.headers).get("xi-api-key")).toBe("secret-key");
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({
    text: "hello",
    model_id: "eleven_flash_v2_5",
    voice_settings: { speed: 1.05 },
  });
});

test("rejects missing credentials and voice IDs before making a network request", async () => {
  const calls = captureFetch(new Uint8Array([1, 0]));
  await expect(
    new ElevenLabsProvider({ backend: "elevenlabs", voice: "voice-id" }).generateAudio("hello"),
  ).rejects.toThrow(/API key/);
  await expect(
    new ElevenLabsProvider({ backend: "elevenlabs", apiKey: "key" }).generateAudio("hello"),
  ).rejects.toThrow(/requires a voice ID/);
  expect(calls).toHaveLength(0);
});

test("reports API errors and rejects empty successful audio", async () => {
  captureFetch("quota exceeded", 429);
  const provider = new ElevenLabsProvider({ backend: "elevenlabs", voice: "id", apiKey: "key" });
  await expect(provider.generateAudio("hello")).rejects.toThrow(/429: quota exceeded/);

  captureFetch(new Uint8Array());
  await expect(provider.generateAudio("hello")).rejects.toThrow(/empty audio/);
});

test("health checks the configured voice without exposing the API key in the URL", async () => {
  const calls = captureFetch("{}");
  const provider = new ElevenLabsProvider({ backend: "elevenlabs", voice: "voice-id", apiKey: "key" });
  expect(await provider.health()).toBe(true);
  expect(calls[0].url).toBe("https://api.elevenlabs.io/v1/voices/voice-id");
  expect(calls[0].url).not.toContain("key");
  expect(new Headers(calls[0].init?.headers).get("xi-api-key")).toBe("key");
});

test("health does not wait for an irrelevant body that refuses cancellation", async () => {
  try {
    globalThis.fetch = (() => Promise.resolve(new Response(new ReadableStream({
      cancel: () => new Promise<void>(() => {}),
    }), { status: 200 }))) as typeof fetch;
    const provider = new ElevenLabsProvider({
      backend: "elevenlabs",
      voice: "voice-id",
      apiKey: "key",
    });
    const started = performance.now();

    expect(await provider.health(25)).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  } catch (error: unknown) {
    throw error instanceof Error ? error : new Error(String(error));
  }
});
