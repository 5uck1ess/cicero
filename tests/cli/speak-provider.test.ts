import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { DEFAULT_CONFIG, RuntimeConfig } from "../../src/config";
import {
  describeSpeechError,
  preserveSpeechSignalTermination,
  renderConfiguredSpeech,
  SpeechInterruptedError,
} from "../../src/cli/speak";
import { encodeWav } from "../../src/platform/wav";
import type { TTSProvider } from "../../src/backends/tts/provider";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

const realFetch = globalThis.fetch;
const realElevenLabsKey = process.env.ELEVENLABS_API_KEY;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realElevenLabsKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = realElevenLabsKey;
});

function captureProviderRequest(body: BodyInit): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as typeof fetch;
  return calls;
}

function requestBody(call: FetchCall | undefined): Record<string, unknown> {
  if (!call) throw new Error("expected provider request");
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

test("configured speech honors Pocket-TTS remote host and reference overrides", () => {
  const calls = captureProviderRequest(encodeWav(new Int16Array([1])));
  const config = new RuntimeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    tts: {
      backend: "pocket-tts",
      host: "192.0.2.20",
      port: 18082,
      voice: "anna",
      refAudio: "/voices/configured.wav",
    },
  });

  return renderConfiguredSpeech(config, "hello", { refAudio: "/voices/override.wav" }).then((result) => {
    expect(result.providerName).toBe("pocket-tts");
    expect(calls[0]?.url).toBe("http://192.0.2.20:18082/v1/audio/speech");
    expect(requestBody(calls[0]).voice).toBe("/voices/override.wav");
  });
});

test("configured speech uses VibeVoice's native voice_path wire field", () => {
  const calls = captureProviderRequest(encodeWav(new Int16Array([1])));
  const config = new RuntimeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    tts: {
      backend: "vibevoice",
      host: "voice-box.local",
      voice: "operator",
      refAudio: "/voices/operator.wav",
    },
  });

  return renderConfiguredSpeech(config, "status").then(() => {
    expect(calls[0]?.url).toBe("http://voice-box.local:8082/v1/audio/speech");
    const payload = requestBody(calls[0]);
    expect(payload.voice_path).toBe("/voices/operator.wav");
    expect(payload.ref_audio).toBeUndefined();
  });
});

test("configured speech uses ElevenLabs HTTPS, voice encoding, and PCM wrapper", () => {
  process.env.ELEVENLABS_API_KEY = "doctor-secret";
  const calls = captureProviderRequest(new Uint8Array([1, 0, 2, 0]));
  const config = new RuntimeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    tts: {
      backend: "elevenlabs",
      voice: "voice/id with space",
      model: "eleven_turbo_v2_5",
    },
  });

  return renderConfiguredSpeech(config, "cloud hello").then((result) => {
    expect(result.providerName).toBe("elevenlabs");
    expect(result.audio.byteLength).toBeGreaterThan(44);
    expect(calls[0]?.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice%2Fid%20with%20space?output_format=pcm_24000",
    );
    expect(new Headers(calls[0]?.init?.headers).get("xi-api-key")).toBe("doctor-secret");
    expect(requestBody(calls[0]).model_id).toBe("eleven_turbo_v2_5");
  });
});

