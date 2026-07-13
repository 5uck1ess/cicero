import { test, expect, describe } from "bun:test";
import { MlxWhisperProvider } from "../../src/backends/stt/mlx-whisper";

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
});
