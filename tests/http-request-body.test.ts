import { expect, test } from "bun:test";
import { RequestBodyTimeoutError, readRequestBodyLimited } from "../src/http-request-body";

test("the bounded body reader coalesces highly fragmented uploads exactly", async () => {
  const length = 16_384;
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === length) {
        controller.close();
        return;
      }
      controller.enqueue(Uint8Array.of(offset % 251));
      offset += 1;
    },
  });
  const request = new Request("http://localhost/upload", { method: "POST", body });

  const result = new Uint8Array(await readRequestBodyLimited(request, {
    maxBytes: length,
    timeoutMs: 5_000,
  }));
  const expected = Uint8Array.from({ length }, (_, index) => index % 251);

  expect(result.byteLength).toBe(length);
  expect(result).toEqual(expected);
});

test("a non-cooperative cancel hook cannot extend the absolute body deadline", async () => {
  let cancelCalled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(1));
    },
    cancel() {
      cancelCalled = true;
      return new Promise<void>(() => { /* deliberately never settles */ });
    },
  });
  const request = new Request("http://localhost/upload", { method: "POST", body });
  const reading = readRequestBodyLimited(request, { maxBytes: 16, timeoutMs: 20 });
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    guardTimer = setTimeout(() => reject(new Error("body cancellation escaped its deadline")), 250);
  });

  try {
    await expect(Promise.race([reading, guard])).rejects.toBeInstanceOf(RequestBodyTimeoutError);
    expect(cancelCalled).toBe(true);
  } finally {
    if (guardTimer !== undefined) clearTimeout(guardTimer);
  }
});
