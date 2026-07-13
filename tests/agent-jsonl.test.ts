import { test, expect } from "bun:test";
import { iterateJsonLines, type JsonLineOptions } from "../src/agent/jsonl";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

async function collect(chunks: string[], options?: JsonLineOptions): Promise<unknown[]> {
  try {
    const out: unknown[] = [];
    for await (const o of iterateJsonLines(streamFrom(chunks), options)) out.push(o);
    return out;
  } catch (error: unknown) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function collectBytes(chunks: Uint8Array[], options?: JsonLineOptions): Promise<unknown[]> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  try {
    const out: unknown[] = [];
    for await (const value of iterateJsonLines(stream, options)) out.push(value);
    return out;
  } catch (error: unknown) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

test("parses one JSON object per line", async () => {
  expect(await collect(['{"a":1}\n{"a":2}\n'])).toEqual([{ a: 1 }, { a: 2 }]);
});

test("reassembles an object split across chunk boundaries", async () => {
  const out = await collect(['{"type":"item.completed","item":{"type":"agent', '_message","text":"hi"}}\n']);
  expect(out).toEqual([{ type: "item.completed", item: { type: "agent_message", text: "hi" } }]);
});

test("yields a final line with no trailing newline", async () => {
  expect(await collect(['{"x":true}'])).toEqual([{ x: true }]);
});

test("skips blank and non-JSON lines", async () => {
  expect(await collect(["\n", "not json\n", '{"ok":1}\n'])).toEqual([{ ok: 1 }]);
});

test("enforces the record cap by UTF-8 bytes across chunks", async () => {
  expect(await collect(['{"x":1}\n'], { maxLineBytes: 7 })).toEqual([{ x: 1 }]);
  await expect(collect(['{"x":', "12}"], { maxLineBytes: 7 })).rejects.toThrow(
    "JSONL line exceeds 7 UTF-8 bytes",
  );
});

test("resets the cap after each complete record", async () => {
  expect(await collect(['{"x":1}\n{"x":2}\n'], { maxLineBytes: 7 })).toEqual([
    { x: 1 },
    { x: 2 },
  ]);
});

test("reassembles a multi-byte character split across chunks", async () => {
  const bytes = new TextEncoder().encode('{"text":"é"}\n');
  const split = bytes.indexOf(0xc3) + 1;
  expect(await collectBytes([bytes.slice(0, split), bytes.slice(split)])).toEqual([
    { text: "é" },
  ]);
});

test("rejects malformed UTF-8 instead of silently replacing bytes", () => {
  const malformed = new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a]);
  return expect(collectBytes([malformed])).rejects.toThrow("JSONL contains invalid UTF-8");
});

test("rejects invalid line limits", () => {
  return expect(collect(['{"x":1}\n'], { maxLineBytes: 0 })).rejects.toThrow(
    "maxLineBytes must be a positive safe integer",
  );
});
