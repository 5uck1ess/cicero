import {
  PROVIDER_TIMEOUT_MS,
  providerSignal,
  readBoundedJson,
  readErrorDetail,
  requestTimeout,
} from "../backends/http-transfer";
import {
  MAX_NOTIFY_JSON_BYTES,
  MAX_NOTIFY_TEXT_CHARS,
} from "../web-voice/protocol";

const MAX_NOTIFY_RESPONSE_BYTES = 4 * 1024;

export interface NotifyRequest {
  scheme: "http" | "https";
  port: number;
  token: string;
  text: string;
  timeoutMs?: number;
}

export interface NotifyResult {
  delivered: number;
  parked: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function sendWebVoiceNotification(
  request: NotifyRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<NotifyResult> {
  const text = request.text.trim();
  if (!text) throw new Error("notification text is empty");
  if (text.length > MAX_NOTIFY_TEXT_CHARS) {
    throw new RangeError(`notification text exceeds ${MAX_NOTIFY_TEXT_CHARS} characters`);
  }
  const body = JSON.stringify({ text });
  if (new TextEncoder().encode(body).byteLength > MAX_NOTIFY_JSON_BYTES) {
    throw new RangeError(`notification JSON exceeds ${MAX_NOTIFY_JSON_BYTES} bytes`);
  }

  const timeoutMs = requestTimeout(request.timeoutMs, PROVIDER_TIMEOUT_MS.tts);
  const response = await fetchImpl(
    `${request.scheme}://127.0.0.1:${request.port}/api/notify`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${request.token}`,
      },
      body,
      redirect: "error",
      signal: providerSignal(timeoutMs),
      // The daemon's LAN certificate is self-signed; this request never leaves
      // loopback and redirects are disabled above.
      tls: { rejectUnauthorized: false },
    },
  );
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(`notify failed: ${response.status}${detail ? ` ${detail}` : ""}`);
  }

  const payload = await readBoundedJson<unknown>(
    response,
    MAX_NOTIFY_RESPONSE_BYTES,
    "notify response",
  );
  if (
    !isRecord(payload)
    || typeof payload.delivered !== "number"
    || !Number.isSafeInteger(payload.delivered)
    || payload.delivered < 0
    || (payload.parked !== undefined && typeof payload.parked !== "boolean")
  ) {
    throw new Error("notify response has an invalid delivery result");
  }
  return {
    delivered: payload.delivered,
    parked: payload.parked === true,
  };
}
