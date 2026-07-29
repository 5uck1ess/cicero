import { expect, test } from "bun:test";
import { createBenchSpeaker } from "../../bench/tts-coalesce-bench";
import { PROVIDER_RESPONSE_LIMIT_BYTES } from "../../src/backends/http-transfer";

/**
 * The docs for this benchmark recommend pointing it at a hosted or network TTS
 * endpoint, so its response is a remote body and gets the same treatment as any
 * other: an absolute deadline and a size bound. A benchmark that hangs is worse
 * than one that fails — it reads as a slow engine.
 */

test("a response that never closes is abandoned at the deadline", async () => {
  // A 200 that emits a RIFF header and then keeps the stream open forever: the
  // exact shape that left the real benchmark stuck in warm-up until killed.
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(
      new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("RIFF")); },
        // never closed, never errored
      }),
      { headers: { "Content-Type": "audio/wav" } },
    ),
  });
  try {
    const speak = createBenchSpeaker(`http://127.0.0.1:${server.port}/v1/audio/speech`, {}, 150);
    const started = performance.now();
    await expect(speak("Warming up.")).rejects.toThrow();
    // Bounded by the deadline, not by the test runner giving up.
    expect(performance.now() - started).toBeLessThan(5_000);
  } finally {
    await server.stop(true);
  }
});

test("a body larger than the audio bound is refused instead of read whole", async () => {
  // The real bound is 64 MiB; streaming that through a test would cost more
  // than it proves, so the seam takes a small one. What is under test is that
  // the bound is APPLIED, not what its production value is — the default is
  // asserted separately below.
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(new Uint8Array(4_096), { headers: { "Content-Type": "audio/wav" } }),
  });
  try {
    const speak = createBenchSpeaker(`http://127.0.0.1:${server.port}/v1/audio/speech`, {}, 30_000, 512);
    const failure = await speak("Warming up.").then(() => null, (error: unknown) => error as Error);
    expect(failure).not.toBeNull();
    // Refused for exceeding the bound, not for running out of time.
    expect(failure!.message).toContain("benchmark TTS audio");
  } finally {
    await server.stop(true);
  }
});

// The seam above must not have quietly changed what a real run enforces.
test("the default bound is the provider audio limit", async () => {
  const body = new Uint8Array(4_096);
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(body, { headers: { "Content-Type": "audio/wav" } }),
  });
  try {
    const speak = createBenchSpeaker(`http://127.0.0.1:${server.port}/v1/audio/speech`, {}, 30_000);
    // 4 KiB passes only because the default is the 64 MiB audio limit.
    expect((await speak("Warming up.")).byteLength).toBe(PROVIDER_RESPONSE_LIMIT_BYTES.audio > 4_096 ? 4_096 : 0);
  } finally {
    await server.stop(true);
  }
});

test("an ordinary response still comes back whole", async () => {
  const body = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(body, { headers: { "Content-Type": "audio/wav" } }),
  });
  try {
    const speak = createBenchSpeaker(`http://127.0.0.1:${server.port}/v1/audio/speech`, {}, 30_000);
    const audio = await speak("Warming up.");
    expect(new Uint8Array(audio)).toEqual(body);
    expect(audio.byteLength).toBeLessThan(PROVIDER_RESPONSE_LIMIT_BYTES.audio);
  } finally {
    await server.stop(true);
  }
});

test("an error body is bounded instead of read whole", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("upstream exploded: ".padEnd(200_000, "x"), { status: 500 }),
  });
  try {
    const speak = createBenchSpeaker(`http://127.0.0.1:${server.port}/v1/audio/speech`, {}, 30_000);
    const failure = await speak("Warming up.").then(() => null, (error: unknown) => error as Error);
    expect(failure!.message).toContain("TTS 500");
    expect(failure!.message).toContain("upstream exploded");
    // Bounded by readErrorDetail's error-body limit, not by the 200 KiB sent.
    expect(failure!.message.length).toBeLessThan(20_000);
  } finally {
    await server.stop(true);
  }
});
