import { test, expect, describe, afterEach } from "bun:test";
import { MlxAudioProvider } from "../../src/backends/tts/mlx-audio";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("MlxAudioProvider", () => {
  test("has correct name", () => {
    const provider = new MlxAudioProvider({ port: 8082, model: "test-model", voice: "Ryan" });
    expect(provider.name).toBe("mlx-audio");
  });

  test("health returns false when server is down", async () => {
    const provider = new MlxAudioProvider({ port: 19997, model: "test" });
    expect(await provider.health()).toBe(false);
  });

  test("generateAudio throws when server is down", async () => {
    const provider = new MlxAudioProvider({ port: 19997, model: "test" });
    await expect(provider.generateAudio("hello")).rejects.toThrow();
  });

  test("a preset override does not reuse the configured clone reference", async () => {
    let payload: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as typeof fetch;
    const provider = new MlxAudioProvider({
      backend: "mlx-audio",
      voice: "configured-clone",
      refAudio: "/refs/configured.wav",
      refText: "configured transcript",
    });
    await provider.generateAudio("hello", "Ava");
    expect(payload?.voice).toBe("Ava");
    expect(payload?.ref_audio).toBeUndefined();
    expect(payload?.ref_text).toBeUndefined();
  });
});
