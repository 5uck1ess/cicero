import { test, expect, afterEach } from "bun:test";
import { OpenAiCompatibleBrain } from "../src/brain/openai-compatible";

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

function streamFetch(deltas: string[]) {
  const enc = new TextEncoder();
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const d of deltas) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n`));
          c.enqueue(enc.encode("data: [DONE]\n"));
          c.close();
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
}

test("send returns model content from a keyless LAN endpoint (no Authorization)", async () => {
  const calls = captureFetch({ choices: [{ message: { content: "  the answer  " } }] });
  const brain = new OpenAiCompatibleBrain({ backend: "openai-compatible", baseUrl: "http://192.168.1.50:8080/v1", model: "gemma4" });
  expect(await brain.send("hi")).toBe("the answer");
  expect(calls[0].url).toBe("http://192.168.1.50:8080/v1/chat/completions");
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  const sent = JSON.parse(String(calls[0].init.body));
  expect(sent.model).toBe("gemma4");
  expect(sent.max_tokens).toBe(1024); // generous default, not the provider's 100
});

test("max_tokens override is forwarded", async () => {
  const calls = captureFetch({ choices: [{ message: { content: "x" } }] });
  const brain = new OpenAiCompatibleBrain({ backend: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "m" }, 256);
  await brain.send("hi");
  expect(JSON.parse(String(calls[0].init.body)).max_tokens).toBe(256);
});

test("injectContext is prepended as a system message before the user turn", async () => {
  const calls = captureFetch({ choices: [{ message: { content: "ok" } }] });
  const brain = new OpenAiCompatibleBrain({ backend: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "m" });
  brain.injectContext("[cmd] ls\n[out] file.txt");
  await brain.send("what files are here?");
  const sent = JSON.parse(String(calls[0].init.body));
  expect(sent.messages[0].role).toBe("system");
  expect(sent.messages[0].content).toContain("file.txt");
  expect(sent.messages[1]).toEqual({ role: "user", content: "what files are here?" });

  await brain.send("what next?");
  const next = JSON.parse(String(calls[1].init.body));
  expect(next.messages.filter((m: { role: string }) => m.role === "system")).toHaveLength(0);
  expect(next.messages).toEqual([
    { role: "user", content: "what files are here?" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "what next?" },
  ]);
});

test("restart clears injected context", async () => {
  const calls = captureFetch({ choices: [{ message: { content: "ok" } }] });
  const brain = new OpenAiCompatibleBrain({ backend: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "m" });
  brain.injectContext("stale context");
  await brain.restart();
  await brain.send("fresh");
  const sent = JSON.parse(String(calls[0].init.body));
  expect(sent.messages).toEqual([{ role: "user", content: "fresh" }]);
});

test("sendStream yields streamed deltas", async () => {
  streamFetch(["Hel", "lo ", "world"]);
  const brain = new OpenAiCompatibleBrain({ backend: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "m" });
  let out = "";
  for await (const t of brain.sendStream("hi")) out += t;
  expect(out).toBe("Hello world");
});
