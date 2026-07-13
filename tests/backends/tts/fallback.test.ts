import { test, expect } from "bun:test";
import { FallbackTTSProvider } from "../../../src/backends/tts/fallback";
import type { TTSProvider } from "../../../src/backends/tts/provider";

function fake(name: string, overrides: Partial<TTSProvider> = {}): TTSProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    calls,
    generateAudio: async (text: string) => { calls.push(`gen:${text}`); return new ArrayBuffer(4); },
    health: async () => { calls.push("health"); return true; },
    start: async () => { calls.push("start"); },
    stop: async () => { calls.push("stop"); },
    warmup: async () => { calls.push("warmup"); },
    ...overrides,
  } as TTSProvider & { calls: string[] };
}

test("uses the primary when it succeeds — fallback never generates", async () => {
  const primary = fake("a");
  const fallback = fake("b");
  const p = new FallbackTTSProvider(primary, fallback);
  const audio = await p.generateAudio("hi");
  expect(audio.byteLength).toBe(4);
  expect(primary.calls).toContain("gen:hi");
  expect(fallback.calls).not.toContain("gen:hi");
});

test("falls back on a primary generation failure", async () => {
  const primary = fake("a", { generateAudio: async () => { throw new Error("server died"); } });
  const fallback = fake("b");
  const p = new FallbackTTSProvider(primary, fallback);
  const audio = await p.generateAudio("hi");
  expect(audio.byteLength).toBe(4);
  expect(fallback.calls).toContain("gen:hi");
});

test("propagates when BOTH engines fail a generation", async () => {
  const primary = fake("a", { generateAudio: async () => { throw new Error("a down"); } });
  const fallback = fake("b", { generateAudio: async () => { throw new Error("b down"); } });
  const p = new FallbackTTSProvider(primary, fallback);
  await expect(p.generateAudio("hi")).rejects.toThrow("b down");
});

test("retries a rejected lane voice in the fallback's default voice", async () => {
  const seen: Array<string | undefined> = [];
  const primary = fake("a", { generateAudio: async () => { throw new Error("primary has no voice"); } });
  const fallback = fake("b", {
    generateAudio: async (_text, voice) => {
      seen.push(voice);
      if (voice) throw new Error(`fallback has no voice '${voice}'`);
      return new ArrayBuffer(4);
    },
  });
  const p = new FallbackTTSProvider(primary, fallback);
  const audio = await p.generateAudio("hi", "coder");
  expect(audio.byteLength).toBe(4);
  expect(seen).toEqual(["coder", undefined]);
});

test("health is true if either engine is healthy", async () => {
  const deadPrimary = fake("a", { health: async () => false });
  const fallback = fake("b");
  const p = new FallbackTTSProvider(deadPrimary, fallback);
  expect(await p.health()).toBe(true);

  const deadBoth = new FallbackTTSProvider(
    fake("a", { health: async () => false }),
    fake("b", { health: async () => false }),
  );
  expect(await deadBoth.health()).toBe(false);
});

test("start survives one engine failing, throws when both fail", async () => {
  const primary = fake("a", { start: async () => { throw new Error("no binary"); } });
  const fallback = fake("b");
  const p = new FallbackTTSProvider(primary, fallback);
  await p.start(); // primary down, fallback up — daemon keeps its voice
  expect(fallback.calls).toContain("start");

  const bothDead = new FallbackTTSProvider(
    fake("a", { start: async () => { throw new Error("x"); } }),
    fake("b", { start: async () => { throw new Error("y"); } }),
  );
  await expect(bothDead.start()).rejects.toThrow(/both TTS engines/);
});

test("warmup warms both; stop stops both", async () => {
  const primary = fake("a");
  const fallback = fake("b");
  const p = new FallbackTTSProvider(primary, fallback);
  await p.warmup();
  await p.stop();
  expect(primary.calls).toEqual(expect.arrayContaining(["warmup", "stop"]));
  expect(fallback.calls).toEqual(expect.arrayContaining(["warmup", "stop"]));
});

test("stop attempts both engines and reports every cleanup failure", async () => {
  try {
    const primary = fake("a", { stop: () => Promise.reject(new Error("a reap failed")) });
    const fallback = fake("b", { stop: () => Promise.reject(new Error("b reap failed")) });
    const provider = new FallbackTTSProvider(primary, fallback);

    const outcome = await provider.stop().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(AggregateError);
    expect((outcome as AggregateError).errors.map(String).join(" ")).toContain("a reap failed");
    expect((outcome as AggregateError).errors.map(String).join(" ")).toContain("b reap failed");
  } catch (error: unknown) {
    throw new Error(`fallback cleanup aggregation test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
});
