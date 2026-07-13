export interface BoundedLineOptions {
  /** Maximum UTF-8 bytes allowed before a newline. */
  maxLineBytes: number;
  /** Human-readable stream name included in framing errors. */
  context: string;
}

function validateLimit(maxLineBytes: number): void {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new RangeError("maxLineBytes must be a positive safe integer");
  }
}

function decodeLine(decoder: TextDecoder, bytes: Uint8Array, context: string): string {
  try {
    return decoder.decode(bytes);
  } catch (error: unknown) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`${context} contains invalid UTF-8${detail}`);
  }
}

/**
 * Split a byte stream on LF without ever retaining more than one bounded line.
 * UTF-8 is decoded only after a complete line is assembled, so a multi-byte
 * character may safely straddle input chunks.
 */
export async function* iterateBoundedUtf8Lines(
  stream: ReadableStream<Uint8Array>,
  options: BoundedLineOptions,
): AsyncGenerator<string> {
  validateLimit(options.maxLineBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = new Uint8Array(Math.min(options.maxLineBytes, 4096));
  let pendingLength = 0;

  try {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline === -1 ? chunk.byteLength : newline;
        const segment = chunk.subarray(start, end);
        const lineBytes = pendingLength + segment.byteLength;
        if (lineBytes > options.maxLineBytes) {
          throw new RangeError(
            `${options.context} line exceeds ${options.maxLineBytes} UTF-8 bytes`,
          );
        }

        if (lineBytes > pending.byteLength) {
          let capacity = pending.byteLength;
          while (capacity < lineBytes) {
            capacity = Math.min(options.maxLineBytes, Math.max(capacity * 2, 1));
          }
          const grown = new Uint8Array(capacity);
          grown.set(pending.subarray(0, pendingLength));
          pending = grown;
        }
        pending.set(segment, pendingLength);
        pendingLength = lineBytes;
        if (newline === -1) break;

        yield decodeLine(decoder, pending.subarray(0, pendingLength), options.context);
        pendingLength = 0;
        start = newline + 1;
        if (start >= chunk.byteLength) break;
      }
    }

    if (pendingLength > 0) {
      yield decodeLine(decoder, pending.subarray(0, pendingLength), options.context);
    }
  } catch (error: unknown) {
    if (error instanceof Error) throw error;
    throw new Error(`${options.context} stream failed: ${String(error)}`);
  }
}
