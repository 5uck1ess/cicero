import { unlink } from "node:fs/promises";
import { readRequestJsonLimited, RequestBodyTooLargeError } from "./http-request-body";
import { readPrivateJson, writePrivateJson } from "./platform/private-json";
import { ciceroPath } from "./platform/paths";

const CONTROL_VERSION = 1 as const;
const MAX_CONTROL_BODY_BYTES = 4_096;
const CONTROL_TIMEOUT_MS = 120_000;

export type SwapRole = "stt" | "tts";
export interface SwapRequest { role: SwapRole; backend: string; model?: string }
export interface SwapResult { role: SwapRole; backend: string; model?: string; status: "active" }

export interface RuntimeControlDescriptor {
  version: typeof CONTROL_VERSION;
  url: string;
  token: string;
  pid: number;
}

export interface RuntimeControlHandle {
  readonly url: string;
  stop(): Promise<void>;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

export interface RuntimeControlOptions {
  token: string;
  pid?: number;
  descriptorPath?: string;
  /** Bound on waiting for an in-flight swap to drain at stop(). Injectable for tests. */
  drainTimeoutMs?: number;
  onSwap(request: SwapRequest): Promise<SwapResult>;
}

function isSwapRequest(value: unknown): value is SwapRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (input.role === "stt" || input.role === "tts")
    && typeof input.backend === "string"
    && input.backend.length > 0
    && input.backend.length <= 100
    && (input.model === undefined || (typeof input.model === "string" && input.model.length > 0 && input.model.length <= 1_000));
}

export async function startRuntimeControl(options: RuntimeControlOptions): Promise<RuntimeControlHandle> {
  const descriptorPath = options.descriptorPath ?? ciceroPath("runtime-control.json");
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  let accepting = true;
  let swapRunning = false;
  const active = new Set<Promise<unknown>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (!accepting) return Response.json({ ok: false, error: "daemon shutting down" }, { status: 503 });
      if (request.headers.get("authorization") !== `Bearer ${options.token}`) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/swap") return new Response("Not Found", { status: 404 });
      let resolveTracked!: () => void;
      const tracked = new Promise<void>((resolve) => { resolveTracked = resolve; });
      active.add(tracked);
      try {
        let body: unknown;
        try {
          body = await readRequestJsonLimited(request, {
            maxBytes: MAX_CONTROL_BODY_BYTES,
            timeoutMs: 5_000,
            signal: request.signal,
          });
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof RequestBodyTooLargeError ? "control request too large" : "invalid control request" },
            { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
          );
        }
        if (!isSwapRequest(body)) {
          return Response.json({ ok: false, error: "role must be stt|tts and backend/model must be non-empty strings" }, { status: 400 });
        }
        if (swapRunning) {
          return Response.json({ ok: false, error: "another provider swap is already in progress" }, { status: 409 });
        }
        swapRunning = true;
        try {
          const result = await options.onSwap(body);
          return Response.json({ ok: true, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = /already in progress/.test(message) ? 409 : 422;
          return Response.json({ ok: false, error: message }, { status });
        } finally {
          swapRunning = false;
        }
      } finally {
        active.delete(tracked);
        resolveTracked();
      }
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    await writePrivateJson(descriptorPath, {
      version: CONTROL_VERSION,
      url,
      token: options.token,
      pid: options.pid ?? process.pid,
    } satisfies RuntimeControlDescriptor);
  } catch (error) {
    await server.stop(true);
    throw error;
  }
  let stopPromise: Promise<void> | null = null;
  return {
    url,
    stop() {
      if (stopPromise) return stopPromise;
      accepting = false; // revoke admission synchronously — no new swap is accepted
      stopPromise = (async () => {
        // Wait for an in-flight swap to drain, but bound it. On timeout we must
        // still RELEASE the owned socket and descriptor before surfacing the
        // error, or a slow/hung swap would strand the control server and leave a
        // descriptor pointing at a daemon that is already tearing down. Provider
        // teardown (the slot's own bounded stop) reaps whatever the swap left.
        let drainError: unknown;
        try {
          await Promise.race([
            Promise.all([...active]).then(() => undefined),
            Bun.sleep(drainTimeoutMs).then(() => { throw new Error(`runtime controls did not drain within ${drainTimeoutMs}ms`); }),
          ]);
        } catch (error) {
          drainError = error;
        }
        await server.stop(true);
        await unlink(descriptorPath).catch(() => {});
        if (drainError) throw drainError;
      })().catch((error) => {
        // Resources are released above; keep the latch retryable so a later stop()
        // can re-observe a since-drained swap without a daemon restart.
        stopPromise = null;
        throw error;
      });
      return stopPromise;
    },
  };
}

function isDescriptor(value: unknown): value is RuntimeControlDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === CONTROL_VERSION
    && typeof record.url === "string"
    && /^http:\/\/127\.0\.0\.1:\d+$/.test(record.url)
    && typeof record.token === "string"
    && record.token.length > 0
    && typeof record.pid === "number";
}

export async function requestRuntimeSwap(
  request: SwapRequest,
  options: { descriptorPath?: string; timeoutMs?: number } = {},
): Promise<SwapResult> {
  const descriptorPath = options.descriptorPath ?? ciceroPath("runtime-control.json");
  const raw = await readPrivateJson(descriptorPath, 4_096);
  if (!isDescriptor(raw)) throw new Error("Cicero daemon runtime control is unavailable; is the daemon running?");
  const response = await fetch(`${raw.url}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${raw.token}` },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(options.timeoutMs ?? CONTROL_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string } & Partial<SwapResult>;
  if (!response.ok || !body.ok) throw new Error(body.error ?? `runtime control returned HTTP ${response.status}`);
  if (body.role !== request.role || body.backend !== request.backend || body.status !== "active") {
    throw new Error("runtime control returned an invalid swap response");
  }
  return {
    role: body.role,
    backend: body.backend,
    ...(body.model ? { model: body.model } : {}),
    status: body.status,
  } as SwapResult;
}
