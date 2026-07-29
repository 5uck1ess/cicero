import { afterEach, test, expect, describe } from "bun:test";
import { MlxWhisperProvider } from "../../src/backends/stt/mlx-whisper";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("MlxWhisperProvider", () => {
  test("has correct name", () => {
    const provider = new MlxWhisperProvider({ port: 8083 });
    expect(provider.name).toBe("mlx-whisper");
  });

  test("health returns false when server is down", async () => {
    const provider = new MlxWhisperProvider({ port: 19996 });
    expect(await provider.health()).toBe(false);
  });

  test("transcribe returns null when server is down", async () => {
    const provider = new MlxWhisperProvider({ port: 19996 });
    const result = await provider.transcribe("/tmp/nonexistent.wav");
    expect(result).toBeNull();
  });

  test("warmup rejects when inference fails", async () => {
    globalThis.fetch = (async () => new Response("down", { status: 400 })) as typeof fetch;
    const provider = new MlxWhisperProvider({ port: 19996 });

    await expect(provider.warmup()).rejects.toThrow("Whisper server returned 400");
  });
});
