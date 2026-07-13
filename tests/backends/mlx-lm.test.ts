import { test, expect, describe } from "bun:test";
import { MlxLmProvider } from "../../src/backends/llm/mlx-lm";

describe("MlxLmProvider", () => {
  test("has correct name", () => {
    const provider = new MlxLmProvider({ port: 8081, model: "test-model" });
    expect(provider.name).toBe("mlx-lm");
  });

  test("health returns false when server is down", async () => {
    const provider = new MlxLmProvider({ port: 19998, model: "test-model" });
    const healthy = await provider.health();
    expect(healthy).toBe(false);
  });

  test("chatCompletion throws when server is down", async () => {
    const provider = new MlxLmProvider({ port: 19998, model: "test-model" });
    await expect(
      provider.chatCompletion([{ role: "user", content: "test" }])
    ).rejects.toThrow();
  });
});
