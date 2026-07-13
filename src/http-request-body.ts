/** Bounded, abort-aware request-body readers shared by Cicero's HTTP surfaces. */

export class RequestBodyTooLargeError extends Error {}
export class RequestBodyTimeoutError extends Error {}

export class RequestBodyAbortedError extends Error {
  constructor(reason?: unknown) {
    super("request body read was aborted", reason === undefined ? undefined : { cause: reason });
  }
}

export interface RequestBodyReadOptions {
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

function abortError(signal: AbortSignal): RequestBodyAbortedError {
  return new RequestBodyAbortedError(signal.reason);
}

function cancelUnlockedBody(req: Request, reason: unknown): void {
  try {
    const cancellation = req.body?.cancel(reason);
    if (cancellation) void cancellation.catch(() => {});
  } catch {
    // The peer or runtime may already have closed/locked the upload stream.
  }
}

/** Read a complete body under one absolute deadline and one exact byte ceiling. */
export async function readRequestBodyLimited(
  req: Request,
  options: RequestBodyReadOptions,
): Promise<ArrayBuffer> {
  const { maxBytes, timeoutMs, signal } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("request body limit must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("request body timeout must be a positive safe integer");
  }
  if (signal?.aborted) {
    const error = abortError(signal);
    cancelUnlockedBody(req, error);
    throw error;
  }

  const declared = req.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    const error = new RequestBodyTooLargeError(`request body exceeds ${maxBytes} bytes`);
    cancelUnlockedBody(req, error);
    throw error;
  }
  if (!req.body) return new ArrayBuffer(0);

  const reader = req.body.getReader();
  let retained = new Uint8Array(0);
  let total = 0;
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new RequestBodyTimeoutError(`request body read timed out after ${timeoutMs}ms`);
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      let removeAbortListener: (() => void) | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RequestBodyTimeoutError(`request body read timed out after ${timeoutMs}ms`)),
          remainingMs,
        );
      });
      let aborted: Promise<never> | undefined;
      if (signal) {
        aborted = new Promise<never>((_, reject) => {
          const onAbort = () => reject(abortError(signal));
          if (signal.aborted) onAbort();
          else {
            signal.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () => signal.removeEventListener("abort", onAbort);
          }
        });
      }

      const read = aborted
        ? Promise.race([reader.read(), timeout, aborted])
        : Promise.race([reader.read(), timeout]);
      const { done, value } = await read.finally(() => {
        if (timer !== undefined) clearTimeout(timer);
        removeAbortListener?.();
      });
      if (done) break;
      if (value.byteLength > maxBytes - total) {
        throw new RequestBodyTooLargeError(`request body exceeds ${maxBytes} bytes`);
      }
      const nextTotal = total + value.byteLength;
      if (value.byteLength > 0 && retained.byteLength < nextTotal) {
        let capacity = Math.max(1, retained.byteLength);
        while (capacity < nextTotal) {
          capacity = Math.min(maxBytes, Math.max(nextTotal, capacity * 2));
        }
        const grown = new Uint8Array(capacity);
        grown.set(retained.subarray(0, total));
        retained = grown;
      }
      if (value.byteLength > 0) retained.set(value, total);
      total = nextTotal;
    }
  } catch (error) {
    try {
      // Cancellation is cleanup, not part of the request's absolute deadline.
      // A hostile/custom stream may never settle its cancel hook; observe that
      // promise without allowing it to hold the handler or shutdown drain.
      void reader.cancel(error).catch(() => {});
    } catch {
      // The body is already closed; cancellation is cleanup, not a new failure.
    }
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* already released by the runtime */ }
  }

  if (total === retained.byteLength) return retained.buffer;
  return retained.buffer.slice(0, total);
}

export async function readRequestJsonLimited(
  req: Request,
  options: RequestBodyReadOptions,
): Promise<unknown> {
  try {
    const body = await readRequestBodyLimited(req, options);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    if (
      error instanceof RequestBodyTooLargeError ||
      error instanceof RequestBodyTimeoutError ||
      error instanceof RequestBodyAbortedError
    ) {
      throw error;
    }
    throw new SyntaxError("invalid JSON body", { cause: error });
  }
}
