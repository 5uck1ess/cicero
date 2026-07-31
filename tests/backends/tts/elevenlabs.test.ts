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

// Round 10 (Codex): health() validates the VOICE (`/voices/{id}`) and model_id is
// first sent on synthesis, so nothing in the readiness gate ever looked at the
// model. `cicero swap tts elevenlabs invalid-model-id` therefore passed the gate,
// persisted to config, and left the newly active provider failing on its first
// real request. warmup() is the gate's model check — a list lookup, so verifying
// a name spends no synthesis credits.
test("warmup rejects a model ElevenLabs does not offer", async () => {
  const calls = captureFetch(JSON.stringify([
    { model_id: "eleven_multilingual_v2" },
    { model_id: "eleven_turbo_v2" },
  ]));
  const provider = new ElevenLabsProvider({
    backend: "elevenlabs",
    voice: "voice/id",
    apiKey: "secret-key",
    model: "invalid-model-id",
  });

  await expect(provider.warmup()).rejects.toThrow(/does not offer model 'invalid-model-id'/);
  expect(calls[0]!.url).toContain("/models");
  // A lookup, never a synthesis: the readiness check must not spend credits.
  expect(calls.every((call) => !call.url.includes("/text-to-speech/"))).toBe(true);
});

test("warmup accepts a model ElevenLabs offers", async () => {
  captureFetch(JSON.stringify([{ model_id: "eleven_multilingual_v2" }]));
  const provider = new ElevenLabsProvider({
    backend: "elevenlabs",
    voice: "voice/id",
    apiKey: "secret-key",
    model: "eleven_multilingual_v2",
  });
  await expect(provider.warmup()).resolves.toBeUndefined();
});

// Round 11 (Codex): the previous version of this test put the hostile content in
// `note`, a field warmup never reads — so it proved nothing about the field that
// IS read. A model_id reaches the terminal log and dashboard history verbatim,
// where an OSC sequence executes as a terminal command instead of printing.
test("warmup never echoes control bytes from a model id", async () => {
  // OSC 52 (clipboard write) is the payload that makes this more than cosmetic.
  const hostile = "\u001b]52;c;SGVsbG8=\u0007";
  captureFetch(JSON.stringify([{ model_id: hostile }, { model_id: "safe-model" }]));
  const provider = new ElevenLabsProvider({
    backend: "elevenlabs",
    voice: "voice/id",
    apiKey: "secret-key",
    model: "missing",
  });

  const failure = await provider.warmup().then(() => null, (error: unknown) => error as Error);
  expect(failure!.message).not.toContain("\u001b");
  expect(failure!.message).not.toContain("\u0007");
  // Still useful: the safe entry is named, and the hostile one is neutralised
  // rather than dropped silently.
  expect(failure!.message).toContain("safe-model");
});

test("warmup bounds an oversized model list instead of retaining it", async () => {
  const many = Array.from({ length: 500 }, (_, index) => ({ model_id: `m${index}-${"x".repeat(400)}` }));
  captureFetch(JSON.stringify(many));
  const provider = new ElevenLabsProvider({
    backend: "elevenlabs",
    voice: "voice/id",
    apiKey: "secret-key",
    model: "missing",
  });

  const failure = await provider.warmup().then(() => null, (error: unknown) => error as Error);
  // The message is logged AND retained in dashboard history, so its size is the
  // thing being bounded — not just its content.
  expect(failure!.message.length).toBeLessThan(2_000);
  expect(failure!.message).toContain("+488 more");
});

// A legitimate match must still work: sanitizing is for display only.
test("a model whose id needs no cleaning still matches exactly", async () => {
  captureFetch(JSON.stringify([{ model_id: "eleven_multilingual_v2" }]));
  const provider = new ElevenLabsProvider({
    backend: "elevenlabs",
    voice: "voice/id",
    apiKey: "secret-key",
    model: "eleven_multilingual_v2",
  });
  await expect(provider.warmup()).resolves.toBeUndefined();
});

// Provider bodies are untrusted: read the one field, never echo the rest.
test("warmup does not surface a hostile model list body", async () => {
  captureFetch(JSON.stringify([{ model_id: "ok", note: "sk-test-NOT-A-REAL-KEY" }]));
  const provider = new ElevenLabsProvider({
    backend: "elevenlabs",
    voice: "voice/id",
    apiKey: "secret-key",
    model: "missing",
  });
  const failure = await provider.warmup().then(() => null, (error: unknown) => error as Error);
  expect(failure!.message).toContain("does not offer model 'missing'");
  expect(failure!.message).not.toContain("NOT-A-REAL-KEY");
});

test("a model list that is not a list is refused, not parsed loosely", async () => {
  captureFetch(JSON.stringify({ models: [] }));
  const provider = new ElevenLabsProvider({
    backend: "elevenlabs",
    voice: "voice/id",
    apiKey: "secret-key",
    model: "eleven_multilingual_v2",
  });
  await expect(provider.warmup()).rejects.toThrow(/was not a list/);
});

// Round 12 (Codex): the model list is REFLECTIVE. This provider sends its key in
// xi-api-key, and an endpoint answering with that key as a model_id had it
// quoted back into the rejection — which travels out through the swap path to
// the operator's terminal and dashboard history. The marker below is synthetic.
test("warmup never quotes the configured api key back out of a model id", async () => {
  const key = ["sk", "synthetic", "secret"].join("-");
  captureFetch(JSON.stringify([{ model_id: key }, { model_id: "safe-model" }]));
  const provider = new ElevenLabsProvider({
    backend: "elevenlabs",
    voice: "voice/id",
    apiKey: key,
    model: "missing",
  });

  const failure = await provider.warmup().then(() => null, (error: unknown) => error as Error);
  expect(failure).not.toBeNull();
  expect(failure!.message).not.toContain(key);
  expect(failure!.message).toContain("<redacted>");
  // The diagnosis survives the redaction.
  expect(failure!.message).toContain("safe-model");
});

// A key embedded in a longer id must not survive by hiding inside it.
test("warmup redacts an api key embedded in a longer model id", async () => {
  const key = ["sk", "synthetic", "secret"].join("-");
  captureFetch(JSON.stringify([{ model_id: `prefix-${key}-suffix` }]));
  const provider = new ElevenLabsProvider({
    backend: "elevenlabs",
    voice: "voice/id",
    apiKey: key,
    model: "missing",
  });

  const failure = await provider.warmup().then(() => null, (error: unknown) => error as Error);
  expect(failure!.message).not.toContain(key);
});
