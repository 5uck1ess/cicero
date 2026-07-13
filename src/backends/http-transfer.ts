/** Absolute deadlines for the realtime provider pipeline. */
export const PROVIDER_TIMEOUT_MS = {
  health: 5_000,
  classifier: 2_500,
  summarizer: 15_000,
  turn: 10_000,
  tone: 5_000,
  stt: 90_000,
  tts: 60_000,
  llm: 120_000,
  voiceProvision: 120_000,
} as const;

/** Fixed memory ceilings. Streaming LLM output is intentionally not capped here. */
export const PROVIDER_RESPONSE_LIMIT_BYTES = {
  json: 8 * 1024 * 1024,
  audio: 64 * 1024 * 1024,
  error: 16 * 1024,
} as const;

export const MAX_PROVIDER_TIMEOUT_MS = 15 * 60 * 1_000;

/** Invalid values fall back; extreme values stay finite and timer-safe. */
export function requestTimeout(configured: number | undefined, fallback: number): number {
  const safeFallback = Number.isFinite(fallback) && fallback > 0
    ? Math.max(1, Math.min(Math.floor(fallback), MAX_PROVIDER_TIMEOUT_MS))
    : PROVIDER_TIMEOUT_MS.health;
  if (configured === undefined || !Number.isFinite(configured) || configured <= 0) {
    return safeFallback;
  }
  return Math.max(1, Math.min(Math.floor(configured), MAX_PROVIDER_TIMEOUT_MS));
}

/** Leave enough of the caller's deadline to flush a timeout response before
 * a poisoned native sidecar exits and its supervisor replaces it. */
export function sidecarInferenceTimeoutSeconds(requestTimeoutMs: number): number {
  const totalMs = requestTimeout(requestTimeoutMs, PROVIDER_TIMEOUT_MS.health);
  const reserveMs = Math.min(
    totalMs / 2,
    5_000,
    Math.max(1_000, Math.floor(totalMs * 0.1)),
  );
  return (totalMs - reserveMs) / 1_000;
}

/**
 * Combine a caller cancellation signal with a provider-owned absolute deadline.
 * The returned signal remains live while the response body or stream is read.
 */
export function providerSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(requestTimeout(timeoutMs, PROVIDER_TIMEOUT_MS.health));
  return caller ? AbortSignal.any([caller, deadline]) : deadline;
}

function declaredBodyLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function cancelBody(response: Response, reason?: unknown): Promise<void> {
  try {
    const cancellation = response.body?.cancel(reason);
    if (cancellation) {
      void cancellation.catch(() => {
        // Cancellation is only connection cleanup; never let a broken stream
        // extend the request's already-reached deadline.
      });
    }
  } catch {
    // The peer may already have closed or errored the body.
  }
}

function responseLimitError(label: string, maxBytes: number, observed?: number): Error {
  const detail = observed === undefined ? "" : ` (received at least ${observed} bytes)`;
  return new Error(`${label} exceeded the ${maxBytes}-byte response limit${detail}`);
}

/** Read a complete response while enforcing both declared and actual byte size. */
export async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  label = "provider response",
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`${label} requires a non-negative integer byte limit`);
  }
  const declared = declaredBodyLength(response);
  if (declared !== null && declared > maxBytes) {
    await cancelBody(response, responseLimitError(label, maxBytes, declared));
    throw responseLimitError(label, maxBytes, declared);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        const error = responseLimitError(label, maxBytes, total);
        try {
          void reader.cancel(error).catch(() => {
            // The response limit is authoritative even if cleanup stalls.
          });
        } catch {
          // The body can race the local cancellation.
        }
        throw error;
      }
      chunks.push(value);
    }
  } catch (err: unknown) {
    try {
      void reader.cancel(err).catch(() => {
        // Preserve the original read/deadline/cancellation error.
      });
    } catch {
      // Preserve the original read/deadline/cancellation error.
    }
    throw err;
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** Parse a complete JSON response only after enforcing a bounded byte read. */
export async function readBoundedJson<T>(
  response: Response,
  maxBytes = PROVIDER_RESPONSE_LIMIT_BYTES.json,
  label = "provider JSON response",
): Promise<T> {
  const bytes = await readBoundedBytes(response, maxBytes, label);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** Read bounded binary output and return an exact-size ArrayBuffer. */
export async function readBoundedArrayBuffer(
  response: Response,
  maxBytes = PROVIDER_RESPONSE_LIMIT_BYTES.audio,
  label = "provider audio response",
): Promise<ArrayBuffer> {
  const bytes = await readBoundedBytes(response, maxBytes, label);
  return bytes.buffer as ArrayBuffer;
}

/**
 * Read only an error prefix. Reaching the cap cancels the peer immediately;
 * it never buffers the rest merely to call `slice()` afterward.
 */
export async function readErrorDetail(
  response: Response,
  maxBytes = PROVIDER_RESPONSE_LIMIT_BYTES.error,
): Promise<string> {
  if (!response.body || maxBytes <= 0) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      const remaining = maxBytes - total;
      const prefix = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(prefix);
      total += prefix.byteLength;
      if (value.byteLength > remaining || total === maxBytes) {
        truncated = true;
        try {
          void reader.cancel("error body prefix captured").catch(() => {
            // The bounded diagnostic is complete even if cleanup stalls.
          });
        } catch {
          // The peer can race the local cancellation.
        }
        break;
      }
    }
  } catch (err: unknown) {
    try {
      void reader.cancel(err).catch(() => {
        // Preserve the original read/deadline/cancellation error.
      });
    } catch {
      // Preserve the original read/deadline/cancellation error.
    }
    throw err;
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const detail = new TextDecoder().decode(output).trim();
  return detail && truncated ? `${detail}…` : detail;
}

/** Initiate release of a probe response without downloading an irrelevant body. */
export async function discardResponseBody(response: Response): Promise<void> {
  await cancelBody(response).catch(() => {
    // cancelBody already treats release as best effort.
  });
}

/** Return probe status after initiating best-effort release of its irrelevant body. */
export async function responseIsOk(response: Response): Promise<boolean> {
  const ok = response.ok;
  await discardResponseBody(response).catch(() => {
    // Probe status is authoritative even if local stream release races closure.
  });
  return ok;
}

/** Delay a provider retry without outliving its absolute request deadline. */
export async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  try {
    if (signal.aborted) throw signal.reason;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  } catch (err: unknown) {
    throw err;
  }
}
