import { expect, test } from "bun:test";
import { sendWebVoiceNotification } from "../src/cli/notify";
import { MAX_NOTIFY_TEXT_CHARS } from "../src/web-voice/protocol";

test("notify stays on loopback, disables redirects, and validates delivery JSON", async () => {
  let observedUrl = "";
  let observedInit: RequestInit | undefined;
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    observedUrl = String(input);
    observedInit = init;
    return Response.json({ delivered: 2, parked: false });
  }) as typeof fetch;

  const result = await sendWebVoiceNotification({
    scheme: "https",
    port: 8090,
    token: "secret",
    text: " hello ",
  }, mockFetch);

  expect(result).toEqual({ delivered: 2, parked: false });
  expect(observedUrl).toBe("https://127.0.0.1:8090/api/notify");
  expect(observedInit?.redirect).toBe("error");
  expect(observedInit?.headers).toEqual({
    "Content-Type": "application/json",
    Authorization: "Bearer secret",
  });
  expect(observedInit?.body).toBe(JSON.stringify({ text: "hello" }));
  expect(observedInit?.signal).toBeInstanceOf(AbortSignal);
});

test("notify rejects character and encoded-JSON overflow before fetch", async () => {
  let calls = 0;
  const mockFetch = (async () => {
    calls += 1;
    return Response.json({ delivered: 1 });
  }) as typeof fetch;

  await expect(sendWebVoiceNotification({
    scheme: "http",
    port: 8090,
    token: "secret",
    text: "x".repeat(MAX_NOTIFY_TEXT_CHARS + 1),
  }, mockFetch)).rejects.toThrow(/characters/);
  await expect(sendWebVoiceNotification({
    scheme: "http",
    port: 8090,
    token: "secret",
    text: "\u0001".repeat(MAX_NOTIFY_TEXT_CHARS),
  }, mockFetch)).rejects.toThrow(/JSON exceeds/);
  expect(calls).toBe(0);
});

test("notify bounds error and success response bodies and rejects invalid schemas", async () => {
  const errorFetch = (async () => new Response("failure", { status: 500 })) as typeof fetch;
  await expect(sendWebVoiceNotification({
    scheme: "http",
    port: 8090,
    token: "secret",
    text: "hello",
  }, errorFetch)).rejects.toThrow(/500 failure/);

  const oversizedFetch = (async () => new Response("{}", {
    headers: { "Content-Length": "5000" },
  })) as typeof fetch;
  await expect(sendWebVoiceNotification({
    scheme: "http",
    port: 8090,
    token: "secret",
    text: "hello",
  }, oversizedFetch)).rejects.toThrow(/4096-byte response limit/);

  const invalidFetch = (async () => Response.json({ delivered: -1 })) as typeof fetch;
  await expect(sendWebVoiceNotification({
    scheme: "http",
    port: 8090,
    token: "secret",
    text: "hello",
  }, invalidFetch)).rejects.toThrow(/invalid delivery result/);
});

test("notify deadline remains active while a successful response body stalls", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"delivered":'));
        },
      }), { headers: { "Content-Type": "application/json" } });
    },
  });
  try {
    await expect(sendWebVoiceNotification({
      scheme: "http",
      port: server.port,
      token: "secret",
      text: "hello",
      timeoutMs: 25,
    })).rejects.toThrow();
  } finally {
    await Promise.resolve(server.stop(true)).catch(() => {});
  }
});
