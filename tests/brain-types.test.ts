import { test, expect } from "bun:test";
import type { BrainConfig } from "../src/types";

test("BrainConfig accepts all five backend values", () => {
  const configs: BrainConfig[] = [
    { backend: "claude-code", mode: "subprocess" },
    { backend: "codex", mode: "subprocess" },
    { backend: "gemini", mode: "subprocess" },
    { backend: "qwen", mode: "subprocess" },
    { backend: "ollama", mode: "subprocess" },
  ];
  expect(configs).toHaveLength(5);
});
