import { timingSafeEqual } from "node:crypto";
import { log } from "../logger";
import type { SpeakAdapter, SpeakService } from "./types";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 128 * 1024;
const BODY_READ_TIMEOUT_MS = 2_000;
const MAX_OUTSTANDING_SPEAKS = 8;

export interface ClaudeCodeHookAdapterOptions {
  port: number;
  token: string;
  bodyReadTimeoutMs?: number;
}

interface SpeakRequest {
  text: string;
  agent: string;
  skipSummary?: boolean;
}

class HookRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function loopbackHost(req: Request): boolean {
  const header = req.headers.get("host");
  if (!header) return false;
  try {
    const hostname = new URL(`http://${header}`).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function authorized(req: Request, expected: string): boolean {
  const value = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!value.startsWith(prefix)) return false;
  const supplied = Buffer.from(value.slice(prefix.length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function validToken(token: string): boolean {
  const bytes = Buffer.byteLength(token);
  return bytes >= 32 && bytes <= 256 && !/\s/.test(token);
}

function parseContentLength(req: Request): number | null {
  const raw = req.headers.get("content-length");
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) throw new HookRequestError(400, "Bad Request");
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) throw new HookRequestError(400, "Bad Request");
  return length;
}

async function readBoundedBody(req: Request, timeoutMs: number): Promise<Uint8Array> {
  const declared = parseContentLength(req);
  if (declared !== null && declared > MAX_BODY_BYTES) {
    throw new HookRequestError(413, "Payload Too Large");
  }
  if (!req.body) throw new HookRequestError(400, "Bad Request: JSON body required");

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  const deadline = Date.now() + timeoutMs;
  let total = 0;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new HookRequestError(408, "Request Timeout");

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new HookRequestError(408, "Request Timeout")),
          remaining,
        );
      });
      const result = await Promise.race([reader.read(), timeout]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (result.done) break;

      total += result.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        throw new HookRequestError(413, "Payload Too Large");
      }
      chunks.push(result.value);
    }
  } catch (error: unknown) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function errorResponse(error: unknown): Response {
  if (error instanceof HookRequestError) {
    const headers = error.status === 408 || error.status === 413
      ? { Connection: "close" }
      : undefined;
    return new Response(error.message, { status: error.status, headers });
  }
  return new Response("Bad Request: invalid JSON", { status: 400 });
}

export class ClaudeCodeHookAdapter implements SpeakAdapter {
  readonly name = "claude-code-hook";
  private server: ReturnType<typeof Bun.serve> | null = null;
  private service: SpeakService | null = null;
  private readonly queue: SpeakRequest[] = [];
  private draining = false;

  constructor(private opts: ClaudeCodeHookAdapterOptions) {
    if (!validToken(opts.token)) {
      throw new Error("Claude Code hook token must be 32-256 bytes without whitespace");
    }
    if (opts.bodyReadTimeoutMs !== undefined
      && (!Number.isInteger(opts.bodyReadTimeoutMs) || opts.bodyReadTimeoutMs < 1)) {
      throw new Error("Claude Code hook body timeout must be a positive integer");
    }
  }

  async attach(service: SpeakService): Promise<void> {
    try {
      this.service = service;
      this.server = Bun.serve({
        port: this.opts.port,
        hostname: "127.0.0.1",
        maxRequestBodySize: MAX_BODY_BYTES,
        fetch: (req) => this.handle(req).catch((error: unknown) => {
          log("warn", `hook request failed: ${error instanceof Error ? error.message : String(error)}`);
          return new Response("Internal Server Error", { status: 500 });
        }),
      });
      log("ok", `Agent hook adapter listening on http://127.0.0.1:${this.opts.port}/speak`);
    } catch (error: unknown) {
      this.server = null;
      this.service = null;
      throw error;
    }
  }

  async detach(): Promise<void> {
    try {
      this.server?.stop(true);
    } finally {
      this.server = null;
      this.queue.length = 0;
      this.service = null;
    }
  }

  health(): Promise<{ ok: boolean; reason?: string }> {
    return Promise.resolve(this.server === null
      ? { ok: false, reason: "adapter not attached" }
      : { ok: true });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/speak") return new Response("Not Found", { status: 404 });
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    if (!this.service) return new Response("Service Unavailable", { status: 503 });
    if (!loopbackHost(req) || req.headers.has("origin")) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!authorized(req, this.opts.token)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
      });
    }
    const mediaType = (req.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      return new Response("Unsupported Media Type", { status: 415 });
    }

    let body: { text?: unknown; last_assistant_message?: unknown; agent?: unknown; skipSummary?: unknown };
    try {
      const bytes = await readBoundedBody(req, this.opts.bodyReadTimeoutMs ?? BODY_READ_TIMEOUT_MS);
      const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed: unknown = JSON.parse(json);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new HookRequestError(400, "Bad Request: JSON object required");
      }
      body = parsed as typeof body;
    } catch (error: unknown) {
      return errorResponse(error);
    }

    const text = typeof body.text === "string" && body.text.length > 0
      ? body.text
      : typeof body.last_assistant_message === "string" && body.last_assistant_message.length > 0
        ? body.last_assistant_message
        : null;

    if (text === null) {
      return new Response("Bad Request: 'text' or 'last_assistant_message' field required", { status: 400 });
    }
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
      return new Response("Payload Too Large", {
        status: 413,
        headers: { Connection: "close" },
      });
    }

    const skipSummary = body.skipSummary === true ? true : undefined;
    const agent = body.agent === "codex" ? "codex" : "claude-code";
    const outstanding = this.queue.length + (this.draining ? 1 : 0);
    if (outstanding >= MAX_OUTSTANDING_SPEAKS) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "1" },
      });
    }

    this.queue.push({ text, agent, skipSummary });
    void this.drainQueue().catch((error: unknown) => {
      log("warn", `hook queue failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    return new Response("Accepted", {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const request = this.queue.shift();
        const service = this.service;
        if (!request || !service) break;
        try {
          await service.speak(request);
        } catch (error: unknown) {
          log("warn", `speak failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
