import { log } from "../logger";
import { presentedToken, tokenMatches } from "../http-auth";
import { PAGE } from "./page";
import { MANIFEST, ICON_SVG } from "./pwa";
import { VAD_ASSET_BY_NAME } from "./vad-assets";
import { join } from "node:path";
import type { WebTurnResult, WebReplySink } from "./turn";
import type { TlsMaterial } from "./tls";
import type { SpeculativeTurn, Speculator } from "./speculative";
import { isProbeFrame, decodeProbeFrame } from "./probe";
import { snapshotSynthesizedWav } from "../platform/wav";
import {
  RequestBodyAbortedError,
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
  readRequestBodyLimited,
  readRequestJsonLimited,
} from "../http-request-body";
import {
  MAX_TURN_AUDIO_BYTES,
  MAX_TURN_AUDIO_MS,
  MAX_WS_PAYLOAD_BYTES,
  MAX_WS_TEXT_BYTES,
  MAX_WEB_VOICE_CLIENTS,
  MAX_CONCURRENT_WEB_JOBS,
  MAX_NOTIFY_JSON_BYTES,
  MAX_CHAT_JSON_BYTES,
  MAX_HEALTH_JSON_BYTES,
  MAX_NOTIFY_TEXT_CHARS,
  MAX_CHAT_TEXT_CHARS,
  MAX_HEALTH_ROWS,
  decodeTurnAudioFrame,
  encodeTurnAudioFrame,
  inspectTurnAudio,
  isProtocolId,
} from "./protocol";

interface TurnState {
  turnId: string;
  aborted: boolean;
  controller: AbortController;
  signal: AbortSignal;
}

interface PendingTurn {
  turnId: string;
  input: ArrayBuffer | string;
}

interface SpecState {
  /** null is the protocol-v1 compatibility path, whose probe had no turn id. */
  turnId: string | null;
  turn: SpeculativeTurn;
}

/** Per-connection state for a streaming voice WebSocket. */
interface WsData {
  pendingClientSlot: boolean;
  sessionId: string;
  protocol: 1 | 2;
  busy: boolean;               // a turn is being processed right now
  // Latest input waiting to be processed (barge-in wins): a captured
  // utterance WAV, or a typed message ({type:"text"} control frame).
  pending: PendingTurn | null;
  current: TurnState | null;
  /** Recently accepted final turn ids, bounded to reject replay/duplicates. */
  recentTurnIds: string[];
  /** Latest v2 probe; invalidated when its final WAV arrives or a newer probe wins. */
  latestProbeTurnId: string | null;
  /** false = test-harness socket (?record=0); turns are not persisted to history. */
  record: boolean;
  /** In-flight speculative turn from the last confident "complete" probe (see speculative.ts). */
  spec: SpecState | null;
}

export interface WebVoiceServerOptions {
  /** Bind address. Default "0.0.0.0" so a headless box is reachable from a LAN browser. */
  host?: string;
  port: number;
  /** Shared secret required on every request (Authorization: Bearer, or ?token=). */
  token: string;
  /** TLS material for HTTPS; null serves plain HTTP (browser mic then works only from localhost). */
  tls?: TlsMaterial | null;
  /** Process one captured utterance (WAV) into a spoken reply (Phase 1 POST path). */
  onTurn: (wav: ArrayBuffer, options?: { signal?: AbortSignal; trackBackground?: (task: Promise<void>) => boolean }) => Promise<WebTurnResult>;
  /** Stream a captured utterance's reply over the WebSocket (Phase 2). Optional. */
  onStreamTurn?: (wav: ArrayBuffer, sink: WebReplySink, opts?: { record?: boolean; spec?: SpeculativeTurn | null; signal?: AbortSignal; trackBackground?: (task: Promise<void>) => boolean }) => Promise<void>;
  /** Stream a TYPED message's reply (same pipeline, no STT). Optional. */
  onTextTurn?: (text: string, sink: WebReplySink, opts?: { record?: boolean; signal?: AbortSignal; trackBackground?: (task: Promise<void>) => boolean }) => Promise<void>;
  /**
   * Render notification text to speech (proactive voice-back). When set, POST
   * /api/notify {text} renders the clip and pushes {type:"notify", text,
   * audioBase64} to every connected voice client — Cicero speaks up unprompted
   * ("PR #142 is up") instead of only answering. Optional.
   */
  onNotify?: (text: string, voice?: string, opts?: { urgent?: boolean; telegramMirror?: boolean; signal?: AbortSignal; skipRender?: boolean }) => Promise<ArrayBuffer | null>;
  /**
   * Render a notification clip with no fan-out — the lazy half of onNotify.
   * When nobody is connected, dispatchNotify asks onNotify to skip synthesis
   * (skipRender) and parks the TEXT; this hook renders at flush time, when a
   * client actually shows up to hear it. A notification that only ever gets
   * parked and expires must not cost a synthesis. Optional: without it,
   * onNotify always renders and the park stores audio, as before.
   */
  onNotifyRender?: (text: string, voice?: string, opts?: { signal?: AbortSignal }) => Promise<ArrayBuffer>;
  /**
   * A notification actually went out (broadcast to clients, or parked for the
   * next one — not deferred by quiet hours). The daemon uses this to hand the
   * text to the brain as one-shot turn context, so a follow-up that names no
   * topic ("call me", "what should we do about that?") lands on the right
   * subject. Fire-and-forget: a throw here must not fail the delivery.
   */
  onNotified?: (text: string, outcome: { delivered: number; parked: boolean }) => void | Promise<void>;
  /**
   * Render text to WAV with NO side effects (no broadcast, no Telegram, no
   * parking) — backs POST /api/say for callers that carry their own audio
   * channel. Deliberately separate from onNotify, which may fan out.
   */
  onSay?: (text: string, options?: { signal?: AbortSignal }) => Promise<ArrayBuffer>;
  /** Directory holding the speech-gate assets (Silero VAD + ort wasm); the
   * /vad/<name> routes 404 until ensureVadAssets has populated it. */
  vadDir?: string;
  /**
   * Plain text chat turn: full brain reply as text — no TTS, no TLDR gate, no
   * fillers. Backs POST /api/chat for text surfaces (the Telegram sidecar).
   */
  onChat?: (text: string, options?: { signal?: AbortSignal }) => Promise<string>;
  /**
   * Recent conversation turns to replay into a freshly connected client
   * ({type:"history", items}) so a page refresh doesn't wipe the chat log. Optional.
   */
  onHistory?: (options?: { signal?: AbortSignal }) => Promise<Array<{ t: number; user: string; reply: string }>>;
  /**
   * Health-record ingest (the phone bridge's door): rows are appended to
   * the health record. Returns how many were logged. Absent = 501.
   */
  onHealth?: (rows: Array<{ metric: string; value?: number; unit?: string; note?: string }>, options?: { signal?: AbortSignal }) => Promise<number>;
  /**
   * Semantic end-of-turn check for a mid-pause probe (see probe.ts). Returns
   * the model's verdict, or null when no detector is running — the client then
   * falls back to its plain silence hangover. When set, connected clients are
   * told {type:"probe_on"} so they start probing at all.
   */
  onTurnProbe?: (samples: Float32Array, sampleRate: number, options?: { signal?: AbortSignal }) => Promise<{ complete: boolean; probability: number } | null>;
  /**
   * Speculative turn factory (see speculative.ts): called after a confident
   * "complete" probe verdict with the probe's tail audio and the client's
   * reported utterance duration. Returns the in-flight speculation (handed to
   * onStreamTurn with the final WAV) or null when it declines. Optional.
   */
  onSpeculate?: Speculator;
  /**
   * Readiness of the complete daemon behind this transport. `/health` remains
   * process liveness; `/ready` returns 503 until this callback says it can take
   * turns. Omitted means the standalone server is ready once it is listening.
   */
  readiness?: (options?: { signal?: AbortSignal }) => boolean | { ready: boolean; reason?: string } | Promise<boolean | { ready: boolean; reason?: string }>;
  /** Test/embedder override for bounded active-job drain during stop. */
  shutdownDrainTimeoutMs?: number;
}

