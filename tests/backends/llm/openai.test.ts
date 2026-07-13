import { test, expect, afterEach } from "bun:test";
import {
  OpenAiProvider,
  openAiBaseUrlForDisplay,
} from "../../../src/backends/llm/openai";

const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ["OPENAI_API_KEY", "DEEPSEEK_API_KEY", "DASHSCOPE_API_KEY"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function captureFetch(responseBody: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response(JSON.stringify(responseBody), { status });
  }) as unknown as typeof fetch;
  return calls;
}

test("redacts URL credentials and query material from provider endpoint displays", () => {
  const display = openAiBaseUrlForDisplay(
    "https://doctor-user:password-secret@example.com/v1?api_key=query-secret#fragment-secret",
  );
  expect(display).toBe("https://example.com/v1");
  expect(display).not.toContain("doctor-user");
  expect(display).not.toContain("password-secret");
  expect(display).not.toContain("query-secret");
  expect(display).not.toContain("fragment-secret");
  expect(openAiBaseUrlForDisplay("not a URL malformed-secret")).toBe("<invalid configured URL>");
  expect(openAiBaseUrlForDisplay("mailto:path-secret@example.com")).toBe("<unsupported configured URL>");
});

test("posts to {baseUrl}/chat/completions with Bearer auth and returns the content", async () => {
  const calls = captureFetch({ choices: [{ message: { content: "hello there" } }] });
  const p = new OpenAiProvider({ backend: "openai", apiKey: "sk-test", model: "gpt-4o-mini" });
  const out = await p.chatCompletion([{ role: "user", content: "hi" }]);
  expect(out).toBe("hello there");
  expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  expect(JSON.parse(String(calls[0].init.body)).model).toBe("gpt-4o-mini");
});

test("a Chinese preset resolves base URL + env var (deepseek)", async () => {
  process.env.DEEPSEEK_API_KEY = "sk-ds";
  const calls = captureFetch({ choices: [{ message: { content: "你好" } }] });
  const p = new OpenAiProvider({ backend: "deepseek", model: "deepseek-chat" });
  const out = await p.chatCompletion([{ role: "user", content: "hi" }]);
  expect(out).toBe("你好");
  expect(calls[0].url).toBe("https://api.deepseek.com/v1/chat/completions");
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-ds");
});

test("qwen/dashscope preset targets the Alibaba compatible-mode endpoint", async () => {
  process.env.DASHSCOPE_API_KEY = "sk-qwen";
  const calls = captureFetch({ choices: [{ message: { content: "ok" } }] });
  const p = new OpenAiProvider({ backend: "dashscope", model: "qwen-max" });
  await p.chatCompletion([{ role: "user", content: "hi" }]);
  expect(calls[0].url).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions");
});

test("openai-compatible + explicit baseUrl covers anything not preset (trailing slash trimmed)", async () => {
  const calls = captureFetch({ choices: [{ message: { content: "x" } }] });
  const p = new OpenAiProvider({ backend: "openai-compatible", apiKey: "k", baseUrl: "http://192.168.1.50:8000/v1/" });
  await p.chatCompletion([{ role: "user", content: "hi" }]);
  expect(calls[0].url).toBe("http://192.168.1.50:8000/v1/chat/completions");
});

test("passes response_format through for constrained decoding", async () => {
  const calls = captureFetch({ choices: [{ message: { content: "{}" } }] });
  const p = new OpenAiProvider({ apiKey: "k" });
  await p.chatCompletion([{ role: "user", content: "hi" }], {
    responseFormat: { type: "json_schema", json_schema: { name: "x", schema: {} } },
  });
  expect(JSON.parse(String(calls[0].init.body)).response_format).toEqual({
    type: "json_schema",
    json_schema: { name: "x", schema: {} },
  });
});

test("resolves the API key from the env var when config omits it", async () => {
  process.env.OPENAI_API_KEY = "sk-env";
  const calls = captureFetch({ choices: [{ message: { content: "ok" } }] });
  const p = new OpenAiProvider({ backend: "openai" });
  await p.chatCompletion([{ role: "user", content: "hi" }]);
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-env");
});

