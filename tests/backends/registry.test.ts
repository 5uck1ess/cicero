import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { createProviders } from "../../src/backends/registry";
import { loadConfig as loadConfigRaw } from "../../src/config";

// Isolate from the developer's real ~/.cicero/config.yaml so "by default" assertions
// reflect built-in defaults rather than the current machine's configured backends.
const NO_CONFIG_HOME = join(tmpdir(), "cicero-test-no-config");
const loadConfig = () => loadConfigRaw({}, { home: NO_CONFIG_HOME });

describe("createProviders", () => {
  test("returns MLX providers by default (no config changes)", () => {
    const config = loadConfig();
    const providers = createProviders(config);
    expect(providers.stt.name).toBe("mlx-whisper");
    expect(providers.tts.name).toBe("mlx-audio");
    expect(providers.llm.name).toBe("mlx-lm");
  });

  test("creates Ollama provider when configured", () => {
    const config = loadConfig();
    Object.defineProperty(config, 'llmBackend', {
      get: () => ({ backend: "ollama", port: 11434, model: "qwen3.5:0.8b" }),
    });
    const providers = createProviders(config);
    expect(providers.llm.name).toBe("ollama");
  });

  test("creates llama-cpp provider when configured", () => {
    const config = loadConfig();
    Object.defineProperty(config, 'llmBackend', {
      get: () => ({ backend: "llama-cpp", host: "192.168.1.50", port: 8080 }),
    });
    const providers = createProviders(config);
    expect(providers.llm.name).toBe("llama-cpp");
  });

  test("creates faster-whisper provider when configured", () => {
    const config = loadConfig();
    Object.defineProperty(config, 'sttBackend', {
      get: () => ({ backend: "faster-whisper", port: 8083, model: "test" }),
    });
    const providers = createProviders(config);
    expect(providers.stt.name).toBe("faster-whisper");
  });

  test("wraps the configured STT primary with its hot fallback", () => {
    const config = loadConfig();
    Object.defineProperty(config, "sttBackend", {
      get: () => ({ backend: "faster-whisper", port: 8083, model: "test" }),
    });
    Object.defineProperty(config, "sttFallbackBackend", {
      get: () => ({ backend: "audiocpp", port: 8092, model: "qwen3-asr" }),
    });

    expect(createProviders(config).stt.name).toBe("faster-whisper→audiocpp");
  });

  test("factory rejects an identical effective STT endpoint even for unchecked config stand-ins", () => {
    const config = loadConfig();
    Object.defineProperty(config, "sttBackend", {
      get: () => ({ backend: "faster-whisper", host: "localhost" }),
    });
    Object.defineProperty(config, "sttFallbackBackend", {
      get: () => ({ backend: "faster-whisper", host: "127.0.0.1", port: 8083 }),
    });

    expect(() => createProviders(config)).toThrow("configure a distinct host or port");
  });

  test("factory canonicalizes DNS aliases and equivalent IPv6 spellings before endpoint comparison", () => {
    for (const [primaryHost, fallbackHost] of [
      ["localhost", "LOCALHOST."],
      ["::1", "0:0:0:0:0:0:0:1"],
      ["2001:db8::1", "2001:0db8:0:0:0:0:0:1"],
    ] as const) {
      const config = loadConfig();
      Object.defineProperty(config, "sttBackend", {
        get: () => ({ backend: "faster-whisper", host: primaryHost, port: 8083 }),
      });
      Object.defineProperty(config, "sttFallbackBackend", {
        get: () => ({ backend: "faster-whisper", host: fallbackHost, port: 8083 }),
      });
      expect(() => createProviders(config), `${primaryHost} / ${fallbackHost}`).toThrow(
        "configure a distinct host or port",
      );
    }
  });

  test("factory allows the same STT backend on a distinct endpoint", () => {
    const config = loadConfig();
    Object.defineProperty(config, "sttBackend", {
      get: () => ({ backend: "faster-whisper", host: "gpu-a.internal", port: 8083 }),
    });
    Object.defineProperty(config, "sttFallbackBackend", {
      get: () => ({ backend: "faster-whisper", host: "gpu-b.internal", port: 8083 }),
    });

    expect(createProviders(config).stt.name).toBe("faster-whisper→faster-whisper");
  });

  test("creates Kokoro provider when configured", () => {
    const config = loadConfig();
    Object.defineProperty(config, 'ttsBackend', {
      get: () => ({ backend: "kokoro", port: 8082, voice: "am_onyx" }),
    });
    const providers = createProviders(config);
    expect(providers.tts.name).toBe("kokoro");
  });

  test("creates VibeVoice provider when configured", () => {
    const config = loadConfig();
    Object.defineProperty(config, 'ttsBackend', {
      get: () => ({ backend: "vibevoice", port: 8082 }),
    });
    const providers = createProviders(config);
    expect(providers.tts.name).toBe("vibevoice");
  });

  test("creates Pocket-TTS provider when configured", () => {
    const config = loadConfig();
    Object.defineProperty(config, 'ttsBackend', {
      get: () => ({ backend: "pocket-tts", port: 8082, voice: "anna" }),
    });
    const providers = createProviders(config);
    expect(providers.tts.name).toBe("pocket-tts");
  });

  test("throws for unimplemented backends", () => {
    const config = loadConfig();
    Object.defineProperty(config, 'sttBackend', {
      get: () => ({ backend: "deepgram" }),
    });
    expect(() => createProviders(config)).toThrow("stt.backend='deepgram' is not implemented");
    expect(() => createProviders(config)).toThrow("valid values for stt.backend");
  });

  test("throws for unknown backends instead of silently changing providers", () => {
    const config = loadConfig();
    Object.defineProperty(config, 'sttBackend', {
      get: () => ({ backend: "faster-whispr" }),
    });
    expect(() => createProviders(config)).toThrow("stt.backend='faster-whispr' is unsupported");
    expect(() => createProviders(config)).toThrow("valid values for stt.backend: mlx-whisper, faster-whisper, audiocpp, wyoming");

    const ttsConfig = loadConfig();
    Object.defineProperty(ttsConfig, 'ttsBackend', {
      get: () => ({ backend: "pocket-ttz" }),
    });
    expect(() => createProviders(ttsConfig)).toThrow("tts.backend='pocket-ttz' is unsupported");
    expect(() => createProviders(ttsConfig)).toThrow("valid values for tts.backend");
  });

  test("attributes unsupported fallback values to their exact config keys", () => {
    const sttConfig = loadConfig();
    Object.defineProperty(sttConfig, "sttBackend", {
      get: () => ({ backend: "faster-whisper", host: "gpu-a", port: 8083 }),
    });
    Object.defineProperty(sttConfig, "sttFallbackBackend", {
      get: () => ({ backend: "moonshine" }),
    });
    expect(() => createProviders(sttConfig)).toThrow("stt_fallback.backend='moonshine'");

    const ttsConfig = loadConfig();
    Object.defineProperty(ttsConfig, "ttsFallbackBackend", {
      get: () => ({ backend: "voxtral" }),
    });
    expect(() => createProviders(ttsConfig)).toThrow("tts_fallback.backend='voxtral'");
  });
});