export interface WebVoiceHandle {
  scheme: "http" | "https";
  port: number;
  /** Connected voice clients right now (for status/logging). */
  clientCount: () => number;
  /**
   * Speak a notification through the same path as POST /api/notify (render,
   * broadcast, park when nobody's connected) — for in-process callers like the
   * kanban watcher. Resolves null when unavailable, saturated, or quiescing.
   */
  notify: (text: string, voice?: string, opts?: { urgent?: boolean; telegramMirror?: boolean }) => Promise<{ delivered: number; parked: boolean } | null>;
  /** Quiesce ingress, cancel owned work, close sockets, and drain handlers. */
  stop: () => Promise<void>;
}

function sendJson(ws: import("bun").ServerWebSocket<WsData>, value: unknown): void {
  try { ws.send(JSON.stringify(value)); } catch { /* socket closed */ }
}

function withSession(ws: import("bun").ServerWebSocket<WsData>, value: Record<string, unknown>): Record<string, unknown> {
  return ws.data.protocol === 2
    ? { ...value, sessionId: ws.data.sessionId, turnId: null }
    : value;
}

function withTurn(ws: import("bun").ServerWebSocket<WsData>, turnId: string, value: Record<string, unknown>): Record<string, unknown> {
  return ws.data.protocol === 2
    ? { ...value, sessionId: ws.data.sessionId, turnId }
    : value;
}

function protocolError(ws: import("bun").ServerWebSocket<WsData>, message: string, turnId?: string): void {
  sendJson(ws, turnId
    ? withTurn(ws, turnId, { type: "error", message })
    : withSession(ws, { type: "error", message }));
}

/** A {@link WebReplySink} scoped to exactly one connection and one turn. */
function makeSink(ws: import("bun").ServerWebSocket<WsData>, turn: TurnState): WebReplySink {
  const live = () => ws.data.current === turn && !turn.aborted && !turn.signal.aborted;
  const sendTurnJson = (o: Record<string, unknown>) => { if (live()) sendJson(ws, withTurn(ws, turn.turnId, o)); };
  return {
    transcript: (t) => sendTurnJson({ type: "transcript", text: t }),
    sentence: (t) => sendTurnJson({ type: "sentence", text: t }),
    audio: (buf) => {
      if (!live()) return;
      let audio: ArrayBuffer;
      try {
        audio = snapshotSynthesizedWav(buf, {
          maxBytes: MAX_TURN_AUDIO_BYTES,
          allowEmpty: true,
        }).audio;
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        sendTurnJson({ type: "error", message: `invalid synthesized audio: ${detail}` });
        return;
      }
      if (audio.byteLength === 0) return;
      try {
        ws.send(ws.data.protocol === 2
          ? encodeTurnAudioFrame(ws.data.sessionId, turn.turnId, audio)
          : audio);
      } catch { /* socket closed */ }
    },
    control: (m) => sendTurnJson(m),
    done: () => sendTurnJson({ type: "done" }),
    error: (m) => sendTurnJson({ type: "error", message: m }),
    aborted: () => !live(),
  };
}

function abortTurn(turn: TurnState | null, reason: string): void {
  if (!turn) return;
  turn.aborted = true;
  if (!turn.controller.signal.aborted) turn.controller.abort(new Error(reason));
}

const BODY_READ_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 95_000;
const MAX_BACKGROUND_WEB_JOBS = MAX_CONCURRENT_WEB_JOBS;
const MAX_VOICE_NAME_CHARS = 128;
const MAX_HEALTH_METRIC_CHARS = 128;
const MAX_HEALTH_UNIT_CHARS = 64;
const MAX_HEALTH_NOTE_CHARS = 4_096;

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
} as const;

