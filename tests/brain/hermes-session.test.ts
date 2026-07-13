import { test, expect, afterEach } from "bun:test";
import { createBrain } from "../../src/brain";
import type { RuntimeConfig } from "../../src/config";

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

/** Build a minimal RuntimeConfig whose only meaningful part is the brain block. */
function configWithBrain(brain: Record<string, unknown>): RuntimeConfig {
  return { brain } as unknown as RuntimeConfig;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("session_header sends a generated UUID, identical across turns (agent memory)", async () => {
  const calls = captureFetch({ choices: [{ message: { content: "ok" } }] });
  const brain = createBrain(configWithBrain({
    backend: "openai-compatible",
    base_url: "http://192.168.1.50:8642/v1",
    model: "hermes-agent",
    session_header: "X-Hermes-Session-Id",
  }));

  await brain.send("first turn");
  await brain.send("second turn");

  const id1 = (calls[0].init.headers as Record<string, string>)["X-Hermes-Session-Id"];
  const id2 = (calls[1].init.headers as Record<string, string>)["X-Hermes-Session-Id"];
  expect(id1).toMatch(UUID_RE);
  expect(id2).toBe(id1); // one voice session = one stable Hermes thread
});

test("each brain instance gets its own session id", async () => {
  const calls = captureFetch({ choices: [{ message: { content: "ok" } }] });
  const mk = () => createBrain(configWithBrain({
    backend: "openai-compatible",
    base_url: "http://192.168.1.50:8642/v1",
    model: "hermes-agent",
    session_header: "X-Hermes-Session-Id",
  }));
  await mk().send("a");
  await mk().send("b");
  const id1 = (calls[0].init.headers as Record<string, string>)["X-Hermes-Session-Id"];
  const id2 = (calls[1].init.headers as Record<string, string>)["X-Hermes-Session-Id"];
  expect(id1).not.toBe(id2);
});

test("static headers pass through and no session header is sent when unset", async () => {
  const calls = captureFetch({ choices: [{ message: { content: "ok" } }] });
  const brain = createBrain(configWithBrain({
    backend: "openai-compatible",
    base_url: "http://192.168.1.50:8642/v1",
    model: "hermes-agent",
    headers: { "X-Hermes-Session-Key": "ops-prod" },
  }));
  await brain.send("hi");
  const headers = calls[0].init.headers as Record<string, string>;
  expect(headers["X-Hermes-Session-Key"]).toBe("ops-prod");
  expect(headers["X-Hermes-Session-Id"]).toBeUndefined();
});
