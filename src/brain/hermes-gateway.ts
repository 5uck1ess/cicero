import type { Brain, BrainTurnOptions } from "../types";
import { log } from "../logger";
import { BrainTurnContext } from "./turn-context";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_GATEWAY_FRAME_BYTES = 4 * 1024 * 1024;
const UTF8 = new TextEncoder();

type GatewayFrame = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message?: string };
  params?: {
    type?: string;
    session_id?: string;
    payload?: Record<string, unknown>;
  };
};

type ActiveSession = {
  id: string;
  session_key?: string;
  title?: string;
  status?: string;
};

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ActiveTurn = {
  sessionId: string;
  queue: TextQueue;
  sawDelta: boolean;
};

type TurnWaiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export interface HermesGatewayBrainConfig {
  /** Hermes `serve`/dashboard JSON-RPC WebSocket URL, including its credential. */
  url: string;
  /** Exact live-session title, durable session key, or gateway-local live id. */
  session: string;
  autoApproveTools?: boolean;
  connectTimeoutMs?: number;
  turnTimeoutMs?: number;
  maxResponseBytes?: number;
  socketFactory?: (url: string) => WebSocket;
}

class TextQueue {
  private chunks: Array<string | null> = [];
  private wake: (() => void) | null = null;
  private ended = false;
  private error: Error | null = null;
  private bytes = 0;

  constructor(private readonly limitBytes: number) {}

