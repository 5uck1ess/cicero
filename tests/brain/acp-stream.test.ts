import { expect, spyOn, test } from "bun:test";
import type { AnyMessage } from "@zed-industries/agent-client-protocol";
import {
  AcpFrameLimitError,
  AcpMalformedFrameError,
  boundedNdJsonStream,
} from "../../src/brain/acp";

const encoder = new TextEncoder();

function byteInput(chunks: readonly string[]): ReadableStream<Uint8Array> {
  return rawInput(chunks.map((chunk) => encoder.encode(chunk)));
}

function rawInput(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function ignoredOutput(): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({ write() {} });
}

async function readAll(stream: ReadableStream<AnyMessage>): Promise<AnyMessage[]> {
  const messages: AnyMessage[] = [];
  try {
    for await (const message of stream) messages.push(message);
    return messages;
  } catch (error: unknown) {
    throw error;
  }
}

test("bounded ACP NDJSON preserves split, coalesced, blank, and outbound wire frames", async () => {
  const outbound: string[] = [];
  const output = new WritableStream<Uint8Array>({
    write(bytes) { outbound.push(new TextDecoder().decode(bytes)); },
  });
  const stream = boundedNdJsonStream(output, byteInput([
    '{"jsonrpc":"2.0","id":1,',
    '"result":{"ok":true}}\n\n{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s1"}}\n',
  ]));

  expect(await readAll(stream.readable)).toEqual([
    { jsonrpc: "2.0", id: 1, result: { ok: true } },
    { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } },
  ]);
  const writer = stream.writable.getWriter();
  try {
    await writer.write({ jsonrpc: "2.0", id: 2, result: null });
  } finally {
    writer.releaseLock();
  }
  expect(outbound).toEqual(['{"jsonrpc":"2.0","id":2,"result":null}\n']);
});

test("bounded ACP NDJSON rejects an oversized newline-free frame before EOF", async () => {
  const errors: Error[] = [];
  const stream = boundedNdJsonStream(ignoredOutput(), byteInput(["1234", "56789"]), {
    maxFrameBytes: 8,
    onError: (error) => { errors.push(error); },
  });

  expect(await readAll(stream.readable)).toEqual([]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(AcpFrameLimitError);
});

test("bounded ACP NDJSON rejects one oversized newline-terminated line", async () => {
  const errors: Error[] = [];
  const stream = boundedNdJsonStream(ignoredOutput(), byteInput(["123456789\n"]), {
    maxFrameBytes: 8,
    onError: (error) => { errors.push(error); },
  });

  expect(await readAll(stream.readable)).toEqual([]);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.message).toContain("8-byte limit");
});

test("bounded ACP NDJSON rejects invalid UTF-8 split across input chunks", async () => {
  const errors: Error[] = [];
  const suffix = encoder.encode('"}\n');
  const invalidTail = new Uint8Array(suffix.byteLength + 1);
  invalidTail[0] = 0x28;
  invalidTail.set(suffix, 1);
  const stream = boundedNdJsonStream(ignoredOutput(), rawInput([
    encoder.encode('{"jsonrpc":"2.0","id":1,"result":"'),
    new Uint8Array([0xc3]),
    invalidTail,
  ]), {
    onError: (error) => { errors.push(error); },
  });

  expect(await readAll(stream.readable)).toEqual([]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(TypeError);
});

test("bounded ACP NDJSON closes after a bounded number of malformed records", async () => {
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  const errors: Error[] = [];
  try {
    const stream = boundedNdJsonStream(ignoredOutput(), byteInput([
      ...Array.from({ length: 9 }, () => "not-json\n"),
      '{"jsonrpc":"2.0","id":1,"result":null}\n',
    ]), {
      onError: (error) => { errors.push(error); },
    });

    expect(await readAll(stream.readable)).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AcpMalformedFrameError);
    expect(errorLog).toHaveBeenCalledTimes(4);
  } catch (error: unknown) {
    throw error;
  } finally {
    errorLog.mockRestore();
  }
});

test("bounded ACP NDJSON backpressures inbound requests until response writes complete", async () => {
  let releaseOutput: (() => void) | null = null;
  const output = new WritableStream<Uint8Array>({
    write() {
      return new Promise<void>((resolve) => { releaseOutput = resolve; });
    },
  });
  const request = (id: number) =>
    `{"jsonrpc":"2.0","id":${id},"method":"session/request_permission","params":{}}\n`;
  const stream = boundedNdJsonStream(output, byteInput([
    request(1),
    request(2),
    request(3),
  ]), { maxInboundRequests: 2 });
  const reader = stream.readable.getReader();
  expect((await reader.read()).value).toMatchObject({ id: 1 });
  expect((await reader.read()).value).toMatchObject({ id: 2 });

  let thirdSettled = false;
  const third = reader.read().then((result) => {
    thirdSettled = true;
    return result;
  }).catch((error: unknown) => {
    thirdSettled = true;
    throw error;
  });
  await Bun.sleep(10);
  expect(thirdSettled).toBe(false);

  const writer = stream.writable.getWriter();
  const responseWrite = writer.write({ jsonrpc: "2.0", id: 1, result: null });
  await Bun.sleep(10);
  expect(thirdSettled).toBe(false);
  if (!releaseOutput) throw new Error("ACP response write did not reach the output stream");
  releaseOutput();
  await responseWrite;
  writer.releaseLock();

  expect((await third).value).toMatchObject({ id: 3 });
  await reader.cancel("test complete");
});

test("a rejected ACP response write closes the input side and reports transport failure", async () => {
  const errors: Error[] = [];
  const output = new WritableStream<Uint8Array>({
    write() { throw new Error("agent stdin closed"); },
  });
  const stream = boundedNdJsonStream(output, byteInput([
    '{"jsonrpc":"2.0","id":1,"method":"first","params":{}}\n',
    '{"jsonrpc":"2.0","id":2,"method":"second","params":{}}\n',
  ]), {
    maxInboundRequests: 1,
    onError: (error) => { errors.push(error); },
  });
  const reader = stream.readable.getReader();
  expect((await reader.read()).value).toMatchObject({ id: 1 });
  const blockedRead = reader.read();

  const writer = stream.writable.getWriter();
  try {
    await expect(writer.write({ jsonrpc: "2.0", id: 1, result: null })).rejects.toThrow("stdin closed");
  } catch (error: unknown) {
    throw error;
  } finally {
    writer.releaseLock();
  }
  expect(await blockedRead).toEqual({ value: undefined, done: true });
  expect(errors).toHaveLength(1);
  expect(errors[0]?.message).toContain("stdin closed");
});

test("consumer cancellation releases a pending ACP input read without reporting a wire error", async () => {
  const errors: Error[] = [];
  const stream = boundedNdJsonStream(
    ignoredOutput(),
    new ReadableStream<Uint8Array>({ start() { /* deliberately pending */ } }),
    { onError: (error) => { errors.push(error); } },
  );
  const reader = stream.readable.getReader();
  const pending = reader.read();
  await reader.cancel("test complete");
  expect(await pending).toEqual({ value: undefined, done: true });
  expect(errors).toEqual([]);
});
