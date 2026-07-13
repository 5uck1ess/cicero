import { expect, mock, test } from "bun:test";
import { forwardCodexStopHook } from "../src/sidecar/codex-hook";

const TOKEN = "test-hook-token-that-is-at-least-32-bytes";

function input(value: string | Uint8Array): ReadableStream<Uint8Array> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

test("Codex Stop hook forwards only the bounded assistant message", async () => {
  let request: Request | undefined;
  const fetcher = mock(async (target: string | URL | Request, init?: RequestInit) => {
    request = new Request(target, init);
    return new Response(null, { status: 202 });
  }) as typeof fetch;

  const accepted = await forwardCodexStopHook({
    port: 8084,
    token: TOKEN,
    input: input(JSON.stringify({
      session_id: "session-a",
      hook_event_name: "Stop",
      transcript_path: "/private/transcript.jsonl",
      last_assistant_message: "Implemented the native hook.",
    })),
    fetcher,
  });

  expect(accepted).toBe(true);
  expect(request?.url).toBe("http://localhost:8084/speak");
  expect(request?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  expect(await request?.json()).toEqual({
    text: "Implemented the native hook.",
    agent: "codex",
  });
});

test("non-Stop, empty, malformed, and oversized payloads never reach the receiver", async () => {
  const fetcher = mock(async () => new Response(null, { status: 202 })) as typeof fetch;
  const payloads = [
    JSON.stringify({ hook_event_name: "UserPromptSubmit", last_assistant_message: "no" }),
    JSON.stringify({ hook_event_name: "Stop", last_assistant_message: null }),
    "not json",
    JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "x".repeat(128 * 1024 + 1) }),
  ];

  for (const payload of payloads) {
    expect(await forwardCodexStopHook({
      port: 8084,
      token: TOKEN,
      input: input(payload),
      fetcher,
    })).toBe(false);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

test("hook stdin has a deadline and is cancelled when the producer stalls", async () => {
  let cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"hook_event_name":"Stop"'));
    },
    cancel() {
      cancelled = true;
    },
  });

  expect(await forwardCodexStopHook({
    port: 8084,
    token: TOKEN,
    input: stalled,
    bodyTimeoutMs: 20,
  })).toBe(false);
  expect(cancelled).toBe(true);
});

test("receiver failures stay best-effort and cannot fail the Codex turn", async () => {
  const fetcher = mock(async () => {
    throw new Error("receiver is down");
  }) as typeof fetch;

  expect(await forwardCodexStopHook({
    port: 8084,
    token: TOKEN,
    input: input(JSON.stringify({
      hook_event_name: "Stop",
      last_assistant_message: "Done.",
    })),
    fetcher,
  })).toBe(false);
});
