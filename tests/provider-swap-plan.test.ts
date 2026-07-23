import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, RuntimeConfig } from "../src/config";
import { planVoiceProviderSwap } from "../src/daemon";
import type { CiceroConfig } from "../src/types";

function runtimeConfig(change: (raw: CiceroConfig) => void): RuntimeConfig {
  const raw = structuredClone(DEFAULT_CONFIG);
  change(raw);
  return new RuntimeConfig(raw);
}

describe("live provider swap planning", () => {
  test("a same-backend swap preserves effective legacy defaults", async () => {
    const config = runtimeConfig((raw) => {
      raw.stt = undefined;
      raw.servers.stt.model = "legacy-whisper-model";
      raw.servers.stt.port = 18083;
    });

    const plan = await planVoiceProviderSwap(
      config,
      { role: "stt", backend: "mlx-whisper" },
      () => Promise.resolve(28083),
    );

    expect(plan).toEqual({
      selection: { backend: "mlx-whisper", model: "legacy-whisper-model", port: 28083 },
    });
  });

  test("a same-backend model swap preserves endpoint, credentials, voice, and timeouts", async () => {
    const config = runtimeConfig((raw) => {
      raw.tts = {
        backend: "audiocpp",
        host: "gpu.example.test",
        port: 9200,
        model: "old-model",
        voice: "voice-a",
        refAudio: "/voices/reference.wav",
        apiKey: ["synthetic", "value"].join("-"),
        timeout_ms: 42_000,
      };
    });

    const plan = await planVoiceProviderSwap(
      config,
      { role: "tts", backend: "audiocpp", model: "new-model" },
      () => Promise.resolve(9300),
    );

    expect(plan).toEqual({
      selection: {
        backend: "audiocpp",
        host: "gpu.example.test",
        port: 9200,
        model: "new-model",
        voice: "voice-a",
        refAudio: "/voices/reference.wav",
        apiKey: ["synthetic", "value"].join("-"),
        timeout_ms: 42_000,
      },
    });
  });

  test("stages a local candidate away from an endpoint owned by the opposite role", async () => {
    const config = runtimeConfig((raw) => {
      raw.stt = { backend: "audiocpp", port: 8092 };
      raw.tts = { backend: "kokoro", port: 8082 };
    });

    const plan = await planVoiceProviderSwap(
      config,
      { role: "tts", backend: "audiocpp", model: "tts-model" },
      () => Promise.resolve(19302),
    );

    expect(plan).toEqual({ selection: { backend: "audiocpp", model: "tts-model", port: 19302 } });
  });

  test("stages the complete candidate including a managed fallback on isolated ports", async () => {
    const config = runtimeConfig((raw) => {
      raw.stt = { backend: "faster-whisper", port: 8083 };
      raw.stt_fallback = { backend: "audiocpp", port: 8092 };
      raw.tts = { backend: "audiocpp", port: 8092 };
    });
    const ports = [19001, 19002];

    const plan = await planVoiceProviderSwap(
      config,
      { role: "stt", backend: "faster-whisper", model: "new-model" },
      () => Promise.resolve(ports.shift()!),
    );

    expect(plan).toEqual({
      selection: { backend: "faster-whisper", port: 19001, model: "new-model" },
      fallback: { backend: "audiocpp", port: 19002 },
    });
  });
});
