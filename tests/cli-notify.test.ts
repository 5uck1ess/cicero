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

  expect(result).toEqual({ delivered: 2, parked: false, deferred: false });
  expect(observedUrl).toBe("https://127.0.0.1:8090/api/notify");
  expect(observedInit?.redirect).toBe("error");
  expect(observedInit?.headers).toEqual({
    "Content-Type": "application/json",
    Authorization: "Bearer secret",
  });
  expect(observedInit?.body).toBe(JSON.stringify({ text: "hello" }));
  expect(observedInit?.signal).toBeInstanceOf(AbortSignal);
});

test("urgent rides the body only when asked for", async () => {
  let body: string | undefined;
  const mockFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = init?.body as string;
    return Response.json({ delivered: 1 });
  }) as typeof fetch;
  const base = { scheme: "https" as const, port: 8090, token: "secret", text: "build is down" };

  await sendWebVoiceNotification({ ...base, urgent: true }, mockFetch);
  expect(JSON.parse(body!)).toEqual({ text: "build is down", urgent: true });

  await sendWebVoiceNotification(base, mockFetch);
  expect(JSON.parse(body!)).toEqual({ text: "build is down" });
});

test("a quiet-hours defer is distinct from a park and from a zero delivery", async () => {
  // Regression: an ops escalation deferred into the morning briefing used to be
  // reported as "no voice client is connected", which reads as lost.
  const responder = (payload: unknown) => (async () => Response.json(payload)) as typeof fetch;
  const base = { scheme: "https" as const, port: 8090, token: "secret", text: "fork sync stalled" };

  expect(await sendWebVoiceNotification(base, responder({ delivered: 0, deferred: true })))
    .toEqual({ delivered: 0, parked: false, deferred: true });
  expect(await sendWebVoiceNotification(base, responder({ delivered: 0, parked: true })))
    .toEqual({ delivered: 0, parked: true, deferred: false });
  await expect(sendWebVoiceNotification(base, responder({ delivered: 0, deferred: "yes" })))
    .rejects.toThrow(/invalid delivery result/);
});

test("a defer from a daemon predating the field is still reported as a defer", async () => {
  // Rolling upgrade: new CLI, daemon not yet restarted. That daemon cannot send
  // `deferred`, but its wire format is unambiguous anyway — every real
  // zero-delivery parks, so zero delivered AND not parked can only be the
  // quiet-hours defer. Without this the CLI falls back to "no voice client is
  // connected", which is exactly the misreport this change exists to kill.
  const responder = (payload: unknown) => (async () => Response.json(payload)) as typeof fetch;
  const base = { scheme: "https" as const, port: 8090, token: "secret", text: "fork sync stalled" };

  // Legacy defer, both shapes the old route could emit.
  expect(await sendWebVoiceNotification(base, responder({ delivered: 0 })))
    .toEqual({ delivered: 0, parked: false, deferred: true });
  expect(await sendWebVoiceNotification(base, responder({ delivered: 0, parked: false })))
    .toEqual({ delivered: 0, parked: false, deferred: true });

  // Legacy park and legacy delivery must NOT be inferred as defers.
  expect(await sendWebVoiceNotification(base, responder({ delivered: 0, parked: true })))
    .toEqual({ delivered: 0, parked: true, deferred: false });
  expect(await sendWebVoiceNotification(base, responder({ delivered: 3 })))
    .toEqual({ delivered: 3, parked: false, deferred: false });
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