test("configured speech owns provider startup, render, and cleanup in order", async () => {
  try {
    const events: string[] = [];
    const provider: TTSProvider = {
      name: "lifecycle-fixture",
      start: () => { events.push("start"); return Promise.resolve(); },
      generateAudio: () => { events.push("generate"); return Promise.resolve(encodeWav(new Int16Array([1]))); },
      health: () => Promise.resolve(true),
      stop: () => { events.push("stop"); return Promise.resolve(); },
    };
    const config = new RuntimeConfig(structuredClone(DEFAULT_CONFIG));

    const rendered = await renderConfiguredSpeech(config, "standalone", {
      providerFactory: () => provider,
    });

    expect(rendered.providerName).toBe("lifecycle-fixture");
    expect(events).toEqual(["start", "generate", "stop"]);
  } catch (error: unknown) {
    throw new Error(`configured speech lifecycle test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
});

test("configured speech reports render and cleanup failures without dropping ownership", async () => {
  try {
    const events: string[] = [];
    const provider: TTSProvider = {
      name: "failing-fixture",
      start: () => { events.push("start"); return Promise.resolve(); },
      generateAudio: () => { events.push("generate"); return Promise.reject(new Error("synthesis failed")); },
      health: () => Promise.resolve(true),
      stop: () => { events.push("stop"); return Promise.reject(new Error("child reap failed")); },
    };
    const config = new RuntimeConfig(structuredClone(DEFAULT_CONFIG));

    const outcome = await renderConfiguredSpeech(config, "standalone", {
      providerFactory: () => provider,
    }).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(AggregateError);
    expect(String(outcome)).toContain("render and cleanup failed");
    expect((outcome as AggregateError).errors.map(String).join(" ")).toContain("synthesis failed");
    expect((outcome as AggregateError).errors.map(String).join(" ")).toContain("child reap failed");
    expect(describeSpeechError(outcome)).toContain("synthesis failed");
    expect(describeSpeechError(outcome)).toContain("child reap failed");
    expect(events).toEqual(["start", "generate", "stop"]);
  } catch (error: unknown) {
    throw new Error(`configured speech failure-ownership test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
});

test("SIGINT during startup waits for the exact startup attempt and stops its provider once", async () => {
  const signals = new EventEmitter();
  const startEntered = deferredVoid();
  const startup = deferredVoid();
  const stopEntered = deferredVoid();
  const cleanup = deferredVoid();
  let starts = 0;
  let generates = 0;
  let stops = 0;
  let priorSignals = 0;
  const priorSigint = (): void => { priorSignals += 1; };
  signals.on("SIGINT", priorSigint);
  const provider: TTSProvider = {
    name: "startup-signal-fixture",
    start: () => {
      starts += 1;
      startEntered.resolve();
      return startup.promise;
    },
    generateAudio: () => {
      generates += 1;
      return Promise.resolve(encodeWav(new Int16Array([1])));
    },
    health: () => Promise.resolve(true),
    stop: () => {
      stops += 1;
      stopEntered.resolve();
      return cleanup.promise;
    },
  };
  const config = new RuntimeConfig(structuredClone(DEFAULT_CONFIG));
  let settled = false;
  const observed = renderConfiguredSpeech(config, "standalone", {
    providerFactory: () => provider,
    signalSource: signals,
  }).then(
    (value) => { settled = true; return value; },
    (error: unknown) => { settled = true; return error; },
  );

  try {
    await startEntered.promise;
    expect(starts).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(2);
    expect(signals.listenerCount("SIGTERM")).toBe(1);

    signals.emit("SIGINT");
    signals.emit("SIGINT");
    await Promise.resolve();
    expect(priorSignals).toBe(2);
    expect(signals.listenerCount("SIGINT")).toBe(2);
    expect(stops).toBe(0);
    expect(settled).toBe(false);

    startup.resolve();
    await stopEntered.promise;
    expect(generates).toBe(0);
    expect(stops).toBe(1);
    expect(settled).toBe(false);

    signals.emit("SIGTERM");
    await Promise.resolve();
    expect(stops).toBe(1);

    cleanup.resolve();
    const outcome: unknown = await observed;
    expect(outcome).toBeInstanceOf(SpeechInterruptedError);
    if (!(outcome instanceof SpeechInterruptedError)) throw new Error("expected SpeechInterruptedError");
    expect(outcome.signal).toBe("SIGINT");
    expect(outcome.cleanupError).toBeUndefined();
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  } finally {
    startup.resolve();
    cleanup.resolve();
    signals.removeListener("SIGINT", priorSigint);
  }
});

test("SIGTERM during rendering awaits one failed cleanup and restores handlers", async () => {
  const signals = new EventEmitter();
  const renderStarted = deferredVoid();
  const rendering = deferredVoid();
  let stops = 0;
  const provider: TTSProvider = {
    name: "render-signal-fixture",
    start: () => Promise.resolve(),
    generateAudio: async () => {
      renderStarted.resolve();
      await rendering.promise;
      return encodeWav(new Int16Array([1]));
    },
    health: () => Promise.resolve(true),
    stop: () => {
      stops += 1;
      return Promise.reject(new Error("child reap failed"));
    },
  };
  const config = new RuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const observed = renderConfiguredSpeech(config, "standalone", {
    providerFactory: () => provider,
    signalSource: signals,
  }).catch((error: unknown) => error);

  try {
    await renderStarted.promise;
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    const outcome: unknown = await observed;

    expect(stops).toBe(1);
    expect(outcome).toBeInstanceOf(SpeechInterruptedError);
    if (!(outcome instanceof SpeechInterruptedError)) throw new Error("expected SpeechInterruptedError");
    expect(outcome.signal).toBe("SIGTERM");
    expect(outcome.cleanupError?.message).toContain("child reap failed");
    expect(describeSpeechError(outcome)).toContain("child reap failed");
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  } finally {
    rendering.resolve();
  }
});

test("signal termination is injectable and preserves shell-visible semantics", () => {
  const kills: Array<{ pid: number; signal: string }> = [];
  const target = {
    pid: 4242,
    exitCode: undefined as string | number | null | undefined,
    kill(pid: number, signal: "SIGINT" | "SIGTERM"): boolean {
      kills.push({ pid, signal });
      return true;
    },
  };

  preserveSpeechSignalTermination("SIGTERM", target);

  expect(target.exitCode).toBe(143);
  expect(kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
});
