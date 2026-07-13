import { test, expect } from "bun:test";
import { streamSSEContent, type SSEStreamOptions } from "../../../src/backends/llm/sse";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(chunks: string[], options?: SSEStreamOptions): Promise<string[]> {
  try {
    const out: string[] = [];
    for await (const t of streamSSEContent(streamFrom(chunks), options)) out.push(t);
    return out;
  } catch (error: unknown) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

test("reassembles a JSON event split across network chunks", async () => {
  // Naive per-chunk newline-splitting would silently drop this event.
  const out = await collect([
    'data: {"choices":[{"delta":{"content":"Hel',
    'lo"}}]}\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n',
    "data: [DONE]\n",
  ]);
  expect(out.join("")).toBe("Hello world");
});

test("handles multiple events in one chunk and CRLF endings", async () => {
  const out = await collect([
    'data: {"choices":[{"delta":{"content":"a"}}]}\r\ndata: {"choices":[{"delta":{"content":"b"}}]}\r\n',
    "data: [DONE]\r\n",
  ]);
  expect(out).toEqual(["a", "b"]);
});

test("yields a final event with no trailing newline", async () => {
  const out = await collect(['data: {"choices":[{"delta":{"content":"end"}}]}']);
  expect(out).toEqual(["end"]);
});

test("ignores keepalive lines and stops at [DONE]", async () => {
  const out = await collect([
    ": keepalive\n",
    'data: {"choices":[{"delta":{"content":"x"}}]}\n',
    "data: [DONE]\n",
    'data: {"choices":[{"delta":{"content":"after-done"}}]}\n',
  ]);
  expect(out).toEqual(["x"]);
});

test("bounds an incomplete event line across network chunks", () => {
  return expect(
    collect(["data: 1234", "5"], { maxLineBytes: 10 }),
  ).rejects.toThrow("SSE line exceeds 10 UTF-8 bytes");
});

test("resets the cap for each complete event line", async () => {
  const event = 'data: {"choices":[]}\n';
  expect(await collect([event + event], { maxLineBytes: event.length - 1 })).toEqual([]);
});

test("ignores malformed data records without losing later valid tokens", async () => {
  expect(await collect([
    "data: not-json\n",
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
  ])).toEqual(["ok"]);
});
