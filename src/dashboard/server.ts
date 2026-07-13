import { dashBus } from "./bus";
import { log } from "../logger";
import { presentedToken, tokenMatches } from "../http-auth";
import {
  RequestBodyAbortedError,
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
  readRequestJsonLimited,
} from "../http-request-body";

export interface DashboardHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

/** What the dashboard's voice button can ask the daemon to do. */
export type VoiceControlAction = "toggle" | "activate" | "deactivate";

export interface DashboardOptions {
  port: number;
  /** Per-process secret used only by the served page and its event socket. */
  token: string;
  /** Invoked when the dashboard requests a voice-mode change (the toggle button). */
  onControl?: (action: VoiceControlAction) => void | Promise<void>;
  /** Test/embedder override for bounded control-handler drain during stop. */
  shutdownDrainTimeoutMs?: number;
  /** Test/embedder override for the absolute control-body read deadline. */
  bodyReadTimeoutMs?: number;
}

interface DashboardWsData {
  authenticated: true;
  pendingClientSlot: boolean;
}

const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_BODY_READ_TIMEOUT_MS = 5_000;
export const MAX_DASHBOARD_CONTROL_JSON_BYTES = 1_024;
export const MAX_DASHBOARD_WS_PAYLOAD_BYTES = 1_024;
export const MAX_CONCURRENT_DASHBOARD_CONTROLS = 8;
export const MAX_DASHBOARD_CLIENTS = 8;

