import { unlink } from "node:fs/promises";
import { DEFAULT_CLEANUP_TIMEOUT_MS } from "./backends/hot-swap";
import { MANAGED_STARTUP_TIMEOUT_MS, PROVIDER_TIMEOUT_MS, readBoundedJson } from "./backends/http-transfer";
import { readRequestJsonLimited, RequestBodyTooLargeError } from "./http-request-body";
import { readPrivateJson, writePrivateJson } from "./platform/private-json";
import { ciceroPath } from "./platform/paths";

const CONTROL_VERSION = 1 as const;
const MAX_CONTROL_BODY_BYTES = 4_096;
const MAX_CONTROL_RESPONSE_BYTES = 4_096;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;
/**
 * The client must outlast a whole supported swap transaction, not just part of it:
 * aborting early prints a failure for a swap that goes on to commit, because the
 * abort is only honoured before persistence. Summed from the phases the swap
 * actually runs back to back, each already bounded elsewhere:
 *
 *   start()          MANAGED_STARTUP_TIMEOUT_MS   (cold managed candidate)
 *   warmup()         longest per-request provider deadline — a warmup is one
 *                    ordinary synthesis/transcription, so it is bounded by the
 *                    role's own budget, and the client cannot know which role
 *                    it will be
 *   health()         PROVIDER_TIMEOUT_MS.health
 *   cutover cleanup  DEFAULT_CLEANUP_TIMEOUT_MS   (retired generation drain)
 *
 * plus a margin for persistence (a config file write) and transport. Deriving it
 * this way is the point: the previous value was this constant plus a guessed 30s,
 * which a 290s start + 35s warmup + 2s health + 5s drain already overran.
 */
/**
 * `timeout_ms` is configurable per provider (up to 15 minutes), and a
 * same-backend swap carries the current selection's value onto the candidate —
 * so the warmup phase is bounded by the OPERATOR's number, not by the built-in
 * default. Computing the deadline from defaults alone meant a warmup that is
 * entirely legal under their own config (a remote vibevoice with
 * `timeout_ms: 600000` answering after 450s) outlived the client, which then
 * printed a failure for a swap that went on to commit — the exact lie this
 * deadline is derived to avoid. Callers that know the config pass its provider
 * timeouts in; the export below is the floor for callers that do not.
 */
export function controlTimeoutMs(configuredProviderTimeoutsMs: readonly number[] = []): number {
  const warmup = Math.max(
    PROVIDER_TIMEOUT_MS.tts,
    PROVIDER_TIMEOUT_MS.stt,
    ...configuredProviderTimeoutsMs.filter((value) => Number.isFinite(value) && value > 0),
  );
  return MANAGED_STARTUP_TIMEOUT_MS
    + warmup
    + PROVIDER_TIMEOUT_MS.health
    + DEFAULT_CLEANUP_TIMEOUT_MS
    + 30_000;
}

export const CONTROL_TIMEOUT_MS = controlTimeoutMs();
const MAX_CONTROL_ERROR_CHARS = 500;

/**
 * A swap failure message can carry a candidate provider's HTTP error body
 * verbatim, and `cicero swap` prints it straight to a terminal. Provider bodies
 * are untrusted: strip C0/C1 control characters (escape sequences survive JSON
 * transport intact and would otherwise execute as terminal commands) and bound
 * the length before it is returned, logged, or printed.
 */
function safeControlMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  const stripped = raw.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").trim();
  return stripped.length > MAX_CONTROL_ERROR_CHARS
    ? `${stripped.slice(0, MAX_CONTROL_ERROR_CHARS)}…`
    : stripped || "provider swap failed";
}

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
  /**
   * `signal` aborts when the client goes away. A swap must not commit for a
   * request nobody is listening to, or the operator is told it failed while the
   * config changed underneath them.
   */
  onSwap(request: SwapRequest, options?: { signal?: AbortSignal }): Promise<SwapResult>;
}

export function isSwapRequest(value: unknown): value is SwapRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (input.role === "stt" || input.role === "tts")
    && typeof input.backend === "string"
    && input.backend.length > 0
    && input.backend.length <= 100
    && !CONTROL_CHARACTERS.test(input.backend)
    && (input.model === undefined || (
      typeof input.model === "string"
      && input.model.length > 0
      && input.model.length <= 1_000
      && !CONTROL_CHARACTERS.test(input.model)
    ));
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
          const result = await options.onSwap(body, { signal: request.signal });
          return Response.json({ ok: true, ...result });
        } catch (error) {
          const message = safeControlMessage(error);
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
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all([...active]).then(() => undefined),
            // Own the timer so the common case (nothing in flight) can cancel it.
            // An uncancelled sleep keeps Bun's event loop alive for the whole
            // timeout and delays daemon exit by that long on every clean stop.
            new Promise<never>((_, reject) => {
              drainTimer = setTimeout(
                () => reject(new Error(`runtime controls did not drain within ${drainTimeoutMs}ms`)),
                drainTimeoutMs,
              );
            }),
          ]);
        } catch (error) {
          drainError = error;
        } finally {
          if (drainTimer !== undefined) clearTimeout(drainTimer);
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
  const body = await readBoundedJson<unknown>(
    response,
    MAX_CONTROL_RESPONSE_BYTES,
    "runtime control response",
  );
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  // Sanitize on receipt too: the daemon is trusted, but this is the last hop
  // before the string reaches a terminal, and the body is transport-shaped data.
  if (!response.ok || record?.ok !== true) {
    throw new Error(
      typeof record?.error === "string"
        ? safeControlMessage(record.error)
        : `runtime control returned HTTP ${response.status}`,
    );
  }
  const model = record?.model;
  if (
    !record
    || record.role !== request.role
    || record.backend !== request.backend
    || record.status !== "active"
    || (model !== undefined && (
      typeof model !== "string"
      || model.length === 0
      || model.length > 1_000
      || CONTROL_CHARACTERS.test(model)
    ))
  ) {
    throw new Error("runtime control returned an invalid swap response");
  }
  return {
    role: request.role,
    backend: request.backend,
    ...(typeof model === "string" ? { model } : {}),
    status: "active",
  };
}
