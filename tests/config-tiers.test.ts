import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { TIER_PRESETS } from "../src/backends/tiers";

describe("tier presets", () => {
  test("local-mlx preset has all backends", () => {
    const tier = TIER_PRESETS["local-mlx"];
    expect((tier.stt as Record<string, unknown>).backend).toBe("mlx-whisper");
    expect((tier.tts as Record<string, unknown>).backend).toBe("mlx-audio");
    expect((tier.llm as Record<string, unknown>).backend).toBe("mlx-lm");
  });

  test("local-cuda preset uses CUDA backends", () => {
    const tier = TIER_PRESETS["local-cuda"];
    expect((tier.stt as Record<string, unknown>).backend).toBe("faster-whisper");
    expect((tier.tts as Record<string, unknown>).backend).toBe("kokoro");
    // llama.cpp (streams + resident model) for low back-and-forth latency.
    expect((tier.llm as Record<string, unknown>).backend).toBe("llama-cpp");
    expect(tier.terminal).toBe("auto");
  });

  test("compute presets leave terminal selection platform-neutral", () => {
    expect(TIER_PRESETS["local-mlx"].terminal).toBeUndefined();
    expect(TIER_PRESETS["local-cuda"].terminal).toBe("auto");
    expect(TIER_PRESETS["local-cpu"].terminal).toBe("auto");
  });

  test("local-cuda documentation matches the llama.cpp preset", () => {
    const guide = readFileSync("docs/configuration.md", "utf8");
    const cudaSection = guide.split("### CUDA (`deployment: local-cuda`)")[1]?.split("## Quick intents")[0] ?? "";

    expect(cudaSection).toContain("llama.cpp `llama-server`");
    expect(cudaSection).toContain("backend as `llama-cpp`");
    expect(cudaSection).not.toContain("via Ollama");
    expect((TIER_PRESETS["local-cuda"].llm as Record<string, unknown>).backend).toBe("llama-cpp");
  });
});
