import { test, expect } from "bun:test";
import { iterateTextStream } from "../src/brain/stream-utils";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}
async function collect(gen: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const s of gen) out += s;
  return out;
}

test("decodes a chunked byte stream into text pieces", async () => {
  const out = await collect(iterateTextStream(streamFrom(["Hel", "lo, ", "world"])));
  expect(out).toBe("Hello, world");
});

test("handles a multi-byte character split across chunks", async () => {
  const enc = new TextEncoder();
  const bytes = enc.encode("café"); // é is 2 bytes
  const a = bytes.slice(0, bytes.length - 1);
  const b = bytes.slice(bytes.length - 1);
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(a); c.enqueue(b); c.close(); },
  });
  expect(await collect(iterateTextStream(stream))).toBe("café");
});

test("yields nothing for an empty stream", async () => {
  const out = await collect(iterateTextStream(streamFrom([])));
  expect(out).toBe("");
});