async function withinShutdownDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`web-voice active jobs did not drain within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("web-voice shutdown drain failed", { cause: error });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function jsonReadError(err: unknown, shuttingDown: boolean): Response {
  // The body reader is deliberately cancelled at these boundaries. Closing
  // the HTTP/1.1 connection keeps unread chunk bytes from contaminating a
  // keep-alive request on runtimes that do not fully drain a cancelled body.
  if (err instanceof RequestBodyTooLargeError) {
    return Response.json({ error: "JSON body too large" }, { status: 413, headers: { Connection: "close" } });
  }
  if (err instanceof RequestBodyTimeoutError) {
    return Response.json({ error: "request body timed out" }, { status: 408, headers: { Connection: "close" } });
  }
  if (err instanceof RequestBodyAbortedError) {
    return shuttingDown
      ? Response.json({ error: "server shutting down" }, { status: 503, headers: { Connection: "close", "Retry-After": "1" } })
      : Response.json({ error: "request aborted" }, { status: 499, headers: { Connection: "close" } });
  }
  return Response.json({ error: "invalid JSON body" }, { status: 400 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestedId(req: Request, url: URL, header: string, query: string): string | null | undefined {
  const value = req.headers.get(header) ?? url.searchParams.get(query);
  if (value === null) return undefined;
  return isProtocolId(value) ? value : null;
}

/**
 * The browser audio client server: serves the voice page and accepts captured
 * utterances at POST /api/turn, returning the spoken reply. Separate from the
 * loopback-only monitor dashboard — this one binds the LAN and gates on a token,
 * because a headless box is driven from another machine's browser.
 */
export function startWebVoiceServer(opts: WebVoiceServerOptions): WebVoiceHandle | null {
  const { host = "0.0.0.0", port, token, tls, onTurn, onStreamTurn, onTextTurn, onNotify, onNotifyRender, onNotified, onSay, onChat, onHistory, onHealth, onTurnProbe, onSpeculate, readiness } = opts;
  const scheme: "http" | "https" = tls ? "https" : "http";
  const configuredDrainTimeout = opts.shutdownDrainTimeoutMs;
  const shutdownDrainTimeoutMs = typeof configuredDrainTimeout === "number" && Number.isFinite(configuredDrainTimeout) && configuredDrainTimeout >= 1
    ? Math.floor(configuredDrainTimeout)
    : DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
  const shutdownController = new AbortController();
  let accepting = true;
  let stopPromise: Promise<void> | null = null;
  // Live voice clients — notify broadcasts go to every open socket.
  const clients = new Set<import("bun").ServerWebSocket<WsData>>();
  const liveSpecs = new Set<SpeculativeTurn>();
  const specAbortTasks = new Map<SpeculativeTurn, Promise<void>>();
  const uncertainSpecs = new Set<SpeculativeTurn>();
  const seenSpecs = new WeakSet<SpeculativeTurn>();
  const trackSpec = (spec: SpeculativeTurn): SpeculativeTurn => {
    if (seenSpecs.has(spec)) {
      throw new Error("speculator returned a speculative turn that was already owned");
    }
    seenSpecs.add(spec);
    liveSpecs.add(spec);
    if (spec.closed) {
      void spec.closed.then(
        () => {
          if (!specAbortTasks.has(spec)) {
            liveSpecs.delete(spec);
            uncertainSpecs.delete(spec);
            resolveIfDrained();
          }
        },
        (error: unknown) => {
          // A failed autonomous cleanup remains charged and is retried by
          // stop(), just like an explicitly failed abortSpec() call.
          liveSpecs.add(spec);
          uncertainSpecs.add(spec);
          resolveIfDrained();
          log("warn", `speculative lifecycle cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        },
      );
    }
    return spec;
  };
  const releaseSpec = async (spec: SpeculativeTurn | null): Promise<void> => {
    if (!spec) return;
    try {
      // A successful consumer can still leave provider work that was not part
      // of its token stream (for example the probe-tail tone classifier on a
      // local fast path). `abort()` is the SpeculativeTurn cleanup barrier for
      // both adopted and rejected turns; never infer cleanup from handler return.
      await abortSpec(spec);
    } catch (error: unknown) {
      // abortSpec deliberately retains uncertain ownership for stop() retry.
      log("warn", `completed speculative turn cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const abortSpec = (spec: SpeculativeTurn): Promise<void> => {
    const existing = specAbortTasks.get(spec);
    if (existing) return existing;
    let task: Promise<void>;
    try {
      task = Promise.resolve(spec.abort());
    } catch (error) {
      task = Promise.reject(error);
    }
    liveSpecs.add(spec);
    specAbortTasks.set(spec, task);
    void task.then(
      () => {
        liveSpecs.delete(spec);
        specAbortTasks.delete(spec);
        uncertainSpecs.delete(spec);
        resolveIfDrained();
      },
      () => {
        // Unknown abort outcome: retain ownership so stop() can retry rather
        // than silently forgetting potentially live speculative work.
        specAbortTasks.delete(spec);
        uncertainSpecs.add(spec);
        resolveIfDrained();
      },
    );
    return task;
  };
  const serverOwnedSpec = (spec: SpeculativeTurn): SpeculativeTurn => ({
    claim: () => spec.claim(),
    coverageOk: (finalMs) => spec.coverageOk(finalMs),
    transcript: () => spec.transcript(),
    tokens: () => spec.tokens(),
    abort: () => abortSpec(spec),
  });
  let pendingClients = 0;
  let activeJobs = 0;
  let activeSocketCallbacks = 0;
  const backgroundTasks = new Set<Promise<void>>();
  let resolveDrain: (() => void) | null = null;
  let drainPromise: Promise<void> | null = null;
  const ownedWorkCount = (): number => activeJobs + backgroundTasks.size + liveSpecs.size;
  const isDrained = (): boolean =>
    activeJobs === 0 &&
    activeSocketCallbacks === 0 &&
    backgroundTasks.size === 0 &&
    liveSpecs.size === 0;
  const resolveIfDrained = (): void => {
    if (!isDrained() || !resolveDrain) return;
    const resolve = resolveDrain;
    resolveDrain = null;
    drainPromise = null;
    resolve();
  };
  const waitForDrain = (): Promise<void> => {
    if (isDrained()) return Promise.resolve();
    if (!drainPromise) {
      drainPromise = new Promise<void>((resolve) => { resolveDrain = resolve; });
    }
    return drainPromise;
  };
  const acquireJob = (transferredSpecSlots = 0): boolean => {
    const charged = Math.max(0, ownedWorkCount() - transferredSpecSlots);
    if (!accepting || charged >= MAX_CONCURRENT_WEB_JOBS) return false;
    activeJobs += 1;
    return true;
  };
  const releaseJob = (): void => {
    activeJobs = Math.max(0, activeJobs - 1);
    resolveIfDrained();
  };
  const releaseSocketCallback = (): void => {
    activeSocketCallbacks = Math.max(0, activeSocketCallbacks - 1);
    resolveIfDrained();
  };
  const trackBackground = (task: Promise<void>): boolean => {
    // Once quiescence begins, the active foreground lease must retain any late
    // continuation itself. Otherwise stop() could observe an empty set and
    // return just before a handler registers new work behind its back.
    if (!accepting || backgroundTasks.size >= MAX_BACKGROUND_WEB_JOBS) return false;
    backgroundTasks.add(task);
    void task.then(
      () => { backgroundTasks.delete(task); resolveIfDrained(); },
      (error: unknown) => {
        backgroundTasks.delete(task);
        resolveIfDrained();
        log("error", `web-voice background task failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    return true;
  };
  const unavailableMessage = (): string => accepting ? "server busy; retry later" : "server shutting down";
  const unavailableResponse = (): Response => accepting
    ? Response.json({ error: "server busy; retry later" }, { status: 429, headers: { "Retry-After": "1" } })
    : Response.json({ error: "server shutting down" }, { status: 503, headers: { Connection: "close", "Retry-After": "1" } });
  const requestSignal = (req: Request): AbortSignal =>
    AbortSignal.any([shutdownController.signal, req.signal]);
  const requestAbortedResponse = (signal: AbortSignal): Response =>
    shutdownController.signal.aborted
      ? Response.json({ error: "server shutting down" }, { status: 503, headers: { Connection: "close", "Retry-After": "1" } })
      : Response.json({ error: "request aborted" }, { status: 499, headers: { Connection: "close" } });
  const withRequestLease = async (
    req: Request,
    action: (signal: AbortSignal) => Promise<Response>,
    busyResponse: () => Response = unavailableResponse,
  ): Promise<Response> => {
    if (!acquireJob()) {
      const response = busyResponse();
      // The handler deliberately did not consume this request's upload.
      response.headers.set("Connection", "close");
      return response;
    }
    const signal = requestSignal(req);
    try {
      return await action(signal);
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error("web request handler failed", { cause: error });
    } finally {
      releaseJob();
    }
  };
  // Notifications that arrived with no client connected are parked and spoken
  // to the next client that connects ("speak when you're back"). Bounded and
  // time-limited: stale news is worse than no news.
  // audioBase64: null marks a lazily-parked item — the clip is synthesized at
  // flush time via onNotifyRender, so news nobody ever hears (parked clips die
  // of TTL more often than they get heard) never costs a GPU synthesis.
  const parked: Array<{ text: string; voice?: string; audioBase64: string | null; at: number }> = [];
  const PARK_MAX = 10;
  const PARK_TTL_MS = 4 * 60 * 60 * 1000;
  // Ordering note: a live notify dispatched while an old parked item is mid-
  // render can reach clients first. Arrival order across the park boundary was
  // never guaranteed (parked news already waited for a connect); each item's
  // own text carries its context.
  let flushingParked = false;
  let flushRequested = false;
  const drainParkedPass = async (): Promise<void> => {
    while (parked.length) {
      if (shutdownController.signal.aborted) return;
      if (clients.size === 0) return;
      const p = parked.shift();
      if (!p || Date.now() - p.at > PARK_TTL_MS) continue;
      let audioBase64 = p.audioBase64;
      if (audioBase64 === null) {
        if (!onNotifyRender) continue;
        try {
          const rendered = await onNotifyRender(p.text, p.voice, { signal: shutdownController.signal });
          const audio = snapshotSynthesizedWav(rendered, { maxBytes: MAX_TURN_AUDIO_BYTES, allowEmpty: true }).audio;
          audioBase64 = audio.byteLength > 0 ? Buffer.from(audio).toString("base64") : "";
        } catch (error) {
          // A transient TTS failure must not eat the news: put the item
          // back and let the next connect retry. TTL still bounds its life.
          parked.unshift(p);
          if (!shutdownController.signal.aborted) {
            log("warn", `parked notify render failed, retrying on next connect: ${error instanceof Error ? error.message : String(error)}`);
          }
          return;
        }
        if (shutdownController.signal.aborted) {
          // Shutdown raced the render: keep the item (with its clip) for
          // the next daemon lifetime rather than publishing into teardown.
          parked.unshift({ ...p, audioBase64 });
          return;
        }
      }
      // Deliver to the first live client; a socket that died between connect
      // and now must not eat the item — or strand it while others listen.
      let sent = false;
      for (const ws of clients) {
        try {
          sendJson(ws, withSession(ws, { type: "notify", text: p.text, audioBase64 }));
          sent = true;
          break;
        } catch { /* try the next client */ }
      }
      if (!sent) {
        parked.unshift({ ...p, audioBase64 }); // keep the rendered clip
        return;
      }
    }
  };
  const flushParked = async (): Promise<void> => {
    if (flushingParked) {
      // A drain is active. Latch the new listener: the running pass may
      // re-park an item (render failure, dead socket) after this early
      // return, and without the latch that item would strand until yet
      // another connect. Each latched request grants at most one re-pass,
      // so a permanently failing render cannot hot-loop.
      flushRequested = true;
      return;
    }
    flushingParked = true;
    try {
      do {
        flushRequested = false;
        await drainParkedPass();
      } while (flushRequested && parked.length > 0 && clients.size > 0 && !shutdownController.signal.aborted);
    } finally {
      flushingParked = false;
    }
  };
  const startParkedFlush = (): void => {
    // An active drain needs no new task (and holds a background slot that
    // could read as a full cap) — latch the request so it re-passes.
    if (flushingParked) {
      flushRequested = true;
      return;
    }
    // Begin only when stop() can own the flush — an untracked render could
    // outlive shutdown. The admission check mirrors trackBackground's, so
    // registration below cannot fail; the microtask defer means no flush
    // code runs before ownership is registered. When declined (shutting
    // down or at the background cap) the items stay parked and the next
    // connect retries.
    if (!accepting || backgroundTasks.size >= MAX_BACKGROUND_WEB_JOBS) return;
    trackBackground(Promise.resolve().then(flushParked));
  };

  // Render a notification and deliver it: broadcast to every connected client,
  // or park it for the next one. Shared by POST /api/notify and handle.notify().
  const dispatchNotify = async (
    text: string,
    voice?: string,
    notifyOpts?: { urgent?: boolean; telegramMirror?: boolean; signal?: AbortSignal },
  ): Promise<{ delivered: number; parked: boolean } | null> => {
    if (!onNotify) return null;
    const signal = notifyOpts?.signal ?? shutdownController.signal;
    if (signal.aborted) return null;
    // With a lazy renderer wired and nobody connected, tell the daemon to skip
    // the synthesis: quiet hours and the Telegram mirror still apply, but the
    // clip is rendered only when a client shows up to hear it.
    const lazy = clients.size === 0 && typeof onNotifyRender === "function";
    // Full text goes down — the daemon strips URLs from the audio only, so
    // the Telegram mirror and the voice-page notice card keep the link.
    let providerAudio: ArrayBuffer | null;
    try {
      providerAudio = await onNotify(text, voice, {
        urgent: notifyOpts?.urgent,
        telegramMirror: notifyOpts?.telegramMirror,
        signal,
        skipRender: lazy,
      });
    } catch (error) {
      throw new Error(`notification render failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (signal.aborted) return null;
    // null = the daemon deferred it (quiet hours) — no broadcast, no parking.
    if (providerAudio === null) {
      log("info", `notify: "${text.substring(0, 60)}" deferred (quiet hours)`);
      return { delivered: 0, parked: false };
    }
    const audio = snapshotSynthesizedWav(providerAudio, {
      maxBytes: MAX_TURN_AUDIO_BYTES,
      allowEmpty: true,
    }).audio;
    let audioBase64 = audio.byteLength > 0 ? Buffer.from(audio).toString("base64") : "";
    if (lazy && audioBase64 === "" && clients.size > 0) {
      // Race: a client connected while the daemon was told to skip the render.
      // Render inline rather than hand them a silent notice card; on failure,
      // deliver text-only rather than fail a notification that's already
      // mirrored to Telegram.
      try {
        const rendered = await onNotifyRender!(text, voice, { signal });
        const a = snapshotSynthesizedWav(rendered, { maxBytes: MAX_TURN_AUDIO_BYTES, allowEmpty: true }).audio;
        audioBase64 = a.byteLength > 0 ? Buffer.from(a).toString("base64") : "";
      } catch (error) {
        // Cancellation is not a TTS failure — an aborted turn must not
        // publish, not even text-only.
        if (signal.aborted) return null;
        log("warn", `late notify render failed, delivering text-only: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (signal.aborted) return null;
    }
    let delivered = 0;
    for (const ws of clients) {
      try {
        ws.send(JSON.stringify(withSession(ws, { type: "notify", text, audioBase64 })));
        delivered++;
      } catch { /* socket closed */ }
    }
    if (delivered === 0) {
      // The daemon may render even when told it could skip (a Telegram voice
      // note needs the clip now) — an audio-bearing park keeps that work.
      parked.push({ text, voice, audioBase64: lazy && audioBase64 === "" ? null : audioBase64, at: Date.now() });
      if (parked.length > PARK_MAX) parked.shift();
      log("info", `notify: "${text.substring(0, 60)}" — no client connected, parked for the next one`);
      reportNotified(text, { delivered, parked: true });
      return { delivered, parked: true };
    }
    log("info", `notify: "${text.substring(0, 60)}" → ${delivered} client(s)`);
    reportNotified(text, { delivered, parked: false });
    return { delivered, parked: false };
  };
  const reportNotified = (text: string, outcome: { delivered: number; parked: boolean }) => {
    if (!onNotified) return;
    const warn = (error: unknown) =>
      log("warn", `onNotified hook failed: ${error instanceof Error ? error.message : String(error)}`);
    // Both a synchronous throw and an async rejection must stay contained —
    // the notification is already delivered; the hook is fire-and-forget.
    try {
      Promise.resolve(onNotified(text, outcome)).catch(warn);
    } catch (error) {
      warn(error);
    }
  };

  const notify = async (
    text: string,
    voice?: string,
    notifyOpts?: { urgent?: boolean; telegramMirror?: boolean },
  ): Promise<{ delivered: number; parked: boolean } | null> => {
    const normalizedText = text.trim();
    const normalizedVoice = voice?.trim() || undefined;
    if (
      !onNotify || !normalizedText || normalizedText.length > MAX_NOTIFY_TEXT_CHARS ||
      (normalizedVoice?.length ?? 0) > MAX_VOICE_NAME_CHARS || !acquireJob()
    ) return null;
    try {
      return await dispatchNotify(normalizedText, normalizedVoice, {
        ...notifyOpts,
        signal: shutdownController.signal,
      });
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error("notification dispatch failed", { cause: error });
    } finally {
      releaseJob();
    }
  };

  // The latest input wins (spoken WAV or typed text): stash it as pending and
  // signal any in-flight turn to abort (barge-in). A single drain loop
  // processes pending turns so a mid-turn input is never dropped.
  const queueTurn = async (ws: import("bun").ServerWebSocket<WsData>, input: ArrayBuffer | string, turnId: string): Promise<void> => {
    if (!accepting) {
      protocolError(ws, "server shutting down", turnId);
      return;
    }
    if (ws.data.recentTurnIds.includes(turnId) || ws.data.pending?.turnId === turnId || ws.data.current?.turnId === turnId) {
      protocolError(ws, "duplicate or replayed turn id", turnId);
      return;
    }
    // A final/typed turn consumes or aborts this socket's current speculation,
    // so transfer that charged slot instead of rejecting the confirming turn.
    const transferableSpecSlots = ws.data.spec && liveSpecs.has(ws.data.spec.turn) ? 1 : 0;
    if (!ws.data.busy && !acquireJob(transferableSpecSlots)) {
      protocolError(ws, unavailableMessage(), turnId);
      return;
    }
    ws.data.recentTurnIds.push(turnId);
    if (ws.data.recentTurnIds.length > 128) ws.data.recentTurnIds.shift();
    if (ws.data.latestProbeTurnId === turnId) ws.data.latestProbeTurnId = null;

    // Latest input wins on this socket only. Its current sink is immediately
    // invalidated, so even a handler that emits after observing the abort
    // cannot leak stale text/audio into the replacement turn.
    abortTurn(ws.data.current, "superseded by a newer turn");
    ws.data.pending = { input, turnId };
    if (ws.data.busy) return; // the running drain loop will pick it up
    ws.data.busy = true;
    try {
      while (ws.data.pending !== null) {
        const next = ws.data.pending;
        ws.data.pending = null;
        const controller = new AbortController();
        const state: TurnState = {
          turnId: next.turnId,
          aborted: false,
          controller,
          signal: AbortSignal.any([controller.signal, shutdownController.signal]),
        };
        if (shutdownController.signal.aborted) abortTurn(state, "web voice server shutting down");
        ws.data.current = state;
        // Any in-flight speculation belongs to exactly one turn: a WAV turn
        // gets to adopt it; a typed turn (different input entirely) kills it.
        const specState = ws.data.spec;
        ws.data.spec = null;
        let spec: SpeculativeTurn | null = null;
        if (specState) {
          if (typeof next.input !== "string" && (ws.data.protocol === 1 || specState.turnId === next.turnId)) {
            spec = specState.turn;
          } else {
            await abortSpec(specState.turn).catch((error: unknown) => {
              log("warn", `superseded speculative turn cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        }
        const handlerSpec = spec ? serverOwnedSpec(spec) : null;
        try {
          if (typeof next.input === "string") {
            await onTextTurn?.(next.input, makeSink(ws, state), {
              record: ws.data.record,
              signal: state.signal,
              trackBackground,
            });
          } else {
            await onStreamTurn?.(next.input, makeSink(ws, state), {
              record: ws.data.record,
              spec: handlerSpec,
              signal: state.signal,
              trackBackground,
            });
          }
        } catch (err: unknown) {
          const m = err instanceof Error ? err.message : String(err);
          log("error", `web-voice ws turn failed: ${m}`);
          if (!state.aborted) protocolError(ws, m, state.turnId);
        } finally {
          await releaseSpec(spec);
          if (ws.data.current === state) ws.data.current = null;
        }
      }
    } finally {
      ws.data.busy = false;
      releaseJob();
    }
  };

  try {
    const server = Bun.serve<WsData>({
      hostname: host,
      port,
      ...(tls ? { tls: { cert: tls.cert, key: tls.key } } : {}),
      async fetch(req, srv) {
        const url = new URL(req.url);

        if (!accepting) {
          return Response.json(
            { error: "server shutting down" },
            { status: 503, headers: { Connection: "close", "Retry-After": "1" } },
          );
        }

        // Unauthenticated liveness probe (no secret leaked).
        if (req.method === "GET" && url.pathname === "/health") {
          return new Response("ok", { status: 200 });
        }

        // Readiness is distinct from liveness: orchestration should stop
        // routing turns while the daemon is still starting or shutting down.
        if (req.method === "GET" && url.pathname === "/ready") {
          if (!acquireJob()) return unavailableResponse();
          const signal = requestSignal(req);
          try {
            const raw = readiness ? await readiness({ signal }) : true;
            if (signal.aborted) {
              return Response.json(
                { status: "not_ready", reason: shutdownController.signal.aborted ? "server shutting down" : "request aborted" },
                { status: 503, headers: { Connection: "close" } },
              );
            }
            const result = typeof raw === "boolean" ? { ready: raw } : raw;
            return Response.json(
              result.ready
                ? { status: "ready" }
                : { status: "not_ready", ...(result.reason ? { reason: result.reason } : {}) },
              { status: result.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
            );
          } catch {
            return Response.json(
              { status: "not_ready", reason: "readiness check failed" },
              { status: 503, headers: { "Cache-Control": "no-store" } },
            );
          } finally {
            releaseJob();
          }
        }

        // PWA assets — unauthenticated like /health (the browser fetches the
        // manifest without the page's query string; neither leaks anything).
        if (req.method === "GET" && url.pathname === "/manifest.webmanifest") {
          return new Response(MANIFEST, { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" } });
        }
        if (req.method === "GET" && url.pathname === "/icon.svg") {
          return new Response(ICON_SVG, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" } });
        }

        // Speech-gate assets (Silero VAD + onnxruntime wasm) — unauthenticated
        // like the PWA assets (subresource fetches carry no query token; the
        // files are public MIT artifacts). Exact-name whitelist: no traversal,
        // no directory reads. Pinned versions, so immutable caching is safe.
        if (req.method === "GET" && url.pathname.startsWith("/vad/")) {
          const asset = VAD_ASSET_BY_NAME.get(url.pathname.slice("/vad/".length));
          if (!asset || !opts.vadDir) return new Response("not found", { status: 404 });
          const file = Bun.file(join(opts.vadDir, asset.name));
          if (!(await file.exists()) || file.size !== asset.bytes) return new Response("not found", { status: 404 });
          return new Response(file, {
            headers: { "Content-Type": asset.contentType, "Cache-Control": "public, max-age=31536000, immutable" },
          });
        }

        // An installed PWA starts without its original query string. This
        // public shell has no authority by itself: APIs and /ws still require
        // the token, which the first tokened visit persisted in localStorage.
        if (req.method === "GET" && url.pathname === "/app") {
          return new Response(PAGE, { headers: PAGE_HEADERS });
        }

        if (!tokenMatches(presentedToken(req, url), token)) {
          // Never keep an unread authenticated-operation body on a reusable
          // connection. Closing also bounds work from repeated bad credentials.
          return new Response("forbidden", { status: 403, headers: { Connection: "close" } });
        }

        // Streaming voice WebSocket (Phase 2): hands-free turns + sentence-streamed reply.
        if (url.pathname === "/ws") {
          if (req.method !== "GET") {
            return new Response("Method Not Allowed", { status: 405, headers: { Connection: "close" } });
          }
          if (!accepting) return unavailableResponse();
          if (clients.size + pendingClients >= MAX_WEB_VOICE_CLIENTS) {
            return new Response("too many voice clients", { status: 429, headers: { "Retry-After": "5" } });
          }
          // ?record=0 marks this socket as a test harness: turns run the full
          // pipeline but stay out of the persisted chat history.
          const record = url.searchParams.get("record") !== "0";
          const protocol = url.searchParams.get("protocol") === "2" ? 2 : 1;
          pendingClients += 1;
          let upgraded = false;
          try {
            upgraded = srv.upgrade(req, {
              data: {
                pendingClientSlot: true,
                sessionId: crypto.randomUUID(),
                protocol,
                busy: false,
                pending: null,
                current: null,
                recentTurnIds: [],
                latestProbeTurnId: null,
                record,
                spec: null,
              },
            });
          } finally {
            if (!upgraded) pendingClients = Math.max(0, pendingClients - 1);
          }
          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          return new Response(PAGE, { headers: PAGE_HEADERS });
        }

        // Proactive voice-back: render text to speech and push it to every
        // connected voice client. Anything can call this — kanban hooks, cron,
        // CI, `cicero notify` — and Cicero speaks up in the browser.
        if (req.method === "POST" && url.pathname === "/api/notify") {
          if (!onNotify) {
            return Response.json({ error: "notify not available" }, { status: 501, headers: { Connection: "close" } });
          }
          return withRequestLease(req, async (signal) => {
            let text = "";
            let voice: string | undefined;
            try {
              const body = await readRequestJsonLimited(req, {
                maxBytes: MAX_NOTIFY_JSON_BYTES,
                timeoutMs: BODY_READ_TIMEOUT_MS,
                signal,
              });
              if (!isRecord(body) || typeof body.text !== "string") {
                return Response.json({ error: "text must be a string" }, { status: 400 });
              }
              if (body.voice !== undefined && typeof body.voice !== "string") {
                return Response.json({ error: "voice must be a string" }, { status: 400 });
              }
              text = body.text.trim();
              voice = body.voice?.trim() || undefined;
            } catch (error) {
              return jsonReadError(error, shutdownController.signal.aborted);
            }
            if (!text) return Response.json({ error: "missing text" }, { status: 400 });
            if (text.length > MAX_NOTIFY_TEXT_CHARS || (voice?.length ?? 0) > MAX_VOICE_NAME_CHARS) {
              return Response.json({ error: "notification text or voice is too long" }, { status: 413 });
            }
            try {
              const result = await dispatchNotify(text, voice, { signal });
              if (signal.aborted) return requestAbortedResponse(signal);
              if (!result) return Response.json({ error: "notify not available" }, { status: 501 });
              return result.parked
                ? Response.json({ delivered: result.delivered, parked: true })
                : Response.json({ delivered: result.delivered });
            } catch (error) {
              if (signal.aborted) return requestAbortedResponse(signal);
              const message = error instanceof Error ? error.message : String(error);
              log("error", `web-voice notify failed: ${message}`);
              return Response.json({ error: message }, { status: 500 });
            }
          });
        }

        // Render text to speech and return the WAV — no broadcast, no parking.
        // For callers that carry their own audio channel (the Telegram call
        // bridge greeting, external integrations).
        if (req.method === "POST" && url.pathname === "/api/say") {
          if (!onSay) {
            return Response.json({ error: "tts not available" }, { status: 501, headers: { Connection: "close" } });
          }
          return withRequestLease(req, async (signal) => {
            let text = "";
            try {
              const body = await readRequestJsonLimited(req, {
                maxBytes: MAX_NOTIFY_JSON_BYTES,
                timeoutMs: BODY_READ_TIMEOUT_MS,
                signal,
              });
              if (!isRecord(body) || typeof body.text !== "string") {
                return Response.json({ error: "text must be a string" }, { status: 400 });
              }
              text = body.text.trim();
            } catch (error) {
              return jsonReadError(error, shutdownController.signal.aborted);
            }
            if (!text) return Response.json({ error: "missing text" }, { status: 400 });
            if (text.length > MAX_NOTIFY_TEXT_CHARS) return Response.json({ error: "text is too long" }, { status: 413 });
            try {
              const providerAudio = await onSay(text, { signal });
              if (signal.aborted) return requestAbortedResponse(signal);
              const audio = snapshotSynthesizedWav(providerAudio, {
                maxBytes: MAX_TURN_AUDIO_BYTES,
                allowEmpty: true,
              }).audio;
              return new Response(audio, { headers: { "Content-Type": "audio/wav" } });
            } catch (error) {
              if (signal.aborted) return requestAbortedResponse(signal);
              const message = error instanceof Error ? error.message : String(error);
              log("error", `web-voice say failed: ${message}`);
              return Response.json({ error: message }, { status: 500 });
            }
          });
        }

        // Text chat for surfaces with their own display (Telegram): the reply
        // comes back whole, unsummarized — it's read, not spoken.
        if (req.method === "POST" && url.pathname === "/api/chat") {
          if (!onChat) {
            return Response.json({ error: "chat not available" }, { status: 501, headers: { Connection: "close" } });
          }
          return withRequestLease(req, async (signal) => {
            let text = "";
            try {
              const body = await readRequestJsonLimited(req, {
                maxBytes: MAX_CHAT_JSON_BYTES,
                timeoutMs: BODY_READ_TIMEOUT_MS,
                signal,
              });
              if (!isRecord(body) || typeof body.text !== "string") {
                return Response.json({ error: "text must be a string" }, { status: 400 });
              }
              text = body.text.trim();
            } catch (error) {
              return jsonReadError(error, shutdownController.signal.aborted);
            }
            if (!text) return Response.json({ error: "missing text" }, { status: 400 });
            if (text.length > MAX_CHAT_TEXT_CHARS) return Response.json({ error: "text is too long" }, { status: 413 });
            try {
              const reply = await onChat(text, { signal });
              if (signal.aborted) return requestAbortedResponse(signal);
              return Response.json({ reply });
            } catch (error) {
              if (signal.aborted) return requestAbortedResponse(signal);
              const message = error instanceof Error ? error.message : String(error);
              log("error", `web-voice chat failed: ${message}`);
              return Response.json({ error: message }, { status: 500 });
            }
          });
        }

        // Health-record ingest: one row or an array of rows, appended to
        // the health record. Built for the phase-2 phone bridge (Health Connect
        // → HA/Tasker → here) but anything token-bearing on the LAN can log.
        if (req.method === "POST" && url.pathname === "/api/health") {
          if (!onHealth) {
            return Response.json({ error: "health record not available" }, { status: 501, headers: { Connection: "close" } });
          }
          return withRequestLease(req, async (signal) => {
            let rows: unknown;
            try {
              rows = await readRequestJsonLimited(req, {
                maxBytes: MAX_HEALTH_JSON_BYTES,
                timeoutMs: BODY_READ_TIMEOUT_MS,
                signal,
              });
            } catch (error) {
              return jsonReadError(error, shutdownController.signal.aborted);
            }
            const list = Array.isArray(rows) ? rows : [rows];
            if (list.length > MAX_HEALTH_ROWS) {
              return Response.json({ error: `at most ${MAX_HEALTH_ROWS} health rows are accepted per request` }, { status: 413 });
            }
            const valid = list.filter(
              (row) =>
                isRecord(row) &&
                typeof row.metric === "string" && row.metric.trim().length > 0 && row.metric.length <= MAX_HEALTH_METRIC_CHARS &&
                (row.value === undefined || (typeof row.value === "number" && Number.isFinite(row.value))) &&
                (row.unit === undefined || (typeof row.unit === "string" && row.unit.length <= MAX_HEALTH_UNIT_CHARS)) &&
                (row.note === undefined || (typeof row.note === "string" && row.note.length <= MAX_HEALTH_NOTE_CHARS)) &&
                (row.value !== undefined || typeof row.note === "string"),
            );
            if (valid.length === 0) {
              return Response.json({ error: "no valid rows — each needs a metric plus a value or note" }, { status: 400 });
            }
            try {
              const logged = await onHealth(
                valid.map((row) => ({
                  metric: row.metric.trim().toLowerCase(),
                  value: typeof row.value === "number" ? row.value : undefined,
                  unit: typeof row.unit === "string" ? row.unit : undefined,
                  note: typeof row.note === "string" ? row.note : undefined,
                })),
                { signal },
              );
              if (signal.aborted) return requestAbortedResponse(signal);
              return Response.json({ logged, skipped: list.length - valid.length });
            } catch (error) {
              if (signal.aborted) return requestAbortedResponse(signal);
              const message = error instanceof Error ? error.message : String(error);
              log("error", `web-voice health ingest failed: ${message}`);
              return Response.json({ error: message }, { status: 500 });
            }
          });
        }

        if (req.method === "POST" && url.pathname === "/api/turn") {
          const requestedSessionId = requestedId(req, url, "x-cicero-session-id", "sessionId");
          const requestedTurnId = requestedId(req, url, "x-cicero-turn-id", "turnId");
          if (requestedSessionId === null || requestedTurnId === null) {
            // Validation precedes the body lease, so force-close the unread
            // upload instead of leaving it on a reusable connection.
            return Response.json(
              { error: "invalid session or turn id" },
              { status: 400, headers: { Connection: "close" } },
            );
          }
          const sessionId = requestedSessionId ?? crypto.randomUUID();
          const turnId = requestedTurnId ?? crypto.randomUUID();
          const headers = { "X-Cicero-Session-Id": sessionId, "X-Cicero-Turn-Id": turnId };
          return withRequestLease(
            req,
            async (signal) => {
              let wav: ArrayBuffer;
              try {
                wav = await readRequestBodyLimited(req, {
                  maxBytes: MAX_TURN_AUDIO_BYTES,
                  timeoutMs: BODY_READ_TIMEOUT_MS,
                  signal,
                });
              } catch (error) {
                if (error instanceof RequestBodyTooLargeError) {
                  return Response.json(
                    { error: "audio body too large", sessionId, turnId },
                    { status: 413, headers: { ...headers, Connection: "close" } },
                  );
                }
                if (error instanceof RequestBodyTimeoutError) {
                  return Response.json(
                    { error: "audio body timed out", sessionId, turnId },
                    { status: 408, headers: { ...headers, Connection: "close" } },
                  );
                }
                if (error instanceof RequestBodyAbortedError) {
                  const response = requestAbortedResponse(signal);
                  response.headers.set("X-Cicero-Session-Id", sessionId);
                  response.headers.set("X-Cicero-Turn-Id", turnId);
                  return response;
                }
                log("warn", `web-voice request body read failed: ${error instanceof Error ? error.message : String(error)}`);
                return Response.json({ error: "failed to read audio body", sessionId, turnId }, { status: 400, headers });
              }
              if (wav.byteLength === 0) {
                return Response.json({ error: "empty audio body", sessionId, turnId }, { status: 400, headers });
              }
              if (!inspectTurnAudio(wav)) {
                return Response.json(
                  { error: `audio must be an uncompressed PCM WAV no longer than ${MAX_TURN_AUDIO_MS / 1_000} seconds`, sessionId, turnId },
                  { status: 415, headers },
                );
              }
              try {
                const result = await onTurn(wav, { signal, trackBackground });
                if (signal.aborted) {
                  return Response.json(
                    { error: shutdownController.signal.aborted ? "server shutting down" : "request aborted", sessionId, turnId },
                    { status: shutdownController.signal.aborted ? 503 : 499, headers: { ...headers, Connection: "close" } },
                  );
                }
                // Admission happens before base64, whose 4/3 expansion otherwise
                // turns a provider-sized reply into an unexpectedly large JSON body.
                const audio = snapshotSynthesizedWav(result.audio, {
                  maxBytes: MAX_TURN_AUDIO_BYTES,
                  allowEmpty: true,
                }).audio;
                return Response.json({
                  sessionId,
                  turnId,
                  transcript: result.transcript,
                  reply: result.reply,
                  audioBase64: audio.byteLength > 0 ? Buffer.from(audio).toString("base64") : "",
                }, { headers });
              } catch (error) {
                if (signal.aborted) {
                  return Response.json(
                    { error: shutdownController.signal.aborted ? "server shutting down" : "request aborted", sessionId, turnId },
                    { status: shutdownController.signal.aborted ? 503 : 499, headers: { ...headers, Connection: "close" } },
                  );
                }
                const message = error instanceof Error ? error.message : String(error);
                log("error", `web-voice turn failed: ${message}`);
                return Response.json({ error: message, sessionId, turnId }, { status: 500, headers });
              }
            },
            () => accepting
              ? Response.json(
                  { error: "server busy; retry later", sessionId, turnId },
                  { status: 429, headers: { ...headers, "Retry-After": "1" } },
                )
              : Response.json(
                  { error: "server shutting down", sessionId, turnId },
                  { status: 503, headers: { ...headers, Connection: "close", "Retry-After": "1" } },
                ),
          );
        }

        return new Response(
          "Not Found",
          { status: 404, headers: req.method === "GET" || req.method === "HEAD" ? undefined : { Connection: "close" } },
        );
      },
      websocket: {
        // Bun rejects larger frames before allocating them to application code.
        // The small envelope allowance lets v2 still carry a full 4 MiB WAV.
        maxPayloadLength: MAX_WS_PAYLOAD_BYTES,
        open(ws) {
          if (ws.data.pendingClientSlot) {
            pendingClients = Math.max(0, pendingClients - 1);
            ws.data.pendingClientSlot = false;
          }
          if (!accepting) {
            ws.close(1012, "Server shutting down");
            return;
          }
          clients.add(ws);
          if (ws.data.protocol === 2) {
            sendJson(ws, {
              type: "hello",
              protocol: 2,
              sessionId: ws.data.sessionId,
              turnId: null,
              maxAudioBytes: MAX_TURN_AUDIO_BYTES,
            });
          }
          // Tell the client whether mid-pause turn probes are worth sending —
          // without a detector they'd be dead weight on every pause.
          if (onTurnProbe) sendJson(ws, withSession(ws, { type: "probe_on" }));
          // History first, then any parked notifications — so missed news
          // reads (and speaks) after the old chat log, in arrival order.
          if (onHistory && acquireJob()) {
            void onHistory({ signal: shutdownController.signal })
              .then((items) => {
                if (!accepting || !clients.has(ws)) return;
                const bounded = items.slice(-100).map((item) => ({
                  t: item.t,
                  user: item.user.slice(0, MAX_CHAT_TEXT_CHARS),
                  reply: item.reply.slice(0, MAX_CHAT_TEXT_CHARS),
                }));
                if (bounded.length) sendJson(ws, withSession(ws, { type: "history", items: bounded }));
              })
              .catch(() => { /* history is best-effort */ })
              .finally(() => {
                if (accepting && clients.has(ws)) {
                  startParkedFlush();
                }
                releaseJob();
              });
          } else {
            if (accepting) startParkedFlush();
          }
        },
        async message(ws, message) {
          activeSocketCallbacks += 1;
          try {
          if (!accepting) {
            protocolError(ws, "server shutting down");
            ws.close(1012, "Server shutting down");
            return;
          }
          // Text frames are control messages: abort (barge-in) or a typed turn.
          if (typeof message === "string") {
            if (Buffer.byteLength(message) > MAX_WS_TEXT_BYTES) {
              protocolError(ws, "control frame too large");
              return;
            }
            let msg: { type?: string; text?: string; sessionId?: unknown; turnId?: unknown };
            try {
              msg = JSON.parse(message) as typeof msg;
            } catch {
              if (ws.data.protocol === 2) protocolError(ws, "malformed control frame");
              // Protocol v1 historically ignored malformed controls.
              return;
            }
            if (ws.data.protocol === 2 && msg.sessionId !== ws.data.sessionId) {
              protocolError(ws, "session id does not match this connection");
              return;
            }
            if (msg.type === "abort") {
              if (ws.data.protocol === 2) {
                if (!isProtocolId(msg.turnId)) {
                  protocolError(ws, "abort requires a valid turn id");
                  return;
                }
                if (ws.data.current?.turnId === msg.turnId) abortTurn(ws.data.current, "turn aborted by client");
                if (ws.data.pending?.turnId === msg.turnId) ws.data.pending = null;
              } else if (ws.data.current) {
                abortTurn(ws.data.current, "turn aborted by client");
              }
              return;
            }
            if (msg.type === "text" && typeof msg.text === "string" && msg.text.trim()) {
              const turnId = ws.data.protocol === 2 ? msg.turnId : crypto.randomUUID();
              if (!isProtocolId(turnId)) {
                protocolError(ws, "typed input requires a valid turn id");
                return;
              }
              if (!onTextTurn) {
                protocolError(ws, "typed input not available", turnId);
                return;
              }
              if (msg.text.length > MAX_CHAT_TEXT_CHARS) {
                protocolError(ws, "typed input too large", turnId);
                return;
              }
              await queueTurn(ws, msg.text.trim(), turnId).catch((err: unknown) => {
                const detail = err instanceof Error ? err.message : String(err);
                log("error", `web-voice queue failed: ${detail}`);
                protocolError(ws, "turn queue failed", turnId);
              });
            }
            return;
          }

          const raw = message as Uint8Array;
          let u8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
          let turnId: string;
          if (ws.data.protocol === 2) {
            const frame = decodeTurnAudioFrame(u8);
            if (!frame) {
              protocolError(ws, "binary frame is not a valid protocol-v2 envelope");
              return;
            }
            if (frame.sessionId !== ws.data.sessionId) {
              protocolError(ws, "session id does not match this connection", frame.turnId);
              return;
            }
            turnId = frame.turnId;
            u8 = new Uint8Array(frame.payload);
          } else {
            turnId = crypto.randomUUID();
          }

          // Probe frame = "is the speaker done?" — answered inline, never a turn.
          if (isProbeFrame(u8)) {
            if (!onTurnProbe) return;
            if (ws.data.protocol === 2) ws.data.latestProbeTurnId = turnId;
            if (!acquireJob()) {
              protocolError(ws, accepting ? "server busy; retry probe later" : "server shutting down", turnId);
              return;
            }
            try {
              const frame = decodeProbeFrame(u8);
              if (!frame) return;
              const verdict = await onTurnProbe(frame.samples, frame.sampleRate, { signal: shutdownController.signal });
              if (shutdownController.signal.aborted) return;
              // A newer probe or the final WAV invalidated this result.
              if (ws.data.protocol === 2 && ws.data.latestProbeTurnId !== turnId) return;
              if (verdict) sendJson(ws, withTurn(ws, turnId, { type: "verdict", complete: verdict.complete, probability: verdict.probability }));
              // Confident "complete" = the final WAV is moments away and will
              // contain exactly this audio — start transcribing + thinking NOW
              // (see speculative.ts; the WAV turn adopts or aborts it).
              if (verdict?.complete && onSpeculate && frame.utterMs !== undefined && !ws.data.busy) {
                const prev = ws.data.spec;
                const spec = onSpeculate(frame.samples, frame.sampleRate, frame.utterMs, verdict.probability);
                ws.data.spec = spec ? { turnId: ws.data.protocol === 2 ? turnId : null, turn: trackSpec(spec) } : null;
                if (prev) {
                  void abortSpec(prev.turn).catch((error: unknown) => {
                    log("warn", `replaced speculative turn cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
                  });
                }
              }
            } catch (error) {
              log("warn", `web turn probe failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            finally { releaseJob(); }
            return;
          }
          if (!onStreamTurn) {
            protocolError(ws, "streaming not available", turnId);
            return;
          }
          if (u8.byteLength > MAX_TURN_AUDIO_BYTES) {
            protocolError(ws, "audio payload too large", turnId);
            return;
          }
          if (u8.byteLength === 0) {
            protocolError(ws, "empty audio payload", turnId);
            return;
          }
          if (!inspectTurnAudio(u8)) {
            protocolError(ws, `audio must be an uncompressed PCM WAV no longer than ${MAX_TURN_AUDIO_MS / 1_000} seconds`, turnId);
            return;
          }
          // Binary frame = a complete utterance WAV.
          const wav = new Uint8Array(u8.byteLength);
          wav.set(u8);
          await queueTurn(ws, wav.buffer, turnId).catch((err: unknown) => {
            const detail = err instanceof Error ? err.message : String(err);
            log("error", `web-voice queue failed: ${detail}`);
            protocolError(ws, "turn queue failed", turnId);
          });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            log("error", `web-voice socket message failed: ${detail}`);
            protocolError(ws, "socket message failed");
          } finally {
            releaseSocketCallback();
          }
        },
        close(ws) {
          if (ws.data.pendingClientSlot) pendingClients = Math.max(0, pendingClients - 1);
          clients.delete(ws);
          abortTurn(ws.data.current, "voice socket closed");
          ws.data.pending = null;
          ws.data.latestProbeTurnId = null;
          const spec = ws.data.spec;
          ws.data.spec = null;
          if (spec) {
            void abortSpec(spec.turn).catch((error: unknown) => {
              log("warn", `closed-socket speculative cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        },
      },
    });

    log("ok", `🎙️  Web voice server on ${scheme}://${host}:${server.port} (token required)`);
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
        log("error", `web-voice listener stop failed: ${error instanceof Error ? error.message : String(error)}`);
        if (runtimeStopPromise === task) runtimeStopPromise = null;
      });
      return task;
    };
    const stopListener = (): Promise<void> => {
      const runtimeStop = stopRuntime();
      // Bun 1.3 can leave this promise pending when the peer already sent a
      // close frame during its final message callback, even though the listener
      // is stopped and no application-owned socket/request remains. Preserve
      // the real promise for ordinary/error cases, but do not deadlock daemon
      // shutdown on that bookkeeping-only state.
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
      const bookkeepingFallback = new Promise<void>((resolve) => {
        fallbackTimer = setTimeout(resolve, 100);
      }).then(() => {
        if (
          server.pendingRequests === 0 &&
          clients.size === 0 &&
          isDrained()
        ) return;
        return runtimeStop;
      });
      const attempt = Promise.race([
        runtimeStop,
        bookkeepingFallback,
      ]);
      void attempt.then(
        () => { if (fallbackTimer !== undefined) clearTimeout(fallbackTimer); },
        () => { if (fallbackTimer !== undefined) clearTimeout(fallbackTimer); },
      );
      return attempt;
    };
    const stop = (): Promise<void> => {
      if (stopPromise) return stopPromise;

      // Quiesce synchronously so callers cannot race another direct notify or
      // request into dependencies after shutdown has begun.
      accepting = false;
      if (!shutdownController.signal.aborted) {
        shutdownController.abort(new Error("web voice server shutting down"));
      }
      pendingClients = 0;
      parked.length = 0;

      for (const ws of clients) {
        abortTurn(ws.data.current, "web voice server shutting down");
        ws.data.pending = null;
        ws.data.latestProbeTurnId = null;
        const spec = ws.data.spec;
        ws.data.spec = null;
        if (spec) liveSpecs.add(spec.turn);
        try { ws.close(1012, "Server shutting down"); } catch { /* already closing */ }
        try {
          ws.terminate();
          // A forced terminate transfers socket ownership back to the runtime
          // synchronously. Bun need not emit close for an already-closing peer;
          // retaining it here would make every bounded stop retry wait forever.
          clients.delete(ws);
        } catch { /* runtime still owns it; close callback/retry will confirm */ }
      }
      const speculativeAborts = [...liveSpecs].map((spec) => abortSpec(spec));
      const jobsDrained = waitForDrain();
      // Let an owned async WebSocket callback return and Bun update its socket
      // bookkeeping before stop(true); invoking stop from the peer's final
      // message event can otherwise strand the runtime's pending counter.
      const listenerStopped = jobsDrained
        .then(() => new Promise<void>((resolve) => { setTimeout(resolve, 0); }))
        .then(stopListener);

      const attempt = withinShutdownDeadline(
        Promise.all([
          listenerStopped,
          jobsDrained,
          Promise.all(speculativeAborts).then(() => undefined),
        ]).then(() => undefined),
        shutdownDrainTimeoutMs,
      );
      stopPromise = attempt;
      void attempt.catch(() => {
        // The listener is already quiesced. Let a caller retry the bounded
        // drain after a transient/late handler eventually settles.
        if (stopPromise === attempt) stopPromise = null;
      });
      return attempt;
    };

    return {
      scheme,
      port: server.port ?? port,
      clientCount: () => clients.size,
      notify,
      stop,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `web-voice server failed to start on ${host}:${port}: ${msg}`);
    return null;
  }
}
