import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLOUD_SPEECH_BACKENDS,
  CLOUD_SPEECH_KEY_VARIABLES,
  checkCloudSpeechKey,
  cloudSpeechApiKey,
  cloudSpeechBackend,
  scrubProviderText,
} from "../../src/backends/cloud-speech";
import { STT_DEFAULT_PORTS } from "../../src/backends/stt/provider";
import { TTS_DEFAULT_PORTS } from "../../src/backends/tts/provider";
import { DeepgramSTTProvider } from "../../src/backends/stt/deepgram";
import { OpenAiTranscribeProvider } from "../../src/backends/stt/openai-transcribe";
import { SonioxTTSProvider } from "../../src/backends/tts/soniox";
import { buildSTTProvider, buildTTSProvider } from "../../src/backends/registry";
import { encodeWav } from "../../src/platform/wav";

const KEY = "synthetic-cloud-speech-key-0042";

interface Call { url: string; init?: RequestInit }
function fetcher(respond: (call: Call) => Response): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init };
      calls.push(call);
      return respond(call);
    }) as typeof fetch,
  };
}

function wavFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "cicero-cloud-stt-"));
  const path = join(dir, "utterance.wav");
  writeFileSync(path, new Uint8Array(encodeWav(new Int16Array(1600), 16_000)));
  return path;
}

afterEach(() => {
  for (const name of CLOUD_SPEECH_KEY_VARIABLES) delete process.env[name];
});

test("cloud speech backends own no local port and each names its key variable", () => {
  for (const entry of CLOUD_SPEECH_BACKENDS) {
    const ports = entry.role === "stt" ? STT_DEFAULT_PORTS : TTS_DEFAULT_PORTS;
    expect(ports[entry.id]).toBeUndefined();
    expect(entry.apiKeyEnv).toMatch(/^[A-Z_]+_API_KEY$/);
    expect(entry.keyProbe.url).toStartWith("https://");
  }
  expect(cloudSpeechBackend("stt_fallback", "soniox")?.role).toBe("stt");
  expect(cloudSpeechBackend("tts", "deepgram")).toBeNull();
  expect(cloudSpeechBackend("llm", "openai")).toBeNull();
  expect(CLOUD_SPEECH_KEY_VARIABLES).toContain("SONIOX_API_KEY");
  expect(new Set(CLOUD_SPEECH_KEY_VARIABLES).size).toBe(CLOUD_SPEECH_KEY_VARIABLES.length);
});

test("a configured key wins over the environment, and the environment is the fallback", () => {
  const soniox = cloudSpeechBackend("stt", "soniox")!;
  expect(cloudSpeechApiKey(soniox, "inline", { SONIOX_API_KEY: "env" })).toBe("inline");
  expect(cloudSpeechApiKey(soniox, undefined, { SONIOX_API_KEY: "env" })).toBe("env");
  expect(cloudSpeechApiKey(soniox, "", {})).toBe("");
});

test("provider text is bounded, stripped of control bytes, and never carries the key", () => {
  const scrubbed = scrubProviderText(`bad key ${KEY}\u001b]52;c;payload\u0007 ${"x".repeat(400)}`, KEY);
  expect(scrubbed).not.toContain(KEY);
  expect(scrubbed).not.toMatch(/[\u0000-\u001f]/);
  expect(scrubbed.length).toBeLessThanOrEqual(201);
  expect(scrubProviderText({ not: "text" }, KEY)).toBe("");
});

test("a key check reads only the status code and names the console on rejection", async () => {
  const deepgram = cloudSpeechBackend("stt", "deepgram")!;
  const ok = fetcher(() => new Response("{}", { status: 200 }));
  expect(await checkCloudSpeechKey(deepgram, KEY, { fetcher: ok.fetch })).toEqual({ ok: true });
  expect(ok.calls[0]!.url).toBe("https://api.deepgram.com/v1/projects");
  expect(new Headers(ok.calls[0]!.init?.headers).get("authorization")).toBe(`Token ${KEY}`);

  const rejected = fetcher(() => new Response(`invalid credentials ${KEY}`, { status: 401 }));
  const result = await checkCloudSpeechKey(deepgram, KEY, { fetcher: rejected.fetch });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(KEY);
  expect(JSON.stringify(result)).toContain("console.deepgram.com");

  const down = (async () => { throw new TypeError("connect ECONNREFUSED"); }) as unknown as typeof fetch;
  expect(await checkCloudSpeechKey(deepgram, KEY, { fetcher: down })).toEqual({ ok: false, reason: "Could not reach api.deepgram.com" });
  expect(await checkCloudSpeechKey(deepgram, "", { fetcher: ok.fetch })).toMatchObject({ ok: false, reason: expect.stringContaining("DEEPGRAM_API_KEY") });
  expect(ok.calls).toHaveLength(1);
});

test("Deepgram posts the WAV body with Token auth, model, language and one keyterm per word", async () => {
  const f = fetcher(() => Response.json({ results: { channels: [{ alternatives: [{ transcript: " turn on the lights " }] }] } }));
  const provider = new DeepgramSTTProvider(
    { backend: "deepgram", apiKey: KEY, language: "en-US", vocabulary: ["Cicero", "audio.cpp"] },
    { fetcher: f.fetch },
  );
  expect(await provider.transcribeResult(wavFile())).toEqual({ kind: "transcript", text: "turn on the lights" });
  const url = new URL(f.calls[0]!.url);
  expect(`${url.origin}${url.pathname}`).toBe("https://api.deepgram.com/v1/listen");
  expect(url.searchParams.get("model")).toBe("nova-3");
  expect(url.searchParams.get("language")).toBe("en-US");
  expect(url.searchParams.getAll("keyterm")).toEqual(["Cicero", "audio.cpp"]);
  const headers = new Headers(f.calls[0]!.init?.headers);
  expect(headers.get("authorization")).toBe(`Token ${KEY}`);
  expect(headers.get("content-type")).toBe("audio/wav");
  expect(f.calls[0]!.init?.body).toBeInstanceOf(Blob);
});

