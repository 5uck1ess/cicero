import { discardResponseBody, providerSignal } from "../backends/http-transfer";

const MAX_HOOK_BODY_BYTES = 256 * 1024;
const MAX_HOOK_TEXT_BYTES = 128 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 2_000;
const DEFAULT_FORWARD_TIMEOUT_MS = 2_500;

interface CodexStopPayload {
  hook_event_name?: unknown;
  last_assistant_message?: unknown;
}

export interface ForwardCodexStopHookOptions {
  port: number;
  token: string;
  input?: ReadableStream<Uint8Array>;
  fetcher?: typeof fetch;
  bodyTimeoutMs?: number;
  forwardTimeoutMs?: number;
}

function readBeforeDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function readHookBody(
  input: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<string> {
  const reader = input.getReader();
  const chunks: Uint8Array[] = [];
  const signal = AbortSignal.timeout(timeoutMs);
  let total = 0;
  try {
    while (true) {
      const result = await readBeforeDeadline(reader, signal);
      if (result.done) break;
      const value = result.value;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > MAX_HOOK_BODY_BYTES) {
        throw new RangeError("Codex hook payload is too large");
      }
      chunks.push(value.slice());
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    await reader.cancel(error).catch(() => {
      // The hook deadline/size failure remains authoritative.
    });
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function assistantText(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const payload = parsed as CodexStopPayload;
  if (payload.hook_event_name !== "Stop") return null;
  if (typeof payload.last_assistant_message !== "string") return null;
  const text = payload.last_assistant_message;
  if (!text.trim() || Buffer.byteLength(text) > MAX_HOOK_TEXT_BYTES) return null;
  return text;
}

/**
 * Best-effort Codex command-hook bridge into Cicero's authenticated loopback
 * receiver. Hook failures never fail or extend the Codex turn.
 */
export async function forwardCodexStopHook(
  options: ForwardCodexStopHookOptions,
): Promise<boolean> {
  try {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) return false;
    const raw = await readHookBody(
      options.input ?? Bun.stdin.stream(),
      options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS,
    );
    const text = assistantText(raw);
    if (!text) return false;

    const response = await (options.fetcher ?? fetch)(
      `http://localhost:${options.port}/speak`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text, agent: "codex" }),
        redirect: "error",
        signal: providerSignal(options.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS),
      },
    );
    const accepted = response.status === 202;
    await discardResponseBody(response);
    return accepted;
  } catch {
    return false;
  }
}
