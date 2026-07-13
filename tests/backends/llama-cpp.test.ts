import { test, expect, describe, mock, afterEach } from "bun:test";
import { LlamaCppProvider } from "../../src/backends/llm/llama-cpp";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("LlamaCppProvider", () => {
  test("has correct name", () => {
    const provider = new LlamaCppProvider({ port: 8080 });
    expect(provider.name).toBe("llama-cpp");
  });

  test("chatCompletion posts to OpenAI /v1/chat/completions and honors host", async () => {
    let captured: { url: string; body: { messages: unknown[] } } | null = null;
    globalThis.fetch = mock(async (url: string, init: { body: string }) => {
      captured = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi from gemma" } }] }));
    }) as unknown as typeof fetch;

    const provider = new LlamaCppProvider({ host: "192.168.1.50", port: 8080 });
    const out = await provider.chatCompletion([{ role: "user", content: "hello" }]);

    expect(captured!.url).toBe("http://192.168.1.50:8080/v1/chat/completions");
    expect(captured!.body.messages).toHaveLength(1);
    expect(out).toBe("hi from gemma");
  });

  test("health pings /health and returns true when ok", async () => {
    globalThis.fetch = mock(async (url: string) => {
      if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ok" }));
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;

    const provider = new LlamaCppProvider({ port: 8080 });
    expect(await provider.health()).toBe(true);
  });

  test("health returns false when server is down", async () => {
    const provider = new LlamaCppProvider({ port: 19997 });
    expect(await provider.health()).toBe(false);
  });
});