async function withinShutdownDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`dashboard control handlers did not drain within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("dashboard shutdown drain failed", { cause: error });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isVoiceControlAction(v: unknown): v is VoiceControlAction {
  return v === "toggle" || v === "activate" || v === "deactivate";
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Strip the port from a Host header value, handling bracketed IPv6 literals. */
function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith("[")) return hostHeader.slice(1, hostHeader.indexOf("]"));
  return hostHeader.split(":")[0] ?? "";
}

/** Reject cross-origin and DNS-rebound access to loopback-only dashboard surfaces. */
function isTrustedLocalRequest(req: Request): boolean {
  if (!LOOPBACK_HOSTS.has(hostnameOf(req.headers.get("host") ?? ""))) return false;

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (!LOOPBACK_HOSTS.has(new URL(origin).hostname)) return false;
    } catch {
      return false; // unparseable Origin → reject
    }
  }
  return true;
}

/**
 * The mic control adds a custom-header CSRF check to the local Host/Origin gate.
 * Browsers cannot set it cross-origin without a CORS preflight, which this server
 * never approves.
 */
function isTrustedControlRequest(req: Request): boolean {
  return req.headers.get("x-cicero-dashboard") === "1" && isTrustedLocalRequest(req);
}

/**
 * Start the localhost voice dashboard. Returns null (and logs a warning) if the
 * port is taken or the server can't bind — the daemon must keep running either way.
 */
export function startDashboard(opts: DashboardOptions): DashboardHandle | null {
  const { port, token, onControl } = opts;
  const configuredDrainTimeout = opts.shutdownDrainTimeoutMs;
  const shutdownDrainTimeoutMs = typeof configuredDrainTimeout === "number" && Number.isFinite(configuredDrainTimeout) && configuredDrainTimeout >= 1
    ? Math.floor(configuredDrainTimeout)
    : DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
  const configuredBodyTimeout = opts.bodyReadTimeoutMs;
  const bodyReadTimeoutMs = typeof configuredBodyTimeout === "number" && Number.isFinite(configuredBodyTimeout) && configuredBodyTimeout >= 1
    ? Math.floor(configuredBodyTimeout)
    : DEFAULT_BODY_READ_TIMEOUT_MS;
  const shutdownController = new AbortController();
  let accepting = true;
  let activeControls = 0;
  let resolveDrain: (() => void) | null = null;
  let drainPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let pendingClients = 0;
  const clients = new Set<import("bun").ServerWebSocket<DashboardWsData>>();
  const waitForDrain = (): Promise<void> => {
    if (activeControls === 0) return Promise.resolve();
    if (!drainPromise) drainPromise = new Promise<void>((resolve) => { resolveDrain = resolve; });
    return drainPromise;
  };
  const releaseControl = (): void => {
    activeControls = Math.max(0, activeControls - 1);
    if (activeControls === 0 && resolveDrain) {
      const resolve = resolveDrain;
      resolveDrain = null;
      drainPromise = null;
      resolve();
    }
  };
  try {
    const server = Bun.serve<DashboardWsData>({
      // Loopback only — never expose the control endpoint (or activity log) to
      // the LAN. Combined with the per-request trust check below this keeps the
      // mic-arming endpoint reachable only from this machine's own browser.
      hostname: "127.0.0.1",
      port,
      async fetch(req, srv) {
        const url = new URL(req.url);
        if (!accepting) {
          return Response.json(
            { ok: false, error: "dashboard shutting down" },
            { status: 503, headers: { Connection: "close", "Retry-After": "1" } },
          );
        }
        if (url.pathname === "/ws") {
          if (!isTrustedLocalRequest(req) || !tokenMatches(presentedToken(req, url), token)) {
            return new Response("Forbidden", { status: 403, headers: { Connection: "close" } });
          }
          if (clients.size + pendingClients >= MAX_DASHBOARD_CLIENTS) {
            return new Response("too many dashboard clients", {
              status: 429,
              headers: { Connection: "close", "Retry-After": "5" },
            });
          }
          pendingClients += 1;
          let upgraded = false;
          try {
            upgraded = srv.upgrade(req, { data: { authenticated: true, pendingClientSlot: true } });
          } finally {
            if (!upgraded) pendingClients = Math.max(0, pendingClients - 1);
          }
          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        // Control channel: the only way the read-only dashboard talks back to the
        // daemon. This can arm the mic, so it's gated against CSRF/DNS-rebinding.
        if (req.method === "POST" && url.pathname === "/api/voice") {
          if (!isTrustedControlRequest(req)) {
            return Response.json(
              { ok: false, error: "forbidden" },
              { status: 403, headers: { Connection: "close" } },
            );
          }
          if (activeControls >= MAX_CONCURRENT_DASHBOARD_CONTROLS) {
            return Response.json(
              { ok: false, error: "too many dashboard control requests" },
              { status: 429, headers: { Connection: "close", "Retry-After": "1" } },
            );
          }
          activeControls += 1;
          try {
            const signal = AbortSignal.any([shutdownController.signal, req.signal]);
            let body: unknown;
            try {
              body = await readRequestJsonLimited(req, {
                maxBytes: MAX_DASHBOARD_CONTROL_JSON_BYTES,
                timeoutMs: bodyReadTimeoutMs,
                signal,
              });
            } catch (error) {
              if (error instanceof RequestBodyTooLargeError) {
                return Response.json(
                  { ok: false, error: "dashboard control body too large" },
                  { status: 413, headers: { Connection: "close" } },
                );
              }
              if (error instanceof RequestBodyTimeoutError) {
                return Response.json(
                  { ok: false, error: "dashboard control body timed out" },
                  { status: 408, headers: { Connection: "close" } },
                );
              }
              if (error instanceof RequestBodyAbortedError) {
                return shutdownController.signal.aborted
                  ? Response.json(
                      { ok: false, error: "dashboard shutting down" },
                      { status: 503, headers: { Connection: "close", "Retry-After": "1" } },
                    )
                  : Response.json({ ok: false, error: "request aborted" }, { status: 499, headers: { Connection: "close" } });
              }
              return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
            }
            const action = body !== null && typeof body === "object" && !Array.isArray(body)
              ? (body as Record<string, unknown>).action
              : undefined;
            if (!isVoiceControlAction(action)) {
              return Response.json({ ok: false, error: "action must be toggle | activate | deactivate" }, { status: 400 });
            }
            if (!accepting || signal.aborted) {
              return Response.json(
                { ok: false, error: "dashboard shutting down" },
                { status: 503, headers: { Connection: "close", "Retry-After": "1" } },
              );
            }
            await onControl?.(action);
            if (signal.aborted) {
              return Response.json(
                { ok: false, error: "dashboard shutting down" },
                { status: 503, headers: { Connection: "close", "Retry-After": "1" } },
              );
            }
            return Response.json({ ok: true, voiceActive: dashBus.voiceActive });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log("warn", `Dashboard voice control failed: ${message}`);
            return Response.json({ ok: false, error: "voice control failed" }, { status: 500 });
          } finally {
            releaseControl();
          }
        }
        if (url.pathname === "/" || url.pathname === "/index.html") {
          if (!isTrustedLocalRequest(req)) return new Response("Forbidden", { status: 403 });
          return new Response(renderPage(token), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
              "Content-Security-Policy": "frame-ancestors 'none'",
              "X-Frame-Options": "DENY",
            },
          });
        }
        return new Response(
          "Not Found",
          { status: 404, headers: req.method === "GET" || req.method === "HEAD" ? undefined : { Connection: "close" } },
        );
      },
      websocket: {
        maxPayloadLength: MAX_DASHBOARD_WS_PAYLOAD_BYTES,
        open(ws) {
          if (ws.data.pendingClientSlot) {
            pendingClients = Math.max(0, pendingClients - 1);
            ws.data.pendingClientSlot = false;
          }
          if (!accepting) {
            ws.close(1012, "Server shutting down");
            return;
          }
          if (!ws.data.authenticated) {
            ws.close(1008, "Authentication required");
            return;
          }
          clients.add(ws);
          ws.subscribe("events");
          ws.send(JSON.stringify(dashBus.snapshot()));
        },
        message(ws) {
          ws.close(1008, "Dashboard WebSocket is read-only");
        },
        close(ws) {
          if (ws.data.pendingClientSlot) pendingClients = Math.max(0, pendingClients - 1);
          clients.delete(ws);
          try { ws.unsubscribe("events"); } catch { /* already gone */ }
        },
      },
    });

    const unsub = dashBus.subscribe((e) => {
      try { server.publish("events", JSON.stringify(e)); } catch { /* no clients */ }
    });

    const actualPort = server.port ?? port;
    const url = `http://127.0.0.1:${actualPort}`;
    let unsubscribed = false;
    let runtimeStopPromise: Promise<void> | null = null;
    const stopRuntime = (): Promise<void> => {
      if (runtimeStopPromise) return runtimeStopPromise;
      let task: Promise<void>;
      try {
        task = Promise.resolve(server.stop(true));
      } catch (error) {
        task = Promise.reject(error);
      }
      runtimeStopPromise = task;
      void task.catch((error: unknown) => {
        log("warn", `Dashboard listener stop failed: ${error instanceof Error ? error.message : String(error)}`);
        if (runtimeStopPromise === task) runtimeStopPromise = null;
      });
      return task;
    };
    const stopListener = (): Promise<void> => {
      const runtimeStop = stopRuntime();
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
      const bookkeepingFallback = new Promise<void>((resolve) => {
        fallbackTimer = setTimeout(resolve, 100);
      }).then(() => {
        if (server.pendingRequests === 0 && clients.size === 0 && activeControls === 0) return;
        return runtimeStop;
      });
      const attempt = Promise.race([runtimeStop, bookkeepingFallback]);
      void attempt.then(
        () => { if (fallbackTimer !== undefined) clearTimeout(fallbackTimer); },
        () => { if (fallbackTimer !== undefined) clearTimeout(fallbackTimer); },
      );
      return attempt;
    };
    const stop = (): Promise<void> => {
      if (stopPromise) return stopPromise;
      accepting = false;
      if (!shutdownController.signal.aborted) {
        shutdownController.abort(new Error("dashboard shutting down"));
      }
      pendingClients = 0;
      if (!unsubscribed) {
        unsubscribed = true;
        unsub();
      }
      for (const ws of clients) {
        try { ws.close(1012, "Server shutting down"); } catch { /* already closing */ }
        try {
          ws.terminate();
          // terminate() is the runtime's synchronous ownership handoff. Do not
          // make a later retry depend on Bun delivering an optional close event
          // for a socket that was already force-destroyed.
          clients.delete(ws);
        } catch { /* runtime still owns it; close callback/retry will confirm */ }
      }
      const attempt = withinShutdownDeadline(
        Promise.all([
          stopListener(),
          waitForDrain(),
        ]).then(() => undefined),
        shutdownDrainTimeoutMs,
      );
      stopPromise = attempt;
      void attempt.catch(() => {
        if (stopPromise === attempt) stopPromise = null;
      });
      return attempt;
    };
    return {
      port: actualPort,
      url,
      stop,
    };
  } catch (err: unknown) {
    log("warn", `Dashboard failed to start on :${port}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const DASHBOARD_TOKEN_MARKER = '"__CICERO_DASHBOARD_TOKEN__"';

function renderPage(token: string): string {
  return PAGE.replace(DASHBOARD_TOKEN_MARKER, JSON.stringify(token));
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cicero — Voice</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0b0e14; color: #c8d3e0; }
  header { padding: 18px 24px; border-bottom: 1px solid #1b2230; display: flex;
           align-items: center; gap: 16px; flex-wrap: wrap; }
  h1 { font-size: 16px; margin: 0; color: #e6edf3; letter-spacing: .5px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
  .chip { font-size: 12px; padding: 3px 9px; border-radius: 999px; background: #141a26;
          border: 1px solid #232c3d; color: #8aa0bd; }
  .chip b { color: #c8d3e0; font-weight: 600; }
  .conn { width: 9px; height: 9px; border-radius: 50%; background: #f25; transition: background .3s; }
  .conn.on { background: #3fb950; }
  main { display: flex; flex-direction: column; align-items: center; padding: 40px 20px 16px; }
  .pill { font-size: 30px; font-weight: 700; letter-spacing: 2px; padding: 22px 56px;
          border-radius: 18px; border: 2px solid #232c3d; background: #111722; color: #6b7c95;
          transition: all .25s; text-transform: uppercase; }
  .pill.listening { color: #3fb950; border-color: #2ea043; box-shadow: 0 0 0 0 #2ea04355; animation: pulse 1.4s infinite; }
  .pill.thinking  { color: #d29922; border-color: #bb8009; }
  .pill.speaking  { color: #58a6ff; border-color: #1f6feb; box-shadow: 0 0 24px #1f6feb33; }
  .pill.idle      { color: #6b7c95; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 #2ea04366; } 70% { box-shadow: 0 0 0 18px #2ea04300; } 100% { box-shadow: 0 0 0 0 #2ea04300; } }
  .sub { margin-top: 12px; color: #6b7c95; font-size: 13px; min-height: 18px; }
  .toggle { margin-top: 22px; font: inherit; font-size: 15px; font-weight: 600; cursor: pointer;
            padding: 12px 28px; border-radius: 12px; border: 1px solid #2ea043; background: #16241a;
            color: #3fb950; transition: all .2s; letter-spacing: .3px; }
  .toggle:hover { background: #1c3022; }
  .toggle:disabled { opacity: .5; cursor: default; }
  .toggle.on { border-color: #d4434b; background: #2a1618; color: #f85149; }
  .toggle.on:hover { background: #371b1d; }
  .log { width: min(900px, 100%); margin: 26px auto 40px; border: 1px solid #1b2230;
         border-radius: 12px; background: #0d1119; overflow: hidden; }
  .log h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #6b7c95;
            margin: 0; padding: 10px 16px; border-bottom: 1px solid #1b2230; }
  .rows { max-height: 52vh; overflow-y: auto; }
  .row { display: flex; gap: 10px; padding: 6px 16px; border-bottom: 1px solid #11161f; font-size: 13px; }
  .row:last-child { border-bottom: 0; }
  .row .t { color: #4a5568; flex: 0 0 70px; }
  .row .m { color: #aebdd0; white-space: pre-wrap; word-break: break-word; }
  .row.heard .m { color: #3fb950; font-weight: 600; }
  .row.say .m   { color: #58a6ff; }
  .row.err .m   { color: #f85149; }
  .empty { padding: 18px 16px; color: #4a5568; }
</style>
</head>
<body>
  <header>
    <span class="conn" id="conn"></span>
    <h1>CICERO · VOICE</h1>
    <div class="chips" id="chips"></div>
  </header>
  <main>
    <div class="pill idle" id="pill">IDLE</div>
    <div class="sub" id="sub">Type <b>voice</b> in the daemon to start listening.</div>
    <button id="toggle" class="toggle" type="button">Start listening</button>
  </main>
  <div class="log">
    <h2>Live activity</h2>
    <div class="rows" id="rows"><div class="empty">Waiting for events…</div></div>
  </div>
<script>
const pill = document.getElementById('pill');
const sub  = document.getElementById('sub');
const rows = document.getElementById('rows');
const chips = document.getElementById('chips');
const conn = document.getElementById('conn');
const toggle = document.getElementById('toggle');
const SUBTEXT = {
  idle: 'Idle — type "voice" in the daemon to start.',
  listening: 'Listening… speak now.',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
};
let cleared = false;

function setState(s) {
  if (!s) return;
  pill.className = 'pill ' + s;
  pill.textContent = s.toUpperCase();
  sub.textContent = SUBTEXT[s] || '';
}
function setVoiceActive(active) {
  const on = !!active;
  toggle.classList.toggle('on', on);
  toggle.textContent = on ? 'Stop listening' : 'Start listening';
}
toggle.addEventListener('click', async () => {
  toggle.disabled = true;
  try {
    await fetch('/api/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cicero-Dashboard': '1' },
      body: JSON.stringify({ action: 'toggle' }),
    });
  } catch (_) { /* daemon gone; the reconnect loop will recover state */ }
  toggle.disabled = false;
});
function time(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString('en-US', { hour12: false });
}
function addRow(e) {
  if (!cleared) { rows.innerHTML = ''; cleared = true; }
  const row = document.createElement('div');
  let cls = 'row', icon = e.icon || '•', msg = e.message || '';
  if (e.type === 'transcript') { cls += ' heard'; icon = '🎤'; msg = 'You: ' + e.text; }
  else if (e.type === 'response') { cls += ' say'; icon = '🗣'; msg = 'Cicero: ' + e.text; }
  else if ((e.message || '').startsWith('Heard:')) { cls += ' heard'; }
  else if (e.icon === '❌' || /error|fail/i.test(e.message || '')) { cls += ' err'; }
  else if (e.icon === '🔊') { cls += ' say'; }
  row.className = cls;
  row.innerHTML = '<span class="t"></span><span class="m"></span>';
  row.children[0].textContent = time(e.ts);
  row.children[1].textContent = icon + '  ' + msg;
  rows.appendChild(row);
  while (rows.children.length > 200) rows.removeChild(rows.firstChild);
  rows.scrollTop = rows.scrollHeight;
}
function setConfig(c) {
  if (!c) return;
  const items = [];
  if (c.brain)    items.push(['brain', c.brain]);
  if (c.model)    items.push(['model', String(c.model).split('/').pop()]);
  if (c.ttsVoice) items.push(['voice', c.ttsVoice]);
  if (c.ttsBackend) items.push(['tts', c.ttsBackend]);
  chips.replaceChildren();
  for (const [k, v] of items) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.append(k + ' ');
    const b = document.createElement('b');
    b.textContent = String(v);   // textContent — never inject config as HTML
    chip.appendChild(b);
    chips.appendChild(chip);
  }
}
function handle(e) {
  if (e.type === 'snapshot') {
    setState(e.state); setConfig(e.config); setVoiceActive(e.voiceActive);
    (e.history || []).forEach(addRow);
    return;
  }
  if (e.type === 'state')  setState(e.state);
  else if (e.type === 'voice') setVoiceActive(e.voiceActive);
  else if (e.type === 'config') setConfig(e.config);
  else addRow(e);
}
function connect() {
  const dashboardToken = "__CICERO_DASHBOARD_TOKEN__";
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?token=' + encodeURIComponent(dashboardToken));
  ws.onopen = () => { conn.classList.add('on'); };
  ws.onclose = () => { conn.classList.remove('on'); setTimeout(connect, 1200); };
  ws.onerror = () => { try { ws.close(); } catch (_) { /* already closing */ } };
  ws.onmessage = (ev) => { try { handle(JSON.parse(ev.data)); } catch (_) { /* ignore malformed frame */ } };
}
connect();
</script>
</body>
</html>`;