  push(text: string): void {
    if (this.ended || !text) return;
    const bytes = UTF8.encode(text).byteLength;
    if (bytes > this.limitBytes - this.bytes) {
      this.end(new Error(`Hermes gateway stream queue exceeded ${this.limitBytes} bytes`));
      return;
    }
    this.chunks.push(text);
    this.bytes += bytes;
    this.signal();
  }

  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.error = error ?? null;
    this.signal();
  }

  async *drain(): AsyncGenerator<string> {
    while (true) {
      while (this.chunks.length > 0) {
        const chunk = this.chunks.shift();
        if (chunk) {
          this.bytes -= UTF8.encode(chunk).byteLength;
          yield chunk;
        }
      }
      if (this.ended) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(): Error {
  return new DOMException("Aborted", "AbortError");
}

function validateGatewayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("brain.gateway_url must be a valid WebSocket URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("brain.gateway_url must use ws:// or wss://");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (url.protocol === "ws:" && !loopback.has(url.hostname)) {
    throw new Error("brain.gateway_url must use wss:// outside the local machine");
  }
  return url.toString();
}

/** Drive an already-live Hermes TUI Gateway session without creating an agent. */
export class HermesGatewayBrain implements Brain {
  private readonly url: string;
  private readonly selector: string;
  private readonly autoApproveTools: boolean;
  private readonly connectTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly socketFactory: (url: string) => WebSocket;
  private readonly turnContext = new BrainTurnContext();
  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  private nextRequestId = 0;
  private readonly pending = new Map<number, PendingRpc>();
  private activeTurn: ActiveTurn | null = null;
  private turnHeld = false;
  private readonly turnWaiters: TurnWaiter[] = [];

  constructor(config: HermesGatewayBrainConfig) {
    this.url = validateGatewayUrl(config.url);
    this.selector = config.session.trim();
    if (!this.selector) throw new Error("brain.session is required for hermes-gateway");
    this.autoApproveTools = config.autoApproveTools ?? false;
    this.connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.turnTimeoutMs = config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.socketFactory = config.socketFactory ?? ((url) => new WebSocket(url));
  }

  async start(): Promise<void> {
    await this.ensureAttached();
    log("info", `Brain (hermes-gateway) attached to live session '${this.selector}'`);
  }

  async stop(): Promise<void> {
    const turn = this.activeTurn;
    if (turn) await this.interrupt();
    this.activeTurn = null;
    turn?.queue.end(new Error("Hermes gateway stopped"));
    this.rejectPending(new Error("Hermes gateway stopped"));
    this.rejectTurnWaiters(new Error("Hermes gateway stopped"));
    const socket = this.socket;
    this.socket = null;
    this.sessionId = null;
    socket?.close();
  }

  async send(message: string, options?: BrainTurnOptions): Promise<string> {
    let output = "";
    let bytes = 0;
    for await (const chunk of this.sendStream(message, options)) {
      bytes += UTF8.encode(chunk).byteLength;
      if (bytes > this.maxResponseBytes) {
        await this.interrupt();
        throw new Error(`Hermes gateway response exceeded ${this.maxResponseBytes} bytes`);
      }
      output += chunk;
    }
    return output.trim();
  }

  async *sendStream(message: string, options?: BrainTurnOptions): AsyncGenerator<string> {
    const release = await this.reserveTurn(options?.signal);
    const queue = new TextQueue(this.maxResponseBytes);
    let abortListener: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const live = await this.ensureAttached();
      if (options?.signal?.aborted) throw abortError();
      if (live.status === "working" || live.status === "waiting") {
        throw new Error(`Hermes live session '${this.selector}' is ${live.status}`);
      }
      const sessionId = this.sessionId!;
      this.activeTurn = { sessionId, queue, sawDelta: false };

      abortListener = () => {
        queue.end(abortError());
        void this.interrupt();
      };
      options?.signal?.addEventListener("abort", abortListener, { once: true });
      timeout = setTimeout(() => {
        queue.end(new Error(`Hermes gateway turn timed out after ${this.turnTimeoutMs}ms`));
        void this.interrupt();
      }, this.turnTimeoutMs);

      const prompt = this.turnContext.buildTextPrompt(message, false);
      const accepted = await this.request<{ status?: string }>("prompt.submit", {
        session_id: sessionId,
        text: prompt,
      });
      if (accepted.status === "queued") {
        await this.interrupt();
        throw new Error("Hermes live session became busy before the voice turn started");
      }

      for await (const chunk of queue.drain()) yield chunk;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new Error(`hermes-gateway brain turn failed: ${asError(error).message}`, { cause: error });
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener) options?.signal?.removeEventListener("abort", abortListener);
      if (this.activeTurn?.queue === queue) this.activeTurn = null;
      release();
    }
  }

  injectContext(context: string): void {
    this.turnContext.inject(context);
  }

  async restart(): Promise<void> {
    this.turnContext.clear();
    await this.stop();
    await this.start();
  }

  async health(): Promise<boolean> {
    try {
      await this.ensureAttached();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureAttached(): Promise<ActiveSession> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) await this.connect();
    const result = await this.request<{ sessions?: ActiveSession[] }>("session.active_list");
    const sessions = result.sessions ?? [];
    if (this.sessionId) {
      const attached = sessions.find((session) => session.id === this.sessionId);
      if (attached) return attached;
      this.sessionId = null;
    }
    const selected = this.selectSession(sessions);
    await this.request("session.activate", { session_id: selected.id });
    this.sessionId = selected.id;
    return selected;
  }

  private selectSession(sessions: ActiveSession[]): ActiveSession {
    const exact = sessions.filter((session) =>
      session.id === this.selector
      || session.session_key === this.selector
      || session.title === this.selector);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw new Error(`multiple live Hermes sessions match '${this.selector}'`);

    const folded = this.selector.toLocaleLowerCase();
    const insensitive = sessions.filter((session) => session.title?.toLocaleLowerCase() === folded);
    if (insensitive.length === 1) return insensitive[0];
    const available = sessions
      .map((session) => session.title || session.session_key || session.id)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `live Hermes session '${this.selector}' was not found`
      + (available ? `; active sessions: ${available}` : "; no sessions are active in that gateway"),
    );
  }

  private async connect(): Promise<void> {
    this.rejectPending(new Error("Hermes gateway reconnecting"));
    this.socket?.close();
    this.sessionId = null;
    const socket = this.socketFactory(this.url);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.sessionId = null;
      const error = new Error("Hermes gateway connection closed");
      this.rejectPending(error);
      this.activeTurn?.queue.end(error);
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error("Hermes gateway connection timed out")), this.connectTimeoutMs);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        if (error) reject(error); else resolve();
      };
      const onOpen = () => finish();
      const onError = () => finish(new Error("Hermes gateway connection failed"));
      const onClose = () => finish(new Error("Hermes gateway connection closed during startup"));
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener("close", onClose, { once: true });
    });
  }

  private request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Hermes gateway is not connected"));
    }
    const id = ++this.nextRequestId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermes gateway request timed out: ${method}`));
      }, this.connectTimeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  private onMessage(raw: unknown): void {
    let frame: GatewayFrame;
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
      const frameBytes = typeof raw === "string" ? UTF8.encode(raw).byteLength : (raw as ArrayBuffer).byteLength;
      if (frameBytes > MAX_GATEWAY_FRAME_BYTES) {
        this.activeTurn?.queue.end(new Error(`Hermes gateway frame exceeded ${MAX_GATEWAY_FRAME_BYTES} bytes`));
        this.socket?.close();
        return;
      }
      frame = JSON.parse(text) as GatewayFrame;
    } catch {
      return;
    }
    if (frame.id !== undefined) {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.error) pending.reject(new Error(frame.error.message || "Hermes gateway request failed"));
      else pending.resolve(frame.result);
      return;
    }
    if (frame.method !== "event" || !frame.params?.type) return;
    const event = frame.params;
    const turn = this.activeTurn;
    if (!turn || event.session_id !== turn.sessionId) return;
    const payload = event.payload ?? {};
    if (event.type === "message.delta") {
      turn.sawDelta = true;
      turn.queue.push(String(payload.text ?? ""));
    } else if (event.type === "message.complete") {
      const status = String(payload.status ?? "complete");
      if (status === "error") turn.queue.end(new Error(String(payload.text ?? "Hermes turn failed")));
      else if (status === "interrupted") turn.queue.end(new Error("Hermes turn was interrupted"));
      else {
        if (!turn.sawDelta) turn.queue.push(String(payload.text ?? ""));
        turn.queue.end();
      }
    } else if (event.type === "error") {
      turn.queue.end(new Error(String(payload.message ?? "Hermes gateway turn failed")));
    } else if (event.type === "approval.request") {
      void this.request("approval.respond", {
        session_id: turn.sessionId,
        choice: this.autoApproveTools ? "once" : "deny",
      }).catch((error) => turn.queue.end(asError(error)));
    } else if (event.type === "clarify.request" || event.type === "sudo.request" || event.type === "secret.request") {
      turn.queue.end(new Error(`Hermes requested interactive input (${event.type}) that Cicero cannot collect in-band`));
      void this.interrupt();
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async interrupt(): Promise<void> {
    if (!this.sessionId || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    await this.request("session.interrupt", { session_id: this.sessionId }).catch(() => undefined);
  }

  private async reserveTurn(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    if (!this.turnHeld) {
      this.turnHeld = true;
      return this.turnRelease();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: TurnWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.turnWaiters.indexOf(waiter);
          if (index >= 0) this.turnWaiters.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.turnWaiters.push(waiter);
    });
  }

  private turnRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.turnWaiters.length > 0) {
        const waiter = this.turnWaiters.shift()!;
        if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
        if (waiter.signal?.aborted) {
          waiter.reject(abortError());
          continue;
        }
        waiter.resolve(this.turnRelease());
        return;
      }
      this.turnHeld = false;
    };
  }

  private rejectTurnWaiters(error: Error): void {
    for (const waiter of this.turnWaiters.splice(0)) {
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
  }
}
