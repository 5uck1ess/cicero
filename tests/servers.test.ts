import { describe, expect, test } from "bun:test";
import {
  ServerManager,
  createBackendStartupPolicies,
  type BackendStartupPolicies,
} from "../src/servers";
import { FallbackTTSProvider } from "../src/backends/tts/fallback";
import type { TTSProvider } from "../src/backends/tts/provider";
import { FallbackSTTProvider } from "../src/backends/stt/fallback";
import type { STTProvider } from "../src/backends/stt/provider";
import { DEFAULT_CONFIG, RuntimeConfig } from "../src/config";

function fakeTts(
  name: string,
  overrides: Partial<TTSProvider> = {},
): TTSProvider {
  return {
    name,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    health: () => Promise.resolve(true),
    generateAudio: () => Promise.resolve(new ArrayBuffer(0)),
    ...overrides,
  };
}

const requiredTts: BackendStartupPolicies = {
  tts: {
    required: true,
    configKey: "tts.backend",
    backend: "kokoro",
    validValues: ["mlx-audio", "kokoro", "wyoming"],
  },
};

describe("ServerManager startup policy", () => {
  test("starts, checks, and stops only providers a mode requested", async () => {
    try {
      const calls: string[] = [];
      const tts = fakeTts("test-tts", {
        start: async () => { calls.push("start"); },
        health: async () => { calls.push("health"); return true; },
        stop: async () => { calls.push("stop"); },
      });
      const manager = new ServerManager();

      await manager.start({ tts });
      await manager.stop({ tts });
      expect(calls).toEqual(["start", "health", "stop"]);
    } catch (error) {
      throw new Error(`partial provider lifecycle test failed: ${errorMessage(error)}`, { cause: error });
    }
  });

  test("fails an explicitly configured primary with actionable key and values", async () => {
    try {
      const manager = new ServerManager();
      const tts = fakeTts("broken-plugin", {
        start: () => Promise.reject(new Error("model weights are missing")),
        health: () => Promise.resolve(false),
      });

      const outcome = await manager.start({ tts }, requiredTts).then(
        () => null,
        (error: unknown) => error,
      );

      expect(outcome).toBeInstanceOf(Error);
      const message = (outcome as Error).message;
      expect(message).toContain("Configured TTS primary tts.backend='kokoro' failed to start");
      expect(message).toContain("model weights are missing");
      expect(message).toContain("Valid values for tts.backend: mlx-audio, kokoro, wyoming");
      expect(message).toContain("cicero doctor");
    } catch (error) {
      throw new Error(`required start failure test failed: ${errorMessage(error)}`, { cause: error });
    }
  });

  test("does not let a healthy fallback hide an unavailable configured primary", async () => {
    try {
      const primary = fakeTts("primary", { health: () => Promise.resolve(false) });
      const fallback = fakeTts("fallback", { health: () => Promise.resolve(true) });
      const provider = new FallbackTTSProvider(primary, fallback);

      expect(await provider.health()).toBe(true);
      await expect(new ServerManager().start({ tts: provider }, requiredTts)).rejects.toThrow(
        "tts.backend='kokoro' failed its health check",
      );
    } catch (error) {
      throw new Error(`TTS fallback masking test failed: ${errorMessage(error)}`, { cause: error });
    }
  });

  test("applies the same configured-primary rule to STT fallback composition", async () => {
    try {
      const primary: STTProvider = {
        name: "primary-stt",
        transcribe: () => Promise.resolve(null),
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        health: () => Promise.resolve(false),
      };
      const fallback: STTProvider = {
        name: "fallback-stt",
        transcribe: () => Promise.resolve("heard"),
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        health: () => Promise.resolve(true),
      };
      const provider = new FallbackSTTProvider(primary, fallback);
      const policies: BackendStartupPolicies = {
        stt: {
          required: true,
          configKey: "stt.backend",
          backend: "faster-whisper",
          validValues: ["mlx-whisper", "faster-whisper", "audiocpp", "wyoming"],
        },
      };

      expect(await provider.health()).toBe(true);
      await expect(new ServerManager().start({ stt: provider }, policies)).rejects.toThrow(
        "stt.backend='faster-whisper' failed its health check",
      );
    } catch (error) {
      throw new Error(`STT fallback masking test failed: ${errorMessage(error)}`, { cause: error });
    }
  });

  test("preserves custom providers without applying the built-in backend allowlist", async () => {
    try {
      const config = new RuntimeConfig({
        ...structuredClone(DEFAULT_CONFIG),
        tts: { backend: "company-speech-plugin" },
      });
      const policies = createBackendStartupPolicies(config, { builtInProviders: false });
      const calls: string[] = [];
      const tts = fakeTts("company-speech-plugin", {
        start: async () => { calls.push("start"); },
        health: async () => { calls.push("health"); return true; },
      });

      expect(policies.tts?.required).toBe(true);
      expect(policies.tts?.validValues).toBeUndefined();
      await new ServerManager().start({ tts }, policies);
      expect(calls).toEqual(["start", "health"]);
    } catch (error) {
      throw new Error(`custom provider policy test failed: ${errorMessage(error)}`, { cause: error });
    }
  });

  test("skips every platform-impossible implicit MLX default without probing it", async () => {
    try {
      const config = new RuntimeConfig(structuredClone(DEFAULT_CONFIG));
      const policies = createBackendStartupPolicies(config, {
        platform: "linux",
        osRelease: "6.8.0",
      });
      const calls: string[] = [];
      const providers = {
        stt: {
          name: "mlx-whisper",
          transcribe: () => Promise.resolve(null),
          start: async () => { calls.push("stt:start"); },
          health: async () => { calls.push("stt:health"); return false; },
        },
        tts: fakeTts("mlx-audio", {
          start: async () => { calls.push("tts:start"); },
          health: async () => { calls.push("tts:health"); return false; },
        }),
        llm: {
          name: "mlx-lm",
          chatCompletion: () => Promise.resolve(""),
          start: async () => { calls.push("llm:start"); },
          health: async () => { calls.push("llm:health"); return false; },
        },
      };

      expect(policies.stt?.skipReason).toContain("implicit stt.backend='mlx-whisper'");
      expect(policies.tts?.skipReason).toContain("valid values for tts.backend");
      expect(policies.llm?.skipReason).toContain("implicit llm.backend='mlx-lm'");
      await new ServerManager().start(providers, policies);
      expect(calls).toEqual([]);
    } catch (error) {
      throw new Error(`implicit MLX skip test failed: ${errorMessage(error)}`, { cause: error });
    }
  });

  test("fails an explicit local MLX primary before invoking it on an unsupported platform", async () => {
    try {
      const config = new RuntimeConfig({
        ...structuredClone(DEFAULT_CONFIG),
        stt: { backend: "mlx-whisper" },
      });
      const policies = createBackendStartupPolicies(config, {
        platform: "linux",
        osRelease: "6.8.0",
      });
      const calls: string[] = [];
      const stt: STTProvider = {
        name: "mlx-whisper",
        transcribe: () => Promise.resolve(null),
        start: async () => { calls.push("start"); },
        health: async () => { calls.push("health"); return true; },
      };

      await expect(new ServerManager().start({ stt }, policies)).rejects.toThrow(
        "stt.backend='mlx-whisper' cannot start on this platform: local MLX requires macOS 14 or newer",
      );
      expect(calls).toEqual([]);
    } catch (error) {
      throw new Error(`explicit MLX platform test failed: ${errorMessage(error)}`, { cause: error });
    }
  });

  test("explains an impossible implicit primary when an explicit fallback keeps startup eligible", () => {
    const config = new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      stt_fallback: {
        backend: "faster-whisper",
        host: "speech.internal",
      },
    });
    const policies = createBackendStartupPolicies(config, {
      platform: "linux",
      osRelease: "6.8.0",
    });

    expect(policies.stt?.skipReason).toBeUndefined();
    expect(policies.stt?.startupNotice).toContain("implicit stt.backend='mlx-whisper'");
    expect(policies.stt?.startupNotice).toContain("stt_fallback remains eligible");
  });

  test("--no-servers validation still rejects an unreachable explicit primary", async () => {
    try {
      const tts = fakeTts("external-kokoro", { health: () => Promise.resolve(false) });

      await expect(
        new ServerManager().verifyRequired({ tts }, requiredTts),
      ).rejects.toThrow("Configured TTS primary tts.backend='kokoro' failed its health check");
    } catch (error) {
      throw new Error(`external provider verification test failed: ${errorMessage(error)}`, { cause: error });
    }
  });
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
