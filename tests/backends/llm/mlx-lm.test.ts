import { test, expect, afterEach } from "bun:test";
import { MlxLmProvider } from "../../../src/backends/llm/mlx-lm";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function captureFetch(responseBody: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response(JSON.stringify(responseBody), { status });
  }) as unknown as typeof fetch;
  return calls;
}

test("merges config.extra into the request body (e.g. disable Qwen3 thinking)", async () => {
  const calls = captureFetch({ choices: [{ message: { content: "ok" } }] });
  const p = new MlxLmProvider({ model: "m", port: 8081, extra: { chat_template_kwargs: { enable_thinking: false } } });
  await p.chatCompletion([{ role: "user", content: "hi" }]);
  const body = JSON.parse(String(calls[0].init.body));
  expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(body.model).toBe("m"); // core fields are not clobbered by extra
});

test("passes response_format through for constrained decoding", async () => {
  const calls = captureFetch({ choices: [{ message: { content: "{}" } }] });
  const p = new MlxLmProvider({ model: "m" });
  await p.chatCompletion([{ role: "user", content: "hi" }], {
    responseFormat: { type: "json_schema", json_schema: { name: "x", schema: {} } },
  });
  expect(JSON.parse(String(calls[0].init.body)).response_format).toEqual({
    type: "json_schema",
    json_schema: { name: "x", schema: {} },
  });
});
