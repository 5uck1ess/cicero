import { setTimeout, clearTimeout } from "node:timers";
import type { BoardPreset } from "./board-presets";
import { log } from "../logger";

export interface BoardRealtimeConfig {
  /** Server origin; credentials are never accepted in URLs. */
  server_url: string;
  /** Multica workspace UUID or Paperclip company UUID; match the CLI's scope. */
  scope_id: string;
  /** Environment variable containing a Multica PAT/JWT or Paperclip agent API key. */
  token_env: string;
}

export interface BoardFeed {
  start(changed: () => void, connected: (ready: boolean) => void): void;
  stop(): void;
}

/** Minimal injected socket boundary. terminate must synchronously release the socket. */
export interface BoardSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  terminate(): void;
}

type Timer = ReturnType<typeof setTimeout> | number;
export interface BoardRealtimeDependencies {
  socket?: (url: string, headers: Record<string, string>) => BoardSocket;
  token?: () => string | undefined;
  setTimeout?: (fn: () => void, ms: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
}

/** Validate without including provider-supplied strings in errors. */
export function validRealtimeConfig(value: unknown): value is BoardRealtimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (Object.keys(c).some((k) => !["server_url", "scope_id", "token_env"].includes(k))) return false;
  if (typeof c.scope_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(c.scope_id)
    || typeof c.token_env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(c.token_env)
    || typeof c.server_url !== "string" || c.server_url.length > 2048) return false;
  try {
    const url = new URL(c.server_url);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === "/";
  } catch { return false; }
}

/** Optional per-preset invalidation feed. Payloads never enter the task cache. */
export function createBoardRealtime(
  preset: BoardPreset | undefined,
  config: BoardRealtimeConfig | undefined,
  deps: BoardRealtimeDependencies = {},
): BoardFeed | undefined {
  if (!config) return undefined;
  if ((preset !== "multica" && preset !== "paperclip") || !validRealtimeConfig(config)) {
    throw new Error("invalid kanban realtime configuration");
  }
  const url = new URL(config.server_url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = preset === "multica" ? "/ws" : `/api/companies/${config.scope_id}/events/ws`;
  if (preset === "multica") url.searchParams.set("workspace_id", config.scope_id);
  // Bun's client extensions are not declared by the DOM WebSocket interface.
  const BunSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => BoardSocket;
  const makeSocket = deps.socket ?? ((address, headers) => new BunSocket(address, { headers }));
  const later = deps.setTimeout ?? setTimeout;
  const cancel = deps.clearTimeout ?? clearTimeout;
  let running = false;
  let socket: BoardSocket | undefined;
  let retry: Timer | undefined;
  let deadline: Timer | undefined;
  let stable: Timer | undefined;
  let backoff = 1_000;
  let changed = () => {};
  let connected = (_ready: boolean) => {};

  const release = () => {
    if (deadline !== undefined) cancel(deadline);
    if (stable !== undefined) cancel(stable);
    deadline = stable = undefined;
    const old = socket;
    socket = undefined;
    if (old) {
      old.onopen = old.onmessage = old.onerror = old.onclose = null;
      old.terminate();
    }
  };
  const failed = () => {
    release();
    if (!running || retry !== undefined) return;
    connected(false);
    // Never log socket errors, frame bodies, URLs or authentication material.
    log("warn", "kanban watch: realtime unavailable; using polling");
    retry = later(() => { retry = undefined; connect(); }, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
  const connect = () => {
    if (!running) return;
    const token = (deps.token ?? (() => process.env[config.token_env]))();
    if (!token || token.length > 16_384 || /[\r\n]/.test(token)) { failed(); return; }
    let current: BoardSocket;
    try {
      current = makeSocket(url.toString(), preset === "paperclip" ? { Authorization: `Bearer ${token}` } : {});
      socket = current;
    } catch { failed(); return; }
    let ready = false;
    const isCurrent = () => running && socket === current;
    const markReady = () => {
      if (ready) return;
      ready = true;
      if (deadline !== undefined) cancel(deadline);
      // Periodic socket renewal bounds silent/half-open connections even when
      // a proxy loses close frames. CLI reconciliation remains authoritative.
      deadline = later(failed, 5 * 60_000);
      stable = later(() => { stable = undefined; backoff = 1_000; }, 60_000);
      connected(true); // Includes a catch-up read on EVERY successful reconnect.
    };
    deadline = later(failed, 10_000); // Includes first-message authentication.
    current.onopen = () => {
      if (!isCurrent()) return;
      if (preset === "paperclip") markReady();
      else {
        try { current.send(JSON.stringify({ type: "auth", payload: { token } })); }
        catch { failed(); }
      }
    };
    current.onmessage = ({ data }) => {
      if (!isCurrent()) return;
      if (typeof data !== "string" || data.length > 64 * 1024) { failed(); return; }
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        event = parsed as Record<string, unknown>;
      } catch { return; }
      if (preset === "multica" && !ready) {
        if (event.type === "auth_ack") markReady();
        else if (event.error || event.type === "auth_error") failed();
        return;
      }
      if (!ready || typeof event.type !== "string") return;
      if (preset === "multica") {
        if (event.workspace_id !== undefined && event.workspace_id !== config.scope_id) return;
        if (event.type.startsWith("issue:")) changed();
      } else if (event.companyId === config.scope_id && event.type === "activity.logged") {
        changed();
      }
    };
    current.onerror = current.onclose = () => { if (isCurrent()) failed(); };
  };
  return {
    start(onChanged, onConnected) {
      if (running) return;
      running = true;
      changed = onChanged;
      connected = onConnected;
      connect();
    },
    stop() {
      running = false;
      if (retry !== undefined) cancel(retry);
      retry = undefined;
      release();
      backoff = 1_000;
    },
  };
}
