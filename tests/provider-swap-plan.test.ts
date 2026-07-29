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

// Round 3 (Codex): with `stt: audiocpp:8092` and `tts: audiocpp:8092`, startup
// gives TTS the spawned process and STT a borrower handle on the same port.
// Swapping TTS retired the owner, stopping the process STT was still using —
// STT then reported itself active while pointing at a dead port. Nothing here
// can transfer that ownership, so the swap is refused instead.
describe("a managed server shared by both roles", () => {
  function shared(): RuntimeConfig {
    return runtimeConfig((raw) => {
      raw.stt = { backend: "audiocpp", port: 8092 } as never;
      raw.tts = { backend: "audiocpp", port: 8092 } as never;
    });
  }

  test("swapping either role away is refused, naming the other one", async () => {
    await expect(planVoiceProviderSwap(shared(), { role: "tts", backend: "kokoro" }))
      .rejects.toThrow(/TTS shares one managed audiocpp server with STT/);
    await expect(planVoiceProviderSwap(shared(), { role: "stt", backend: "wyoming" }))
      .rejects.toThrow(/STT shares one managed audiocpp server with TTS/);
  });

  test("the refusal says how to get out of it", async () => {
    const failure = await planVoiceProviderSwap(shared(), { role: "tts", backend: "kokoro" })
      .then(() => null, (error: unknown) => error as Error);
    expect(failure!.message).toMatch(/own port/);
    expect(failure!.message).toMatch(/restarting/);
  });

  // Same backend on DIFFERENT ports is two processes, so neither owns the
  // other's — that swap must still work.
  test("separate ports are not shared, and swap freely", async () => {
    const config = runtimeConfig((raw) => {
      raw.stt = { backend: "audiocpp", port: 8092 } as never;
      raw.tts = { backend: "audiocpp", port: 8093 } as never;
    });
    const plan = await planVoiceProviderSwap(config, { role: "tts", backend: "kokoro" });
    expect(plan.selection.backend).toBe("kokoro");
  });

  // A remote seat is not a process this daemon owns, so there is nothing to
  // stop and nothing to refuse.
  test("a shared REMOTE endpoint is not refused — no local process is owned", async () => {
    const config = runtimeConfig((raw) => {
      raw.stt = { backend: "audiocpp", host: "192.0.2.10", port: 8092 } as never;
      raw.tts = { backend: "audiocpp", host: "192.0.2.10", port: 8092 } as never;
    });
    const plan = await planVoiceProviderSwap(config, { role: "tts", backend: "kokoro" });
    expect(plan.selection.backend).toBe("kokoro");
  });
});
