import type { WyomingTransport } from "./client";

/** Closing the owned socket releases pending Wyoming reads and writes. */
export async function withWyomingAbort<T>(
  client: WyomingTransport,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return run();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    client.close();
    rejectAbort(signal.reason ?? new DOMException("Request aborted", "AbortError"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const result = await Promise.race([run(), aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
