import { expect, test } from "bun:test";
import {
  commandText,
  normalizeCliText,
  readBoundedCliText,
} from "../src/cli/text-input";

const limit = { label: "test text", maxBytes: 8, maxChars: 4 } as const;

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

test("CLI text normalizes argv without touching stdin", async () => {
  const stdin = byteStream([new TextEncoder().encode("unused")]);
  expect(await commandText([" hello", "world "], stdin, {
    label: "test text",
    maxBytes: 32,
    maxChars: 16,
  })).toBe("hello world");
});

test("bounded stdin reassembles split UTF-8 and enforces character limits", async () => {
  const encoded = new TextEncoder().encode("😀 ok");
  const text = await readBoundedCliText(
    byteStream([encoded.subarray(0, 2), encoded.subarray(2)]),
    { label: "test text", maxBytes: 8, maxChars: 5 },
  );
  expect(text).toBe("😀 ok");
  expect(() => normalizeCliText("12345", limit)).toThrow(/4 characters/);
});

test("argv and stdin enforce the same exact UTF-8 byte ceiling", async () => {
  const multibyteLimit = { label: "test text", maxBytes: 4, maxChars: 3 } as const;
  const exact = new TextEncoder().encode("éé");
  const oversized = new TextEncoder().encode("ééé");

  expect(await commandText(["éé"], byteStream([]), multibyteLimit)).toBe("éé");
  expect(await readBoundedCliText(byteStream([exact]), multibyteLimit)).toBe("éé");
  await expect(commandText(["ééé"], byteStream([]), multibyteLimit)).rejects.toThrow(
    /4 UTF-8 bytes/,
  );
  await expect(readBoundedCliText(byteStream([oversized]), multibyteLimit)).rejects.toThrow(
    /4 UTF-8 bytes/,
  );
});

test("bounded stdin cancels immediately after crossing its byte ceiling", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(9));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(readBoundedCliText(stream, limit)).rejects.toThrow(/8 UTF-8 bytes/);
  expect(cancelled).toBe(true);
});

test("bounded stdin rejects empty and malformed UTF-8 input", async () => {
  await expect(readBoundedCliText(byteStream([]), limit)).rejects.toThrow(/empty/);
  await expect(
    readBoundedCliText(byteStream([new Uint8Array([0xc3, 0x28])]), limit),
  ).rejects.toThrow(/valid UTF-8/);
});
