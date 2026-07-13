import { test, expect, afterAll } from "bun:test";
import { LlamaCppProvider } from "../../../src/backends/llm/llama-cpp";

let lastBody: Record<string, unknown> = {};

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    lastBody = (await req.json()) as Record<string, unknown>;
    const sse =
      'data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"there."}}]}\n\n' +
      "data: [DONE]\n\n";
    return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
  },
});
afterAll(() => server.stop(true));

test("llama.cpp streaming sends stream:true and parses SSE tokens", async () => {
  const provider = new LlamaCppProvider({
    backend: "llama-cpp",
    host: "localhost",
    port: server.port,
    model: "  local  ",
  });

  const tokens: string[] = [];
  for await (const t of provider.chatCompletionStream!([{ role: "user", content: "hi" }], { max_tokens: 50 })) {
    tokens.push(t);
  }

  expect(tokens.join("")).toBe("Hi there.");
  expect(lastBody.model).toBe("local");
  expect(lastBody.stream).toBe(true);
  expect(lastBody.max_tokens).toBe(50);
});
