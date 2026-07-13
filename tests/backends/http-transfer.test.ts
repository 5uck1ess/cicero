import { afterEach, expect, test } from "bun:test";
import { OpenAiProvider } from "../../src/backends/llm/openai";
import { FasterWhisperProvider } from "../../src/backends/stt/faster-whisper";
import { KokoroProvider } from "../../src/backends/tts/kokoro";
import { Emotion2vecProvider } from "../../src/backends/ser/emotion2vec";
import { SmartTurnProvider } from "../../src/backends/turn/smart-turn";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import {
  PROVIDER_RESPONSE_LIMIT_BYTES,
  providerSignal,
  readBoundedBytes,
  readBoundedJson,
  readErrorDetail,
  requestTimeout,
  responseIsOk,
  sidecarInferenceTimeoutSeconds,
} from "../../src/backends/http-transfer";
import { HealthChecker } from "../../src/servers/health";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const encoder = new TextEncoder();

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (err: unknown) {
    return err;
  }
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await Promise.resolve(server.stop(true)).catch(() => {
      // Force-closing an intentionally silent response can report AbortError.
    });
  }
});

function serveSilentBody(prefix: string): string {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(prefix));
        },
        cancel() {
          // The client deadline/cancellation closes this deliberately silent body.
        },
      });
      return new Response(body, { headers: { "Content-Type": "application/json" } });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/v1`;
}

test("requestTimeout accepts finite overrides, rejects invalid values, and clamps extremes", () => {
  expect(requestTimeout(123.9, 500)).toBe(123);
  expect(requestTimeout(0.5, 500)).toBe(1);
  expect(requestTimeout(0, 500)).toBe(500);
  expect(requestTimeout(Number.NaN, 500)).toBe(500);
  expect(requestTimeout(Number.POSITIVE_INFINITY, 500)).toBe(500);
  expect(requestTimeout(Number.MAX_SAFE_INTEGER, 500)).toBe(15 * 60 * 1_000);
  expect(requestTimeout(undefined, Number.NaN)).toBe(5_000);
});

test("sidecar inference deadlines preserve response and restart headroom", () => {
  expect(sidecarInferenceTimeoutSeconds(90_000)).toBe(85);
  expect(sidecarInferenceTimeoutSeconds(60_000)).toBe(55);
  expect(sidecarInferenceTimeoutSeconds(10_000)).toBe(9);
  expect(sidecarInferenceTimeoutSeconds(5_000)).toBe(4);
  expect(sidecarInferenceTimeoutSeconds(1)).toBe(0.0005);
});

test("providerSignal preserves earlier caller cancellation", () => {
  const caller = new AbortController();
  const signal = providerSignal(10_000, caller.signal);
  const reason = new Error("barge-in");
  caller.abort(reason);
  expect(signal.aborted).toBe(true);
  expect(signal.reason).toBe(reason);
});

test("bounded readers cancel an oversized body without buffering the remainder", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("0123456789"));
    },
    cancel() {
      cancelled = true;
    },
  }));

  const error = await rejectionOf(readBoundedBytes(response, 4, "test response"));
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/4-byte response limit/);
  expect(cancelled).toBe(true);
});

test("bounded byte reads accept an actual payload exactly at the cap", async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("12"));
      controller.enqueue(encoder.encode("34"));
      controller.close();
    },
  }));

  expect(new TextDecoder().decode(await readBoundedBytes(response, 4, "exact bytes"))).toBe("1234");
});

test("bounded JSON reads accept encoded JSON exactly at the cap", async () => {
  const body = encoder.encode('{"ok":true}');
  const response = new Response(body, {
    headers: { "Content-Length": String(body.byteLength) },
  });

  expect(await readBoundedJson<{ ok: boolean }>(response, body.byteLength, "exact JSON"))
    .toEqual({ ok: true });
});

test("error detail captures only a bounded prefix and cancels the peer", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("0123456789"));
    },
    cancel() {
      cancelled = true;
    },
  }), { status: 500 });

  expect(await readErrorDetail(response, 4)).toBe("0123…");
  expect(cancelled).toBe(true);
});

test("health cleanup cannot be held open by a non-settling body cancellation", async () => {
  let cancellationStarted = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    cancel() {
      cancellationStarted = true;
      return new Promise<void>(() => {});
    },
  }), { status: 200 });

  const settled = await Promise.race([
    responseIsOk(response),
    Bun.sleep(150).then(() => false),
  ]);
  expect(settled).toBe(true);
  expect(cancellationStarted).toBe(true);
});

test("health polling caps its final sleep to the absolute deadline", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      cancel: () => new Promise<void>(() => {}),
    }), { status: 503 }))) as typeof fetch;
    const started = performance.now();

    expect(await new HealthChecker().waitForHealth("http://health.invalid", 25, 200)).toBe(false);
    expect(performance.now() - started).toBeLessThan(150);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("declared provider payloads over the global JSON cap fail before download", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  }), {
    headers: {
      "Content-Length": String(PROVIDER_RESPONSE_LIMIT_BYTES.json + 1),
    },
  });

  const error = await rejectionOf(
    readBoundedBytes(response, PROVIDER_RESPONSE_LIMIT_BYTES.json, "provider JSON response"),
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/response limit/);
  expect(cancelled).toBe(true);
});

test("a silent successful LLM body is stopped by the configured absolute deadline", async () => {
  const baseUrl = serveSilentBody('{"choices":[');
  const provider = new OpenAiProvider({
    backend: "openai-compatible",
    baseUrl,
    timeout_ms: 100,
  });
  const started = performance.now();

  const error = await rejectionOf(
    provider.chatCompletion([{ role: "user", content: "hello" }]),
  );
  expect(error).not.toBeNull();
  expect(performance.now() - started).toBeLessThan(1_000);
});

test("the LLM deadline stays active while an SSE stream is consumed", async () => {
  const baseUrl = serveSilentBody(
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
  );
  const provider = new OpenAiProvider({
    backend: "openai-compatible",
    baseUrl,
    timeout_ms: 150,
  });
  const iterator = provider.chatCompletionStream([
    { role: "user", content: "hello" },
  ])[Symbol.asyncIterator]();

  expect(await iterator.next()).toEqual({ value: "hello", done: false });
  expect(await rejectionOf(iterator.next())).not.toBeNull();
});

test("caller cancellation wins over the provider's longer LLM deadline", async () => {
  const baseUrl = serveSilentBody('{"choices":[');
  const provider = new OpenAiProvider({
    backend: "openai-compatible",
    baseUrl,
    timeout_ms: 10_000,
  });
  const caller = new AbortController();
  const pending = provider.chatCompletion(
    [{ role: "user", content: "hello" }],
    { signal: caller.signal },
  );
  const reason = new Error("caller stopped the turn");
  caller.abort(reason);

  const error = await rejectionOf(pending);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/caller stopped the turn/);
});

test("silent STT, TTS, tone, and turn peers all stop at their configured deadlines", async () => {
  const baseUrl = serveSilentBody("{");
  const port = Number(new URL(baseUrl).port);
  const wavPath = join(tmpdir(), `cicero-provider-deadline-${process.pid}.wav`);
  try {
    await Bun.write(wavPath, encoder.encode("RIFF"));
    const started = performance.now();

    expect(await new FasterWhisperProvider({
      host: "127.0.0.1",
      port,
      timeout_ms: 75,
    }).transcribe(wavPath)).toBeNull();

    expect(await rejectionOf(new KokoroProvider({
      host: "127.0.0.1",
      port,
      timeout_ms: 75,
    }).generateAudio("hello"))).not.toBeNull();

    expect(await new Emotion2vecProvider({
      host: "127.0.0.1",
      port,
      timeout_ms: 75,
    }).classify(new Uint8Array([1, 2, 3]))).toBeNull();

    expect(await new SmartTurnProvider({
      host: "127.0.0.1",
      port,
      timeout_ms: 75,
    }).predict(new Float32Array([0]), 16_000)).toEqual({
      complete: false,
      probability: 0,
    });

    expect(performance.now() - started).toBeLessThan(1_500);
  } finally {
    try {
      unlinkSync(wavPath);
    } catch {
      // Best-effort fixture cleanup.
    }
  }
});
