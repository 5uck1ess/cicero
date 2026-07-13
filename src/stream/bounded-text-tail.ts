export interface BoundedTextTail {
  text: string;
  receivedBytes: number;
  retainedBytes: number;
  limitBytes: number;
  truncated: boolean;
}

export interface BoundedTextTailOptions {
  /** Maximum raw bytes retained from the end of the stream. */
  maxBytes: number;
  /** Human-readable stream name included in read failures. */
  context: string;
}

/**
 * Drain a byte stream to EOF while retaining only its final `maxBytes` bytes.
 * Starting the returned promise as soon as a child is spawned prevents a full
 * stderr pipe from blocking that child before it can exit.
 */
export async function collectBoundedTextTail(
  stream: ReadableStream<Uint8Array>,
  options: BoundedTextTailOptions,
): Promise<BoundedTextTail> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }

  const retained = new Uint8Array(options.maxBytes);
  let start = 0;
  let retainedBytes = 0;
  let receivedBytes = 0;

  const writeAt = (chunk: Uint8Array, offset: number): void => {
    const firstLength = Math.min(chunk.byteLength, retained.byteLength - offset);
    retained.set(chunk.subarray(0, firstLength), offset);
    if (firstLength < chunk.byteLength) retained.set(chunk.subarray(firstLength), 0);
  };

  try {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      receivedBytes = Math.min(Number.MAX_SAFE_INTEGER, receivedBytes + chunk.byteLength);
      if (chunk.byteLength >= retained.byteLength) {
        retained.set(chunk.subarray(chunk.byteLength - retained.byteLength));
        start = 0;
        retainedBytes = retained.byteLength;
        continue;
      }

      const available = retained.byteLength - retainedBytes;
      const initial = Math.min(available, chunk.byteLength);
      if (initial > 0) {
        writeAt(chunk.subarray(0, initial), (start + retainedBytes) % retained.byteLength);
        retainedBytes += initial;
      }

      const remaining = chunk.subarray(initial);
      if (remaining.byteLength > 0) {
        writeAt(remaining, start);
        start = (start + remaining.byteLength) % retained.byteLength;
      }
    }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${options.context} stream failed: ${detail}`, { cause: error });
  }

  const bytes = new Uint8Array(retainedBytes);
  if (retainedBytes > 0) {
    const firstLength = Math.min(retainedBytes, retained.byteLength - start);
    bytes.set(retained.subarray(start, start + firstLength));
    if (firstLength < retainedBytes) bytes.set(retained.subarray(0, retainedBytes - firstLength), firstLength);
  }

  return {
    text: new TextDecoder().decode(bytes),
    receivedBytes,
    retainedBytes,
    limitBytes: options.maxBytes,
    truncated: receivedBytes > retainedBytes,
  };
}
