import { readBoundedJson, requestTimeout } from "../backends/http-transfer";

const MAX_DICTATE_RESPONSE_BYTES = 4 * 1024;
/** Generous: a stop-toggle returns only after the capture has been transcribed. */
const DEFAULT_DICTATE_TIMEOUT_MS = 180_000;

export interface DictateRequest {
  scheme: "http" | "https";
  port: number;
  token: string;
  timeoutMs?: number;
}

export interface DictateResult {
  /** The daemon's state after the toggle: "recording" once started, "idle" once it finishes. */
  state: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Toggle dictation on a running daemon.
 *
 * The toggle lives behind the CLI rather than a bundled global-hotkey helper so
 * every platform can bind it with its own native shortcut mechanism — macOS
 * Shortcuts, a Windows shortcut key, or any Linux desktop's keybinding UI —
 * instead of Cicero shipping and maintaining three OS-specific key listeners.
 */
export async function requestDictationToggle(
  request: DictateRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<DictateResult> {
  // A stop-toggle blocks on transcription, so this must outlast a long
  // dictation being decoded — not the shorter synthesis-shaped default.
  const timeoutMs = requestTimeout(request.timeoutMs, DEFAULT_DICTATE_TIMEOUT_MS);
  const response = await fetchImpl(
    `${request.scheme}://127.0.0.1:${request.port}/api/dictate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${request.token}`,
      },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
      // The daemon's loopback certificate is self-signed by design (see
      // docs/setup.md); notify makes the same exception for 127.0.0.1.
      tls: { rejectUnauthorized: false },
    } as RequestInit,
  );

  const body = await readBoundedJson<unknown>(response, MAX_DICTATE_RESPONSE_BYTES, "dictation response").catch(() => null);
  if (!response.ok) {
    const detail = isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (!isRecord(body) || typeof body.state !== "string") {
    throw new Error("daemon returned an invalid dictation response");
  }
  return { state: body.state };
}
