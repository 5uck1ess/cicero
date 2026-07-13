import { expect, test } from "bun:test";
import { AcpQueueOverflowError, ChunkQueue } from "../../src/brain/acp";

test("ChunkQueue accounts UTF-8 bytes and fails closed on overflow", async () => {
  const overflows: AcpQueueOverflowError[] = [];
  const queue = new ChunkQueue(5, (error) => { overflows.push(error); });
  expect(queue.push("éé")).toBe(true); // four UTF-8 bytes, not two code units
  expect(queue.queuedBytes).toBe(4);
  expect(queue.push("aa")).toBe(false);
  expect(queue.queuedBytes).toBe(0);
  expect(overflows).toHaveLength(1);

  const iterator = queue.drain()[Symbol.asyncIterator]();
  await expect(iterator.next()).rejects.toBeInstanceOf(AcpQueueOverflowError);
});

test("ChunkQueue ignores empty updates so they cannot bypass its byte bound", async () => {
  const queue = new ChunkQueue(1);
  for (let index = 0; index < 100_000; index++) expect(queue.push("")).toBe(true);

  const storage = queue as unknown as { chunks: unknown[] };
  expect(storage.chunks).toHaveLength(0);
  expect(queue.queuedBytes).toBe(0);

  expect(queue.push("x")).toBe(true);
  queue.end();
  expect(await Array.fromAsync(queue.drain())).toEqual(["x"]);
});

test("ChunkQueue drains many tiny chunks with a head index and compacts consumed slots", async () => {
  const queue = new ChunkQueue(25_000);
  for (let i = 0; i < 20_000; i++) expect(queue.push("x")).toBe(true);
  queue.end();

  const iterator = queue.drain()[Symbol.asyncIterator]();
  for (let i = 0; i < 15_000; i++) {
    expect(await iterator.next()).toEqual({ value: "x", done: false });
  }
  expect(queue.queuedBytes).toBe(5_000);
  const storage = queue as unknown as { chunks: unknown[]; head: number };
  expect(storage.head).toBeGreaterThanOrEqual(0);
  expect(storage.chunks.length).toBeLessThan(10_000);

  let remaining = 0;
  while (!(await iterator.next()).done) remaining++;
  expect(remaining).toBe(5_000);
  expect(queue.queuedBytes).toBe(0);
});

test("ChunkQueue releases 1023 paced exact-limit payload slots before compaction", async () => {
  const limit = 8 * 1024;
  const payload = "z".repeat(limit);
  const queue = new ChunkQueue(limit);
  const iterator = queue.drain()[Symbol.asyncIterator]();

  for (let index = 0; index < 1_023; index++) {
    expect(queue.push(payload)).toBe(true);
    expect(await iterator.next()).toEqual({ value: payload, done: false });
    expect(queue.queuedBytes).toBe(0);
  }

  const storage = queue as unknown as { chunks: Array<unknown | null>; head: number };
  expect(storage.head).toBe(1_023);
  expect(storage.chunks).toHaveLength(1_023);
  expect(storage.chunks.every((slot) => slot === null)).toBe(true);

  queue.end();
  expect(await iterator.next()).toEqual({ value: undefined, done: true });
});
