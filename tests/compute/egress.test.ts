import { expect, test } from "bun:test";
import { isLocalComputeTarget } from "../../src/compute";

test("local and private-LAN compute models stay inside the implicit trust boundary", () => {
  expect(isLocalComputeTarget({ backend: "mlx-lm" })).toBe(true);
  expect(isLocalComputeTarget({})).toBe(true);
  expect(isLocalComputeTarget({ backend: "mlx-ln" })).toBe(true);
  expect(isLocalComputeTarget({ backend: "ollama", host: "127.0.0.1" })).toBe(true);
  expect(isLocalComputeTarget({ backend: "llama-cpp", host: "192.168.1.20" })).toBe(true);
  expect(isLocalComputeTarget({ backend: "openai-compatible", baseUrl: "http://modelbox.local:8080/v1" })).toBe(true);
  expect(isLocalComputeTarget({ backend: "openai", baseUrl: "http://127.0.0.1:8080/v1" })).toBe(true);
});

test("public and ambiguous model targets require explicit cloud-data consent", () => {
  expect(isLocalComputeTarget({ backend: "openai" })).toBe(false);
  expect(isLocalComputeTarget({ backend: "openrouter" })).toBe(false);
  expect(isLocalComputeTarget({ backend: "ollama", host: "models.example.com" })).toBe(false);
  expect(isLocalComputeTarget({ backend: "mlx-ln", host: "models.example.com" })).toBe(false);
  expect(isLocalComputeTarget({ backend: "openai-compatible", baseUrl: "https://api.example.com/v1" })).toBe(false);
  expect(isLocalComputeTarget({ backend: "openai-compatible" })).toBe(false);
  expect(isLocalComputeTarget({ backend: "claude-api" })).toBe(false);
});
