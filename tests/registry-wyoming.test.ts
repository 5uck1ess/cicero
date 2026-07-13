import { test, expect, describe } from "bun:test";
import { createSTTProvider, createTTSProvider } from "../src/backends/registry";
import type { RuntimeConfig } from "../src/config";

// Minimal RuntimeConfig stand-ins — the factories only read sttBackend/ttsBackend.
const sttCfg = (backend: string) =>
  ({ sttBackend: { backend, host: "127.0.0.1", port: 10300 } }) as unknown as RuntimeConfig;
const ttsCfg = (backend: string) =>
  ({ ttsBackend: { backend, host: "127.0.0.1", port: 10200 } }) as unknown as RuntimeConfig;

describe("registry Wyoming wiring", () => {
  test("createSTTProvider returns WyomingSTTProvider for backend 'wyoming'", () => {
    expect(createSTTProvider(sttCfg("wyoming")).name).toBe("wyoming");
  });

  test("createTTSProvider returns WyomingTTSProvider for backend 'wyoming'", () => {
    expect(createTTSProvider(ttsCfg("wyoming")).name).toBe("wyoming");
  });

  test("existing backends still resolve (no regression)", () => {
    expect(createSTTProvider(sttCfg("mlx-whisper")).name).toBe("mlx-whisper");
    expect(createTTSProvider(ttsCfg("kokoro")).name).toBe("kokoro");
  });
});
