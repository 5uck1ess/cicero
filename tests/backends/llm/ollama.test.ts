import { afterAll, expect, test } from "bun:test";
import { OllamaProvider } from "../../../src/backends/llm/ollama";

let lastBody: Record<string, unknown> = {};

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    try {
      lastBody = (await request.json()) as Record<string, unknown>;
      return Response.json({ message: { content: "ready" } });
    } catch (error: unknown) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  },
});

afterAll(() => server.stop(true));

test("Ollama request model uses the same whitespace normalization as doctor", async () => {
  const provider = new OllamaProvider({
    backend: "ollama",
    host: "localhost",
    port: server.port,
    model: "  qwen3.5:0.8b  ",
  });

  expect(await provider.chatCompletion([{ role: "user", content: "hello" }])).toBe("ready");
  expect(lastBody.model).toBe("qwen3.5:0.8b");
});
