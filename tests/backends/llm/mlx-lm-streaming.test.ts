import { test, expect, afterAll } from "bun:test";
import { MlxLmProvider } from "../../../src/backends/llm/mlx-lm";

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

test("streaming forwards extra (enable_thinking) + stream:true and parses tokens", async () => {
  const provider = new MlxLmProvider({
    backend: "mlx-lm",
    host: "localhost",
    port: server.port,
    model: "test-model",
    extra: { chat_template_kwargs: { enable_thinking: false } },
  });

  const tokens: string[] = [];
  for await (const t of provider.chatCompletionStream!([{ role: "user", content: "hi" }], { max_tokens: 50 })) {
    tokens.push(t);
  }

  expect(tokens.join("")).toBe("Hi there.");
  expect(lastBody.stream).toBe(true);
  expect(lastBody.chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(lastBody.model).toBe("test-model");
});
