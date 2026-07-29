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
      // Deliberately NOT the fallback's port: a managed server shared across the
      // two roles is refused outright (see the shared-server describe below).
      raw.tts = { backend: "kokoro", port: 8082 };
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

  // Round 4 (Codex): the guard compared only the two roles' PRIMARY engines. A
  // role owns both of its engines — createTTSProvider wraps primary and fallback
  // into one provider and stopping that wrapper stops both — so a fallback can
  // own the very process the other role is borrowing.
  test("a fallback that owns the shared process is refused too", async () => {
    const config = runtimeConfig((raw) => {
      raw.tts = { backend: "vibevoice", port: 19001 } as never;
      raw.tts_fallback = { backend: "audiocpp", port: 8092 } as never;
      raw.stt = { backend: "audiocpp", port: 8092 } as never;
    });
    await expect(planVoiceProviderSwap(config, { role: "tts", backend: "kokoro" }))
      .rejects.toThrow(/TTS shares one managed audiocpp server with STT/);
  });

  test("the other role's fallback is protected as well as its primary", async () => {
    const config = runtimeConfig((raw) => {
      raw.tts = { backend: "audiocpp", port: 8092 } as never;
      raw.stt = { backend: "faster-whisper", port: 19001 } as never;
      raw.stt_fallback = { backend: "audiocpp", port: 8092 } as never;
    });
    await expect(planVoiceProviderSwap(config, { role: "tts", backend: "kokoro" }))
      .rejects.toThrow(/TTS shares one managed audiocpp server with STT/);
  });

  // Fallbacks on their own ports own their own processes — still swappable.
  test("fallbacks on separate ports do not collide", async () => {
    const config = runtimeConfig((raw) => {
      raw.tts = { backend: "vibevoice", port: 19001 } as never;
      raw.tts_fallback = { backend: "audiocpp", port: 8093 } as never;
      raw.stt = { backend: "audiocpp", port: 8092 } as never;
    });
    const plan = await planVoiceProviderSwap(config, { role: "tts", backend: "kokoro" });
    expect(plan.selection.backend).toBe("kokoro");
  });

  // Round 6 (Codex): the allocator binds a port, reads it, and closes again, so
  // two sequential calls can legitimately return the SAME port — nothing holds
  // it in between. Staging the selection and its fallback onto one endpoint puts
  // two managed servers on one port: STT construction rejects it outright, and
  // TTS starts both engines on it concurrently.
  test("a repeated allocator result is not staged twice", async () => {
    const config = runtimeConfig((raw) => {
      raw.stt = { backend: "faster-whisper", port: 8083 } as never;
      raw.stt_fallback = { backend: "audiocpp", port: 8092 } as never;
    });
    const ports = [19001, 19001, 19002];

    const plan = await planVoiceProviderSwap(
      config,
      { role: "stt", backend: "faster-whisper", model: "new-model" },
      () => Promise.resolve(ports.shift()!),
    );

    expect(plan.selection.port).toBe(19001);
    expect(plan.fallback?.port).toBe(19002);
  });

  test("an allocator that never yields a free port is refused, not staged onto a collision", async () => {
    const config = runtimeConfig((raw) => {
      raw.stt = { backend: "faster-whisper", port: 8083 } as never;
      raw.stt_fallback = { backend: "audiocpp", port: 8092 } as never;
    });

    await expect(planVoiceProviderSwap(
      config,
      { role: "stt", backend: "faster-whisper", model: "new-model" },
      () => Promise.resolve(19001),
    )).rejects.toThrow(/could not stage STT on a free loopback port/);
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

describe("a backend that ignores a configured model", () => {
  // Reporting a model that was never loaded is worse than refusing the swap:
  // it is persisted and returned as active, and the operator has no way to see
  // it did not take. kokoro's launch command has no model argument at all and
  // its sidecar hard-codes hexgrad/Kokoro-82M.
  const fixedModel: Array<["stt" | "tts", string]> = [
    ["tts", "kokoro"],
    ["tts", "pocket-tts"],
    ["tts", "wyoming"],
    ["stt", "wyoming"],
  ];
  for (const [role, backend] of fixedModel) {
    test(`naming a model for the ${backend} ${role} backend is refused, not reported active`, async () => {
      const config = runtimeConfig(() => {});
      await expect(planVoiceProviderSwap(
        config,
        { role, backend, model: "acme/OtherModel" },
        () => Promise.resolve(29_000),
      )).rejects.toThrow(/serves one fixed model/);
    });

    test(`swapping to ${backend} ${role} without a model is still allowed`, async () => {
      const config = runtimeConfig(() => {});
      await expect(planVoiceProviderSwap(
        config,
        { role, backend },
        () => Promise.resolve(29_000),
      )).resolves.toBeDefined();
    });
  }

  // The refusal must not spread to backends that DO select a model.
  test("a backend that selects a model still accepts one", async () => {
    const config = runtimeConfig(() => {});
    const plan = await planVoiceProviderSwap(
      config,
      { role: "stt", backend: "faster-whisper", model: "large-v3-turbo" },
      () => Promise.resolve(29_001),
    );
    expect(plan.selection).toMatchObject({ backend: "faster-whisper", model: "large-v3-turbo" });
  });
});

describe("a cross-backend swap inherits what already configures that backend", () => {
  // `swap tts elevenlabs` built a bare {backend: "elevenlabs"} selection, so the
  // voice ID and key the operator had already configured as the fallback were
  // discarded -- and the provider then failed warmup asking for the voice ID it
  // had just thrown away. The backend was unreachable as a swap target at all,
  // because the command has no way to supply a voice.
  test("a fallback's full configuration is carried into the swap", async () => {
    const apiKey = ["synthetic", "elevenlabs", "key"].join("-");
    const config = runtimeConfig((raw) => {
      raw.tts = { backend: "kokoro" };
      raw.tts_fallback = { backend: "elevenlabs", voice: "voice_123", apiKey };
    });

    const plan = await planVoiceProviderSwap(
      config,
      { role: "tts", backend: "elevenlabs" },
      () => Promise.resolve(29_100),
    );

    expect(plan.selection).toMatchObject({ backend: "elevenlabs", voice: "voice_123", apiKey });
  });

  test("the same holds for STT", async () => {
    const config = runtimeConfig((raw) => {
      raw.stt = { backend: "faster-whisper" };
      raw.stt_fallback = { backend: "audiocpp", host: "gpu.example.test", port: 9200, model: "parakeet" };
    });

    const plan = await planVoiceProviderSwap(
      config,
      { role: "stt", backend: "audiocpp" },
      () => Promise.resolve(29_101),
    );

    expect(plan.selection).toMatchObject({ backend: "audiocpp", host: "gpu.example.test", model: "parakeet" });
  });

  // The role's own selection is the more specific statement about that backend.
  test("the live selection wins over a fallback naming the same backend", async () => {
    const config = runtimeConfig((raw) => {
      raw.tts = { backend: "elevenlabs", voice: "live-voice" };
      raw.tts_fallback = { backend: "elevenlabs", voice: "fallback-voice" };
    });

    const plan = await planVoiceProviderSwap(
      config,
      { role: "tts", backend: "elevenlabs" },
      () => Promise.resolve(29_102),
    );

    expect(plan.selection).toMatchObject({ voice: "live-voice" });
  });

  // An explicit model override still wins over whatever the inherited block named.
  test("a trailing model override beats the inherited model", async () => {
    const config = runtimeConfig((raw) => {
      raw.stt = { backend: "faster-whisper" };
      raw.stt_fallback = { backend: "audiocpp", model: "parakeet" };
    });

    // Inheriting the fallback puts a second audiocpp on its default port, so
    // staging genuinely needs a fresh one — hand out distinct ports like the
    // real allocator rather than the same number every call.
    let next = 29_103;
    const plan = await planVoiceProviderSwap(
      config,
      { role: "stt", backend: "audiocpp", model: "canary" },
      () => Promise.resolve(next++),
    );

    expect(plan.selection).toMatchObject({ backend: "audiocpp", model: "canary" });
  });

  // A backend configured nowhere still swaps -- it just starts from its name.
  test("an unconfigured backend still produces a bare selection", async () => {
    const config = runtimeConfig((raw) => {
      raw.tts = { backend: "kokoro" };
      raw.tts_fallback = undefined;
    });

    const plan = await planVoiceProviderSwap(
      config,
      { role: "tts", backend: "elevenlabs" },
      () => Promise.resolve(29_104),
    );

    expect(plan.selection.backend).toBe("elevenlabs");
  });
});
