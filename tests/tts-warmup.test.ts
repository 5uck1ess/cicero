import { test, expect } from "bun:test";
import { warmupProvider } from "../src/backends/tts/warmup";
import type { TTSProvider } from "../src/backends/tts/provider";

function fakeProvider(overrides: Partial<TTSProvider>): TTSProvider {
  return {
    name: "fake",
    async generateAudio() { return new ArrayBuffer(0); },
    async health() { return true; },
    ...overrides,
  } as TTSProvider;
}

test("warmupProvider calls provider.warmup when present", async () => {
  let called = false;
  const p = fakeProvider({ warmup: async () => { called = true; } });
  await warmupProvider(p);
  expect(called).toBe(true);
});

test("warmupProvider is a no-op when warmup is absent", async () => {
  const p = fakeProvider({});
  await warmupProvider(p); // must not throw
  expect(true).toBe(true);
});

test("warmupProvider swallows warmup errors (best-effort)", async () => {
  const p = fakeProvider({ warmup: async () => { throw new Error("cold"); } });
  await warmupProvider(p); // must not throw
  expect(true).toBe(true);
});
