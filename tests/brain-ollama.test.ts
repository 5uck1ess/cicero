import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { OllamaBrain } from "../src/brain/ollama";

const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = originalFetch; });
// Restore after every test (incl. the last) so the mock never leaks to other
// test files — a left-behind 500-returning fetch breaks unrelated suites.
afterEach(() => { globalThis.fetch = originalFetch; });

test("OllamaBrain posts to /api/chat with model", async () => {
  let captured: { url: string; body: { model: string } } | null = null;
  globalThis.fetch = mock(async (url: string, init: { body: string }) => {
    captured = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ message: { content: "hi from ollama" } }));
  }) as unknown as typeof fetch;

  const brain = new OllamaBrain({ port: 11434, model: "qwen3.5:0.8b" });
  await brain.start();
  const out = await brain.send("hello");

  expect(captured!.url).toContain("/api/chat");
  expect(captured!.body.model).toBe("qwen3.5:0.8b");
  expect(out).toBe("hi from ollama");
});

test("OllamaBrain sends per-invocation systemContext as a system message", async () => {
  let body: { messages: Array<{ role: string; content: string }> } | null = null;
  globalThis.fetch = mock(async (_url: string, init: { body: string }) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ message: { content: "ok" } }));
  }) as unknown as typeof fetch;
  const brain = new OllamaBrain({ systemPrompt: "base" });
  await brain.send("where is it", { systemContext: "briefing delivered" });
  expect(body!.messages.slice(0, 2).map((m) => m.role)).toEqual(["system", "system"]);
  expect(body!.messages[1]!.content).toContain("briefing delivered");
});

test("OllamaBrain composes per-turn cancellation with its provider deadline", async () => {
  let capturedSignal: AbortSignal | null = null;
  globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
    capturedSignal = init?.signal ?? null;
    return await new Promise<Response>((_resolve, reject) => {
      capturedSignal?.addEventListener("abort", () => reject(capturedSignal?.reason), { once: true });
    });
  }) as unknown as typeof fetch;

  const controller = new AbortController();
  const brain = new OllamaBrain({});
  const pending = brain.send("wait", { signal: controller.signal });
  controller.abort(new Error("turn cancelled"));

  await expect(pending).rejects.toThrow("turn cancelled");
  expect(capturedSignal).not.toBe(controller.signal);
  expect(capturedSignal?.aborted).toBe(true);
  expect(capturedSignal?.reason).toBe(controller.signal.reason);
});

test("OllamaBrain health pings /api/tags", async () => {
  globalThis.fetch = mock(async (url: string) => {
    if (url.endsWith("/api/tags")) return new Response("{}");
    return new Response("", { status: 500 });
  }) as unknown as typeof fetch;

  const brain = new OllamaBrain({});
  expect(await brain.health()).toBe(true);
});
