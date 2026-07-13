import { afterEach, expect, test } from "bun:test";
import {
  DEFAULT_VIBEVOICE_MODEL,
  VIBEVOICE_HEALTH_PATH,
  VibeVoiceProvider,
  vibeVoiceServerCommand,
} from "../../../src/backends/tts/vibevoice";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("uses the pinned upstream VibeVoice API request contract", async () => {
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  globalThis.fetch = (async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 });
  }) as typeof fetch;

  const provider = new VibeVoiceProvider({
    port: 8182,
    model: "vibevoice/VibeVoice-1.5B",
    voice: "butler",
    refAudio: "/voices/butler.wav",
  });
  try {
    await provider.generateAudio("Good evening.");
    expect(requestedUrl).toBe("http://localhost:8182/v1/audio/speech");
    expect(requestedBody).toEqual({
      input: "Good evening.",
      model: "vibevoice/VibeVoice-1.5B",
      voice: "butler",
      response_format: "wav",
      voice_path: "/voices/butler.wav",
    });
  } catch (err: unknown) {
    throw new Error("VibeVoice request-contract test failed", { cause: err });
  }
});

test("uses vibevoice-api's real module, health path, and default model", async () => {
  let healthUrl = "";
  globalThis.fetch = (async (input) => {
    healthUrl = String(input);
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const provider = new VibeVoiceProvider({ port: 8182 });
  try {
    expect(await provider.health()).toBe(true);
    expect(healthUrl).toBe(`http://localhost:8182${VIBEVOICE_HEALTH_PATH}`);
    expect(vibeVoiceServerCommand("/repo/.venv-vibevoice/bin/python", 8182, DEFAULT_VIBEVOICE_MODEL)).toEqual([
      "/repo/.venv-vibevoice/bin/python",
      "-m",
      "vibevoice_api.server",
      "--host",
      "127.0.0.1",
      "--port",
      "8182",
      "--model_path",
      "vibevoice/VibeVoice-1.5B",
    ]);
  } catch (err: unknown) {
    throw new Error("VibeVoice health/launch-contract test failed", { cause: err });
  }
});