test("cloud STT failures are quiet results, scrubbed of the key, and a missing key never calls out", async () => {
  const f = fetcher(() => new Response(`{"err_msg":"Invalid credentials ${KEY}"}`, { status: 401 }));
  const provider = new DeepgramSTTProvider({ backend: "deepgram", apiKey: KEY }, { fetcher: f.fetch });
  const result = await provider.transcribeResult(wavFile());
  expect(result.kind).toBe("failure");
  expect(JSON.stringify(result)).not.toContain(KEY);
  expect(JSON.stringify(result)).toContain("401");

  const silent = fetcher(() => Response.json({ results: { channels: [{ alternatives: [{ transcript: "" }] }] } }));
  expect(await new DeepgramSTTProvider({ backend: "deepgram", apiKey: KEY }, { fetcher: silent.fetch }).transcribeResult(wavFile()))
    .toEqual({ kind: "empty" });

  const none = fetcher(() => new Response("{}"));
  const unkeyed = new DeepgramSTTProvider({ backend: "deepgram" }, { fetcher: none.fetch, env: {} });
  expect(await unkeyed.transcribeResult(wavFile())).toMatchObject({ kind: "failure", reason: expect.stringContaining("DEEPGRAM_API_KEY") });
  expect(none.calls).toHaveLength(0);
});

test("OpenAI-shaped transcription targets each provider and sends prompt only where it is accepted", async () => {
  for (const [backend, url, prompt] of [
    ["openai", "https://api.openai.com/v1/audio/transcriptions", true],
    ["groq", "https://api.groq.com/openai/v1/audio/transcriptions", true],
    ["mistral", "https://api.mistral.ai/v1/audio/transcriptions", false],
  ] as const) {
    const f = fetcher(() => Response.json({ text: "hello there" }));
    const provider = new OpenAiTranscribeProvider(backend, { backend, apiKey: KEY, language: "en-GB", vocabulary: ["Cicero"] }, { fetcher: f.fetch });
    expect(await provider.transcribeResult(wavFile())).toEqual({ kind: "transcript", text: "hello there" });
    expect(f.calls[0]!.url).toBe(url);
    expect(new Headers(f.calls[0]!.init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    const form = f.calls[0]!.init?.body as FormData;
    expect(form.get("model")).toBe(cloudSpeechBackend("stt", backend)!.defaultModel);
    expect(form.get("language")).toBe("en");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(form.has("prompt")).toBe(prompt);
    expect(form.has("response_format")).toBe(backend !== "mistral");
  }
});

test("Soniox TTS posts one sentence and wraps 24 kHz PCM into a WAV", async () => {
  const f = fetcher(() => new Response(new Uint8Array([1, 0, 2, 0, 9])));
  const provider = new SonioxTTSProvider({ backend: "soniox", apiKey: KEY, language: "uk-UA" }, { fetcher: f.fetch });
  const wav = new Uint8Array(await provider.generateAudio("Привіт.", undefined, { speed: 2 }));
  expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
  expect(new DataView(wav.buffer).getUint32(24, true)).toBe(24_000);
  expect(wav.byteLength).toBe(44 + 4); // the odd trailing byte is dropped
  expect(f.calls[0]!.url).toBe("https://tts-rt.soniox.com/tts");
  expect(new Headers(f.calls[0]!.init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
  expect(JSON.parse(String(f.calls[0]!.init?.body))).toEqual({
    model: "tts-rt-v2", language: "uk", voice: "Iris", audio_format: "pcm_s16le", sample_rate: 24_000, text: "Привіт.", speed: 1.3,
  });
  await provider.generateAudio("Hi.", "Adrian");
  expect(JSON.parse(String(f.calls[1]!.init?.body)).voice).toBe("Adrian");
});

test("Soniox TTS errors are scrubbed and a missing key never calls out", async () => {
  const f = fetcher(() => new Response(`{"error_message":"bad key ${KEY}"}`, { status: 401 }));
  const error = await new SonioxTTSProvider({ backend: "soniox", apiKey: KEY }, { fetcher: f.fetch }).generateAudio("Hi.").catch((e: Error) => e);
  expect(String(error)).toContain("401");
  expect(String(error)).not.toContain(KEY);
  const none = fetcher(() => new Response(new Uint8Array([0, 0])));
  await expect(new SonioxTTSProvider({ backend: "soniox" }, { fetcher: none.fetch, env: {} }).generateAudio("Hi.")).rejects.toThrow("SONIOX_API_KEY");
  expect(none.calls).toHaveLength(0);
});

test("the registry builds every cloud backend without starting anything", () => {
  for (const backend of ["soniox", "deepgram", "openai", "groq", "mistral"]) {
    expect(buildSTTProvider({ backend, apiKey: KEY }, "stt.backend").name).toBe(backend);
  }
  expect(buildTTSProvider({ backend: "soniox", apiKey: KEY }, "tts.backend").name).toBe("soniox");
  expect(buildSTTProvider({ backend: "soniox", apiKey: KEY }, "stt.backend").openStream).toBeFunction();
  expect(buildSTTProvider({ backend: "soniox", apiKey: KEY, streaming: false }, "stt.backend").openStream).toBeUndefined();
  expect(buildSTTProvider({ backend: "deepgram", apiKey: KEY }, "stt.backend").openStream).toBeUndefined();
});