test("throws a clear error when no API key is available (cloud endpoint)", async () => {
  delete process.env.OPENAI_API_KEY;
  const p = new OpenAiProvider({ backend: "openai" });
  await expect(p.chatCompletion([{ role: "user", content: "hi" }])).rejects.toThrow(/API key/);
});

test("a local endpoint (LM Studio etc.) needs no key and sends no Authorization header", async () => {
  const calls = captureFetch({ choices: [{ message: { content: "from gemma" } }] });
  const p = new OpenAiProvider({ backend: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "gemma-3" });
  const out = await p.chatCompletion([{ role: "user", content: "hi" }]);
  expect(out).toBe("from gemma");
  expect(calls[0].url).toBe("http://localhost:1234/v1/chat/completions");
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
});

test("a private-LAN endpoint (LAN llama-swap / Hermes) needs no key", async () => {
  // Hermes serves llama-swap at 192.168.1.50:8080 with no auth. 192.168.x is not
  // loopback, but it is a trusted LAN — so no dummy key should be required.
  const calls = captureFetch({ choices: [{ message: { content: "from gemma4" } }] });
  const p = new OpenAiProvider({ backend: "openai-compatible", baseUrl: "http://192.168.1.50:8080/v1", model: "gemma4" });
  const out = await p.chatCompletion([{ role: "user", content: "hi" }]);
  expect(out).toBe("from gemma4");
  expect(calls[0].url).toBe("http://192.168.1.50:8080/v1/chat/completions");
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
});

test("a private-LAN endpoint is healthy on reachability alone, no key", async () => {
  captureFetch({ data: [{ id: "gemma4" }] });
  const p = new OpenAiProvider({ backend: "openai-compatible", baseUrl: "http://10.0.0.7:8080/v1" });
  expect(await p.health()).toBe(true);
});

test("a local endpoint still sends a key if one is provided", async () => {
  const calls = captureFetch({ choices: [{ message: { content: "x" } }] });
  const p = new OpenAiProvider({ backend: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "lm-studio" });
  await p.chatCompletion([{ role: "user", content: "hi" }]);
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer lm-studio");
});

test("health for a local keyless endpoint depends only on reachability", async () => {
  captureFetch({ data: [{ id: "gemma-3" }] });
  const p = new OpenAiProvider({ backend: "openai-compatible", baseUrl: "http://localhost:1234/v1" });
  expect(await p.health()).toBe(true);
});

test("throws on a non-OK response with the status", async () => {
  captureFetch("rate limited", 429);
  const p = new OpenAiProvider({ apiKey: "k" });
  await expect(p.chatCompletion([{ role: "user", content: "hi" }])).rejects.toThrow(/429/);
});

test("sends extraHeaders on chat completions alongside auth (Hermes session id)", async () => {
  const calls = captureFetch({ choices: [{ message: { content: "ok" } }] });
  const p = new OpenAiProvider({
    backend: "openai-compatible",
    baseUrl: "http://192.168.1.50:8642/v1",
    model: "hermes-agent",
    apiKey: "srv-key",
    extraHeaders: { "X-Hermes-Session-Id": "sess-123" },
  });
  await p.chatCompletion([{ role: "user", content: "hi" }]);
  const headers = calls[0].init.headers as Record<string, string>;
  expect(headers["X-Hermes-Session-Id"]).toBe("sess-123");
  expect(headers.Authorization).toBe("Bearer srv-key");
  expect(headers["Content-Type"]).toBe("application/json");
});

test("extraHeaders are also sent on the health probe", async () => {
  const calls = captureFetch({ data: [{ id: "hermes-agent" }] });
  const p = new OpenAiProvider({
    backend: "openai-compatible",
    baseUrl: "http://192.168.1.50:8642/v1",
    extraHeaders: { "X-Hermes-Session-Id": "sess-abc" },
  });
  expect(await p.health()).toBe(true);
  expect((calls[0].init.headers as Record<string, string>)["X-Hermes-Session-Id"]).toBe("sess-abc");
});

test("health is false without a key and true when /models responds ok", async () => {
  delete process.env.OPENAI_API_KEY;
  expect(await new OpenAiProvider({ backend: "openai" }).health()).toBe(false);

  const calls = captureFetch({ data: [] });
  expect(await new OpenAiProvider({ apiKey: "k" }).health()).toBe(true);
  expect(calls[0].url).toBe("https://api.openai.com/v1/models");
});
