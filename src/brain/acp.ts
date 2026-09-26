import type { Brain, BrainStructuredUpdate, BrainTurnOptions, PendingConfirmation } from "../types";
import { log } from "../logger";
import { createHash, randomBytes } from "node:crypto";
import { clearAcpSession, readAcpSession, writeAcpSession, type StoredAcpSession } from "./acp-session-store";
import { dashBus } from "../dashboard/bus";
import { redactSnapshotSecrets } from "../operational-state";
import { TOOL_START_NOTICE } from "../speaker/thinking-filler";
import { BrainTurnContext } from "./turn-context";
import { confirmationDecision, createConfirmationNonce, permissionNotice } from "./approval";
import {
  spawnOwnedProcess,
  terminateOwnedProcessTree,
} from "../process/owned-process";
import {
  DEFAULT_ACP_QUEUE_LIMIT_BYTES,
  DEFAULT_ACP_RESPONSE_LIMIT_BYTES,
  DEFAULT_ACP_FRAME_LIMIT_BYTES,
  DEFAULT_ACP_PENDING_TURN_LIMIT,
  MAX_ACP_TEXT_LIMIT_BYTES,
  MAX_ACP_PENDING_TURN_LIMIT,
} from "./acp-limits";
export {
  DEFAULT_ACP_QUEUE_LIMIT_BYTES,
  DEFAULT_ACP_RESPONSE_LIMIT_BYTES,
  DEFAULT_ACP_FRAME_LIMIT_BYTES,
  DEFAULT_ACP_PENDING_TURN_LIMIT,
  MAX_ACP_TEXT_LIMIT_BYTES,
  MAX_ACP_PENDING_TURN_LIMIT,
} from "./acp-limits";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  sessionNotificationSchema,
  type AnyMessage,
  type Client,
  type Stream,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type InitializeResponse,
  type Stdio,
} from "@zed-industries/agent-client-protocol";

export type AcpStructuredUpdate = BrainStructuredUpdate;
export function resumableAcpSession(
  stored: StoredAcpSession | null,
  enabled: boolean,
  maxAgeHours: number,
  now: number,
): string | null {
  return enabled && stored && stored.lastUsedAt <= now
    && now - stored.lastUsedAt <= maxAgeHours * 3_600_000
    ? stored.sessionId : null;
}
export async function openAcpSession(
  conn: Pick<ClientSideConnection, "loadSession" | "newSession">,
  request: { cwd: string; mcpServers: Stdio[] },
  storedId: string | null,
  canLoad: boolean,
  run: <T>(operation: Promise<T>, label: string) => Promise<T>,
  fatalLoadError: (error: unknown) => boolean = () => false,
): Promise<{ sessionId: string; restored: boolean }> {
  if (storedId && canLoad) {
    try {
      await run(conn.loadSession({ ...request, sessionId: storedId }), "loadSession");
      return { sessionId: storedId, restored: true };
    } catch (error) {
      if (fatalLoadError(error)) throw error;
    }
  }
  const session = await run(conn.newSession(request), "newSession");
  return { sessionId: session.sessionId, restored: false };
}
const MAX_STRUCTURED_UPDATES = 64;
const MAX_STRUCTURED_EVENTS = 128;
const MAX_PLAN_ENTRIES = 32;
const MAX_STRUCTURED_TITLE = 160;
function safeTitle(value: string): string {
  return redactSnapshotSecrets(value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, MAX_STRUCTURED_TITLE)).slice(0, MAX_STRUCTURED_TITLE);
}

export class AcpFrameLimitError extends Error {
  constructor(readonly limitBytes: number) {
    super(`ACP NDJSON frame exceeded its ${limitBytes}-byte limit`);
    this.name = "AcpFrameLimitError";
  }
}

export class AcpMalformedFrameError extends Error {
  constructor(readonly toleratedFrames: number) {
    super(`ACP peer exceeded its allowance of ${toleratedFrames} malformed NDJSON frames`);
    this.name = "AcpMalformedFrameError";
  }
}

interface BoundedNdJsonOptions {
  maxFrameBytes?: number;
  /** Inbound requests allowed before their response writes complete. */
  maxInboundRequests?: number;
  onError?: (error: Error) => void;
}

const DEFAULT_ACP_INBOUND_REQUEST_LIMIT = 32;
const MAX_ACP_INBOUND_REQUEST_LIMIT = 1_024;
const MAX_TOLERATED_MALFORMED_ACP_FRAMES = 8;
const MAX_DETAILED_MALFORMED_ACP_WARNINGS = 3;

/**
 * ACP's dependency parser buffers text until a newline with no ceiling. Parse
 * bounded byte frames here instead, before untrusted agent output reaches the
 * protocol connection or the per-turn text queue.
 */
export function boundedNdJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  options: BoundedNdJsonOptions = {},
): Stream {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_ACP_FRAME_LIMIT_BYTES;
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > MAX_ACP_TEXT_LIMIT_BYTES) {
    throw new RangeError(`ACP frame limit must be an integer from 1 through ${MAX_ACP_TEXT_LIMIT_BYTES}`);
  }
  const maxInboundRequests = options.maxInboundRequests ?? DEFAULT_ACP_INBOUND_REQUEST_LIMIT;
  if (
    !Number.isInteger(maxInboundRequests)
    || maxInboundRequests < 1
    || maxInboundRequests > MAX_ACP_INBOUND_REQUEST_LIMIT
  ) {
    throw new RangeError(
      `ACP inbound request limit must be an integer from 1 through ${MAX_ACP_INBOUND_REQUEST_LIMIT}`,
    );
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = new Uint8Array(Math.min(4 * 1024, maxFrameBytes));
  let pendingBytes = 0;
  let finished = false;
  let outstandingInboundRequests = 0;
  let creditWake: (() => void) | null = null;
  let malformedFrames = 0;
  let errorReported = false;
  let readableController: ReadableStreamDefaultController<AnyMessage> | null = null;

  const reportProtocolError = (error: Error): void => {
    if (errorReported) return;
    errorReported = true;
    try { options.onError?.(error); } catch { /* lifecycle callback is best effort */ }
  };

  const wakeCreditWaiter = (): void => {
    if (!creditWake) return;
    const wake = creditWake;
    creditWake = null;
    wake();
  };
  const releaseInboundRequest = (): void => {
    if (outstandingInboundRequests === 0) return;
    outstandingInboundRequests--;
    wakeCreditWaiter();
  };
  const isInboundRequest = (message: AnyMessage): boolean =>
    "method" in message && "id" in message;
  const isOutboundResponse = (message: AnyMessage): boolean =>
    !("method" in message) && "id" in message;

  const ensureCapacity = (required: number): void => {
    if (required <= pending.byteLength) return;
    const nextSize = Math.min(maxFrameBytes, Math.max(required, pending.byteLength * 2));
    const next = new Uint8Array(nextSize);
    next.set(pending.subarray(0, pendingBytes));
    pending = next;
  };
  const append = (bytes: Uint8Array): void => {
    if (bytes.byteLength > maxFrameBytes - pendingBytes) throw new AcpFrameLimitError(maxFrameBytes);
    if (bytes.byteLength === 0) return;
    ensureCapacity(pendingBytes + bytes.byteLength);
    pending.set(bytes, pendingBytes);
    pendingBytes += bytes.byteLength;
  };
  const parseLine = (tail: Uint8Array): AnyMessage | null => {
    if (tail.byteLength > maxFrameBytes - pendingBytes) throw new AcpFrameLimitError(maxFrameBytes);
    const totalBytes = pendingBytes + tail.byteLength;
    let frame: Uint8Array;
    if (pendingBytes === 0) {
      frame = tail;
    } else {
      ensureCapacity(totalBytes);
      pending.set(tail, pendingBytes);
      frame = pending.subarray(0, totalBytes);
    }
    pendingBytes = 0;
    const line = decoder.decode(frame).trim();
    if (!line) return null;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("ACP JSON-RPC frame must be an object");
      }
      return parsed as AnyMessage;
    } catch (error: unknown) {
      // Preserve the dependency's compatibility behavior for a small number of
      // malformed records, then fail closed before diagnostics/CPU are abused.
      malformedFrames++;
      if (malformedFrames <= MAX_DETAILED_MALFORMED_ACP_WARNINGS) {
        console.error("Failed to parse JSON message:", line.slice(0, 200), error);
      } else if (malformedFrames === MAX_DETAILED_MALFORMED_ACP_WARNINGS + 1) {
        console.error("Suppressing additional malformed ACP frame diagnostics");
      }
      if (malformedFrames > MAX_TOLERATED_MALFORMED_ACP_FRAMES) {
        throw new AcpMalformedFrameError(MAX_TOLERATED_MALFORMED_ACP_FRAMES);
      }
      return null;
    }
  };

  const reader = input.getReader();
  let currentChunk: Uint8Array | null = null;
  let currentOffset = 0;
  let released = false;
  const releaseReader = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const readable = new ReadableStream<AnyMessage>({
    start(controller): void {
      readableController = controller;
    },
    async pull(controller): Promise<void> {
      try {
        while (!finished) {
          // The ACP dependency dispatches requests without awaiting their
          // handlers. Couple reads to completed response writes so a peer that
          // floods requests while not reading stdout cannot grow its internal
          // write queue without bound.
          while (!finished && outstandingInboundRequests >= maxInboundRequests) {
            await new Promise<void>((resolve) => { creditWake = resolve; });
          }
          if (finished) return;

          if (!currentChunk || currentOffset >= currentChunk.byteLength) {
            const item = await reader.read();
            if (finished) return;
            if (item.done) {
              finished = true;
              pending = new Uint8Array(0);
              pendingBytes = 0; // preserve ACP's newline-terminated frame contract
              wakeCreditWaiter();
              releaseReader();
              try { controller.close(); } catch { /* consumer already cancelled */ }
              readableController = null;
              return;
            }
            currentChunk = item.value;
            currentOffset = 0;
          }

          let newline = -1;
          for (let index = currentOffset; index < currentChunk.byteLength; index++) {
            if (currentChunk[index] === 0x0a) {
              newline = index;
              break;
            }
          }
          if (newline < 0) {
            append(currentChunk.subarray(currentOffset));
            currentChunk = null;
            currentOffset = 0;
            continue;
          }

          const message = parseLine(currentChunk.subarray(currentOffset, newline));
          currentOffset = newline + 1;
          if (currentOffset >= currentChunk.byteLength) {
            currentChunk = null;
            currentOffset = 0;
          }
          if (message) {
            if (isInboundRequest(message)) outstandingInboundRequests++;
            controller.enqueue(message);
            return;
          }
        }
      } catch (error: unknown) {
        finished = true;
        currentChunk = null;
        pending = new Uint8Array(0);
        pendingBytes = 0;
        wakeCreditWaiter();
        const protocolError = error instanceof Error ? error : new Error(String(error));
        reportProtocolError(protocolError);
        try { controller.close(); } catch { /* consumer already cancelled */ }
        readableController = null;
        void reader.cancel(protocolError)
          .then(releaseReader, releaseReader)
          .catch(() => { /* input already closed */ });
      }
    },
    async cancel(reason): Promise<void> {
      finished = true;
      currentChunk = null;
      pending = new Uint8Array(0);
      pendingBytes = 0;
      wakeCreditWaiter();
      readableController = null;
      try {
        await reader.cancel(reason);
      } catch { /* input already closed */
      } finally {
        releaseReader();
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(message): Promise<void> {
      try {
        let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
        try {
          writer = output.getWriter();
          await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
        } finally {
          // Completion includes transport rejection: either way, do not leave
          // a request credit permanently wedged in this parser.
          if (isOutboundResponse(message)) releaseInboundRequest();
          writer?.releaseLock();
        }
      } catch (error: unknown) {
        const transportError = error instanceof Error ? error : new Error(String(error));
        finished = true;
        currentChunk = null;
        pending = new Uint8Array(0);
        pendingBytes = 0;
        wakeCreditWaiter();
        reportProtocolError(transportError);
        try { readableController?.close(); } catch { /* consumer already cancelled */ }
        readableController = null;
        void reader.cancel(transportError)
          .then(releaseReader, releaseReader)
          .catch(() => { /* input already closed */ });
        throw transportError;
      }
    },
  });
  return { readable, writable };
}

/** An agent's own estimate of how full its context window is, in tokens. */
export interface AcpContextUsage { used: number; size: number }

const MAX_CONTEXT_TOKENS = 100_000_000;

/** Accept only sane integer token counts from an untrusted agent frame. */
export function parseContextUsage(update: unknown): AcpContextUsage | null {
  if (!update || typeof update !== "object") return null;
  const { used, size } = update as { used?: unknown; size?: unknown };
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(size)) return null;
  const u = used as number, s = size as number;
  if (u < 0 || s <= 0 || s > MAX_CONTEXT_TOKENS || u > MAX_CONTEXT_TOKENS) return null;
  return { used: u, size: s };
}

/**
 * Drop session/update notifications the spec schema doesn't know — e.g. hermes'
 * "usage_update" context-usage extension. The library zod-validates before our
 * callback runs and console.errors a full multi-line dump per unknown
 * notification (one per turn); filtering here keeps the log clean without
 * touching updates we actually consume.
 *
 * A well-formed "usage_update" is still reported to `onUsage` before it is
 * dropped: it is the only signal of how full the agent's context is.
 */
export function dropOffSpecUpdates(
  readable: ReadableStream<unknown>,
  onUsage?: (usage: AcpContextUsage) => void,
): ReadableStream<unknown> {
  const warned = new Set<string>();
  let warnedAboutLimit = false;
  return readable.pipeThrough(
    new TransformStream<unknown, unknown>({
      transform(msg, controller) {
        const m = msg as { id?: unknown; method?: unknown; params?: { update?: { sessionUpdate?: unknown } } };
        if (m && m.method === "session/update" && m.id === undefined && !sessionNotificationSchema.safeParse(m.params).success) {
          const rawKind = m.params?.update?.sessionUpdate;
          if (rawKind === "usage_update" && onUsage) {
            const usage = parseContextUsage(m.params?.update);
            if (usage) onUsage(usage);
          }
          const kind = (
            typeof rawKind === "string"
            || typeof rawKind === "number"
            || typeof rawKind === "boolean"
          ) ? String(rawKind).slice(0, 128) : "unknown";
          if (!warned.has(kind)) {
            if (warned.size < 32) {
              warned.add(kind);
              log("info", "acp: ignoring off-spec session update from the agent");
            } else if (!warnedAboutLimit) {
              warnedAboutLimit = true;
              log("info", "acp: ignoring additional off-spec session update kinds from the agent");
            }
          }
          return;
        }
        controller.enqueue(msg);
      },
    }),
  );
}

/** How long one spoken "yes" authorizes the agent's retry of a gated tool. */
const CONFIRM_GRANT_MS = 60_000;
/** How long a gated denial waits for a spoken approval before expiring. */
const CONFIRM_PENDING_MS = 120_000;
/** Restart a wedged ACP session rather than releasing its turn lock unsafely. */
const CANCEL_SETTLE_MS = 5_000;
/** Give a cooperative agent a brief chance to observe session/cancel before TERM. */
const STOP_CANCEL_FLUSH_MS = 100;
/** Graceful process-group shutdown window before escalation to SIGKILL. */
const DEFAULT_TERMINATE_GRACE_MS = 500;
/** Keep programmer-supplied cleanup windows within a voice-session timescale. */
const MAX_ACP_CLEANUP_WAIT_MS = 60_000;
/** Avoid overflowing the host timer while allowing slower remote ACP startup. */
const MAX_ACP_START_WAIT_MS = 300_000;
/** Bound on confirming leader reap and POSIX process-group disappearance. */
const REAP_CONFIRM_MS = 2_000;
const QUEUE_COMPACT_MIN_HEAD = 1_024;
const UTF8 = new TextEncoder();

interface PendingConfirmationState extends PendingConfirmation {
  at: number;
  operationKey: string;
}

interface ConfirmationGrant {
  until: number;
  operationKey: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Bind retries to the operation, excluding ACP's per-attempt transport id. */
function permissionOperationKey(toolCall: unknown): string {
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return canonicalJson(toolCall);
  // Object.fromEntries defines data properties without invoking the legacy
  // __proto__ setter, so an agent-controlled payload cannot erase a field from
  // the operation identity through prototype mutation.
  const operation = Object.fromEntries(
    Object.entries(toolCall).filter(([key]) => key !== "toolCallId"),
  );
  return canonicalJson(operation);
}

export interface AcpBrainConfig {
  /** Command that launches an ACP agent over stdio, e.g. "ssh" / "hermes" / "bun". */
  binary: string;
  /** Args before the (stdio-spoken) protocol, e.g. ["gpu-box", "hermes", "acp"]. */
  args?: string[];
  /** Working directory for the agent session (defaults to the daemon's cwd). */
  cwd?: string;
  /** Private path for this brain/lane's durable ACP session pointer. */
  sessionFile?: string;
  /** Resume a durable session when it is recent enough (default true). */
  sessionResume?: boolean;
  /** Maximum idle age for a stored session, in hours (default 12). */
  sessionResumeMaxAgeHours?: number;
  /** Clock in milliseconds since the Unix epoch; injectable for tests. */
  now?: () => number;
  /** Optional stdio MCP servers supplied at newSession or loadSession. */
  mcpServers?: Stdio[];
  /** Receives sanitized, bounded structured updates during a live turn. */
  onStructuredUpdate?: (update: AcpStructuredUpdate) => void;
  /** Extra env for the agent subprocess. */
  env?: Record<string, string>;
  /** Env vars to drop (e.g. ["CLAUDECODE"] so claude-code-acp can run un-nested). */
  unsetEnv?: string[];
  /** Auto-allow the agent's tool-permission requests (so a voice user can "do stuff"). */
  autoApproveTools?: boolean;
  /**
   * Spoken confirmation gate: tool-permission requests whose payload matches any
   * of these case-insensitive substrings are DENIED (fail closed) even when
   * autoApproveTools is on — until the user's next utterance is an approval
   * ("yes", "go ahead", …), which opens a one-shot 60s window for that exact
   * operation's retry.
   * E.g. ["git push", "rm -rf", "sudo", "deploy"].
   */
  confirmTools?: string[];
  /** Called when a matching permission request arms the spoken-confirmation gate.
   * The nonce names THIS gate — remote approvals echo it back so a stale button
   * from an earlier gate can never resolve a newer one. */
  onConfirmationPending?: (summary: string, nonce: string) => void | Promise<void>;
  /** Called with the auto-retry brain reply after an approved confirmation nudge completes. */
  onNudgeReply?: (text: string) => void;
  /** Auto-send a retry turn when a pending confirmation is approved. Default true. */
  confirmRetry?: boolean;
  /** Bound on the initialize + newSession handshake so a silent agent can't hang startup. */
  startTimeoutMs?: number;
  /** Maximum UTF-8 bytes waiting between ACP updates and a sendStream() consumer. */
  maxQueuedBytes?: number;
  /** Maximum UTF-8 bytes accumulated by send(); sendStream() remains incremental. */
  maxResponseBytes?: number;
  /** Maximum raw bytes in one inbound ACP NDJSON frame. */
  maxFrameBytes?: number;
  /** Maximum active + queued turns admitted to this stateful session. */
  maxPendingTurns?: number;
  /** Process TERM grace before KILL. Primarily exposed for deterministic tests. */
  terminateGraceMs?: number;
  /** Protocol cancellation settlement window. Primarily exposed for deterministic tests. */
  cancelSettleMs?: number;
  /**
   * Compact the agent's context while the conversation is idle, instead of
   * letting the agent do it in the middle of a spoken turn. `idleMs` after the
   * last turn, if the agent's last reported usage ("usage_update") is at least
   * `minUsage` of its window, `command` is sent as a raw prompt with no
   * injected context — e.g. hermes' "/compress". At most once per idle period.
   */
  idleCompact?: AcpIdleCompactConfig;
}

export interface AcpIdleCompactConfig {
  command: string;
  idleMs: number;
  /** Fraction of the context window, 0 < minUsage <= 1. */
  minUsage: number;
}

/** A compaction that outlives this is cancelled like any other turn. */
const IDLE_COMPACT_DEADLINE_MS = 300_000;

/**
 * Pull a human-readable message out of an ACP/JSON-RPC error. The library rejects
 * with a plain `{ code, message, data }` object (not an `Error`), which otherwise
 * stringifies to the useless "[object Object]" — hiding causes like "Invalid API key".
 */
function describeAcpError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown; data?: unknown };
    const parts: string[] = [];
    if (e.message !== undefined) parts.push(String(e.message));
    if (e.data !== undefined) parts.push(typeof e.data === "string" ? e.data : JSON.stringify(e.data));
    if (e.code !== undefined) parts.push(`(code ${String(e.code)})`);
    if (parts.length > 0) return parts.join(" ");
  }
  return String(err);
}

/**
 * Push/close async queue that bridges the agent's callback-style `session/update`
 * notifications into an async generator the listen loop can `for await` over.
 */
export class AcpQueueOverflowError extends Error {
  constructor(readonly limitBytes: number) {
    super(`ACP stream queue exceeded its ${limitBytes}-byte limit`);
    this.name = "AcpQueueOverflowError";
  }
}

export class AcpResponseLimitError extends Error {
  constructor(readonly limitBytes: number) {
    super(`ACP response exceeded its ${limitBytes}-byte aggregation limit`);
    this.name = "AcpResponseLimitError";
  }
}

export class AcpTurnAdmissionError extends Error {
  constructor(readonly limit: number) {
    super(`ACP session already has its maximum of ${limit} active or queued turns`);
    this.name = "AcpTurnAdmissionError";
  }
}

interface QueuedChunk {
  text: string;
  bytes: number;
}

export class ChunkQueue {
  private chunks: Array<QueuedChunk | null> = [];
  private head = 0;
  private byteLength = 0;
  private wake: (() => void) | null = null;
  private ended = false;
  private error: Error | null = null;

  constructor(
    readonly limitBytes: number = DEFAULT_ACP_QUEUE_LIMIT_BYTES,
    private readonly onOverflow?: (error: AcpQueueOverflowError) => void,
  ) {
    if (!Number.isInteger(limitBytes) || limitBytes < 1 || limitBytes > MAX_ACP_TEXT_LIMIT_BYTES) {
      throw new RangeError(`ACP queue limit must be an integer from 1 through ${MAX_ACP_TEXT_LIMIT_BYTES}`);
    }
  }

  get queuedBytes(): number {
    return this.byteLength;
  }

  push(chunk: string): boolean {
    if (this.ended) return false;
    // Empty text updates carry no stream information. Retaining them would let
    // a noisy or hostile agent grow the slot array without consuming any of the
    // byte budget.
    if (chunk.length === 0) return true;
    const bytes = UTF8.encode(chunk).byteLength;
    if (bytes > this.limitBytes - this.byteLength) {
      const error = new AcpQueueOverflowError(this.limitBytes);
      this.end(error, true);
      this.onOverflow?.(error);
      return false;
    }
    this.chunks.push({ text: chunk, bytes });
    this.byteLength += bytes;
    this.signal();
    return true;
  }

  end(error?: Error, discard = false): void {
    if (this.ended) {
      if (discard) {
        this.chunks = [];
        this.head = 0;
        this.byteLength = 0;
        if (error) this.error = error;
        this.signal();
      }
      return;
    }
    if (discard) {
      this.chunks = [];
      this.head = 0;
      this.byteLength = 0;
    }
    this.error = error ?? null;
    this.ended = true;
    this.signal();
  }

  private signal(): void {
    if (this.wake) {
      const wake = this.wake;
      this.wake = null;
      wake();
    }
  }

  async *drain(): AsyncGenerator<string> {
    while (true) {
      while (this.head < this.chunks.length) {
        const index = this.head++;
        const chunk = this.chunks[index];
        if (!chunk) continue;
        // Release the potentially large string before yielding. Head-index
        // compaction remains amortized, but sub-threshold consumed slots no
        // longer retain their payloads.
        this.chunks[index] = null;
        this.byteLength -= chunk.bytes;
        this.compact();
        yield chunk.text;
      }
      if (this.head > 0) {
        this.chunks = [];
        this.head = 0;
      }
      if (this.ended) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }

  private compact(): void {
    if (this.head < QUEUE_COMPACT_MIN_HEAD || this.head * 2 < this.chunks.length) return;
    this.chunks = this.chunks.slice(this.head);
    this.head = 0;
  }
}

type OwnedAcpProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

interface ActiveAcpTurn {
  queue: ChunkQueue;
  rowTurnId?: string;
  structured: AcpStructuredUpdate[];
  structuredEvents: number;
  onStructuredUpdate?: (update: AcpStructuredUpdate) => void;
  cancelled: boolean;
  settled: boolean;
  cancellation: Promise<void> | null;
  notifyCancel: () => Promise<void>;
  cancel: (error?: Error) => void;
  onNotice?: BrainTurnOptions["onNotice"];
  toolNoticeSent: boolean;
  permissionHold?: BrainTurnOptions["speculativePermissionHold"];
  speculative: boolean;
}

interface AcpRuntime {
  generation: number;
  proc: OwnedAcpProcess;
  conn: ClientSideConnection | null;
  sessionId: string | null;
  sessionIdentity: string | null;
  initialize: InitializeResponse | null;
  restored: boolean;
  activeTurn: ActiveAcpTurn | null;
  stderrDrain: Promise<void>;
  stopped: Promise<void>;
  markStopped: () => void;
  disposing: Promise<void> | null;
  stopping: boolean;
}

class AcpProcessReapError extends Error {
  constructor(readonly pid: number, detail: string, options?: ErrorOptions) {
    super(`ACP process ${pid} ${detail}`, options);
    this.name = "AcpProcessReapError";
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function terminateOwnedAcpProcess(proc: OwnedAcpProcess, graceMs: number): Promise<void> {
  try {
    await terminateOwnedProcessTree(proc, {
      terminateGraceMs: graceMs,
      reapTimeoutMs: REAP_CONFIRM_MS,
    });
  } catch (error: unknown) {
    throw new AcpProcessReapError(
      proc.pid,
      `cleanup failed: ${describeAcpError(error)}`,
      { cause: error },
    );
  }
}

/**
 * A {@link Brain} that talks to any ACP (Agent Client Protocol) agent over stdio.
 *
 * ACP is a harness-independent standard — Hermes (`hermes acp`), Gemini CLI, and
 * Claude Code all speak it — so the *same* backend points at any agent via config:
 *   - Hermes over LAN: `{ binary: "ssh", args: ["gpu-box", "hermes", "acp"] }`
 *   - local Claude Code: `{ binary: "bun", args: ["x", "@zed-industries/claude-code-acp@0.16.2"] }`
 *
 * Unlike the per-turn CLI brains, this holds ONE persistent connection + session
 * for the life of the daemon, so the agent keeps its memory across turns (real
 * back-and-forth). Tool calls run in the agent's own environment; permission
 * requests are auto-approved when {@link AcpBrainConfig.autoApproveTools} is set.
 */
export class AcpBrain implements Brain {
  canDeferSpeculativePermissions(): boolean { return true; }
  private readonly rowSourceId = (() => {
    const id = randomBytes(16).toString("hex");
    return `b${id.slice(0, 16)}|${id.slice(16)}`;
  })();
  private rowTurnSequence = 0;
  private skipStoredSession = false;
  private sessionPointerEpoch = 0;
  private sessionPointerWrite: Promise<void> = Promise.resolve();
  private runtime: AcpRuntime | null = null;
  private generation = 0;
  private desiredRunning = false;
  private lifecycleEpoch = 0;
  private startOperation: Promise<void> | null = null;
  private startOperationEpoch = 0;
  private stopOperation: Promise<void> | null = null;
  private turnContext = new BrainTurnContext();
  // The host mic, POST path, and web sockets share one stateful ACP session. Each
  // reservation owns an independently releasable gate so stop() can settle both
  // an active silent turn and every queued waiter even if a stream consumer is
  // paused after a yield.
  private turnLock: Promise<void> = Promise.resolve();
  private readonly turnReleases = new Set<() => void>();
  private readonly pendingReservations = new Set<object>();
  // Spoken confirmation gate state — see AcpBrainConfig.confirmTools.
  private confirmationGrant: ConfirmationGrant | null = null;
  private pendingConfirmation: PendingConfirmationState | null = null;
  private contextUsage: AcpContextUsage | null = null;
  private idleCompactTimer: ReturnType<typeof setTimeout> | null = null;
  private idleCompacting = false;
  private readonly config: AcpBrainConfig;

  constructor(config: AcpBrainConfig) {
    if (config.sessionResume !== undefined && typeof config.sessionResume !== "boolean") {
      throw new TypeError("sessionResume must be a boolean");
    }
    const maxAge = config.sessionResumeMaxAgeHours ?? 12;
    if (typeof maxAge !== "number" || !Number.isFinite(maxAge) || maxAge <= 0 || maxAge > 720) {
      throw new RangeError("sessionResumeMaxAgeHours must be greater than 0 and at most 720");
    }
    for (const [name, value] of [
      ["maxQueuedBytes", config.maxQueuedBytes ?? DEFAULT_ACP_QUEUE_LIMIT_BYTES],
      ["maxResponseBytes", config.maxResponseBytes ?? DEFAULT_ACP_RESPONSE_LIMIT_BYTES],
      ["maxFrameBytes", config.maxFrameBytes ?? DEFAULT_ACP_FRAME_LIMIT_BYTES],
    ] as const) {
      if (!Number.isInteger(value) || value < 1 || value > MAX_ACP_TEXT_LIMIT_BYTES) {
        throw new RangeError(`${name} must be an integer from 1 through ${MAX_ACP_TEXT_LIMIT_BYTES}`);
      }
    }
    const maxPendingTurns = config.maxPendingTurns ?? DEFAULT_ACP_PENDING_TURN_LIMIT;
    if (!Number.isInteger(maxPendingTurns) || maxPendingTurns < 1 || maxPendingTurns > MAX_ACP_PENDING_TURN_LIMIT) {
      throw new RangeError(`maxPendingTurns must be an integer from 1 through ${MAX_ACP_PENDING_TURN_LIMIT}`);
    }
    for (const [name, value, maximum] of [
      ["terminateGraceMs", config.terminateGraceMs, MAX_ACP_CLEANUP_WAIT_MS],
      ["cancelSettleMs", config.cancelSettleMs, MAX_ACP_CLEANUP_WAIT_MS],
      ["startTimeoutMs", config.startTimeoutMs, MAX_ACP_START_WAIT_MS],
    ] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > maximum)) {
        throw new RangeError(`${name} must be a finite non-negative number no greater than ${maximum}`);
      }
    }
    if (config.mcpServers !== undefined) {
      if (!Array.isArray(config.mcpServers) || config.mcpServers.length > 8) {
        throw new RangeError("mcpServers must contain at most 8 stdio servers");
      }
      const serverNames = new Set<string>();
      for (const server of config.mcpServers) {
        if (!server || typeof server.name !== "string" || !server.name.trim() || server.name.length > 256
          || Object.keys(server).some((key) => !["name", "command", "args", "env"].includes(key))
          || serverNames.has(server.name)
          || typeof server.command !== "string" || !server.command.trim() || server.command.length > 256
          || !Array.isArray(server.args) || server.args.length > 16
          || server.args.some((arg) => typeof arg !== "string" || arg.length > 512)
          || !Array.isArray(server.env) || server.env.length > 16
          || server.env.some((item) => !item || typeof item.name !== "string"
            || Object.keys(item).some((key) => !["name", "value"].includes(key))
            || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item.name)
            || typeof item.value !== "string" || item.value.length > 4096)) {
          throw new RangeError("mcpServers contains an invalid stdio server");
        }
        serverNames.add(server.name);
      }
    }
    const idle = config.idleCompact;
    if (idle !== undefined) {
      if (typeof idle.command !== "string" || !idle.command.trim() || idle.command.length > 256) {
        throw new RangeError("idleCompact.command must be a non-empty string of at most 256 characters");
      }
      if (!Number.isFinite(idle.idleMs) || idle.idleMs < 1_000 || idle.idleMs > 86_400_000) {
        throw new RangeError("idleCompact.idleMs must be from 1000 through 86400000");
      }
      if (!Number.isFinite(idle.minUsage) || idle.minUsage <= 0 || idle.minUsage > 1) {
        throw new RangeError("idleCompact.minUsage must be greater than 0 and at most 1");
      }
    }
    this.config = config;
  }

  /** The agent's last reported context usage, if it reports one. */
  lastContextUsage(): AcpContextUsage | null { return this.contextUsage; }

  private cancelIdleCompact(): void {
    if (this.idleCompactTimer) clearTimeout(this.idleCompactTimer);
    this.idleCompactTimer = null;
  }

  private scheduleIdleCompact(): void {
    const idle = this.config.idleCompact;
    this.cancelIdleCompact();
    if (!idle || !this.desiredRunning) return;
    const timer = setTimeout(() => {
      if (this.idleCompactTimer !== timer) return;
      this.idleCompactTimer = null;
      void this.runIdleCompact(idle);
    }, idle.idleMs);
    (timer as { unref?: () => void }).unref?.();
    this.idleCompactTimer = timer;
  }

  private async runIdleCompact(idle: AcpIdleCompactConfig): Promise<void> {
    const usage = this.contextUsage;
    if (!usage || usage.used / usage.size < idle.minUsage) return;
    // Anything queued or live means the conversation is not idle after all.
    if (this.idleCompacting || this.pendingReservations.size > 0 || this.runtime?.activeTurn || !this.runtime?.conn) return;
    this.idleCompacting = true;
    const percent = Math.round((usage.used / usage.size) * 100);
    log("info", `acp: idle compaction — context ${percent}% full; sending ${idle.command}`);
    let reply = "";
    try {
      // Through the turn lock like any turn: a real turn arriving now waits
      // behind it instead of racing the agent's own compaction.
      for await (const chunk of this.turnStream(idle.command, { signal: AbortSignal.timeout(IDLE_COMPACT_DEADLINE_MS) }, true)) {
        if (reply.length < 512) reply += chunk;
      }
      const summary = this.redactAgentText(reply).replace(/\s+/g, " ").trim().slice(0, 200);
      log("info", `acp: idle compaction finished${summary ? `: ${summary}` : ""}`);
    } catch (error: unknown) {
      log("warn", `acp: idle compaction failed: ${this.describeAgentError(error)}`);
    } finally {
      this.idleCompacting = false;
    }
  }

  sessionRestored(): boolean { return this.runtime?.restored ?? false; }

  private redactAgentText(text: string): string {
    let result = redactSnapshotSecrets(text);
    for (const server of this.config.mcpServers ?? []) {
      for (const variable of server.env) {
        if (variable.value) result = result.split(variable.value).join("[redacted]");
      }
    }
    return result;
  }

  private describeAgentError(error: unknown): string {
    return this.redactAgentText(describeAcpError(error));
  }

  private safeToolCallId(value: string): string {
    // Preserve ordinary ACP IDs for clients. Hash long, unsafe, or secret-like
    // IDs so correlation remains stable without exposing their original value.
    if (/^[A-Za-z0-9._:-]{1,128}$/.test(value) && this.redactAgentText(value) === value) return value;
    // The dashboard redactor treats one long hash as a secret. Split the full
    // digest into short chunks so identity survives its second sanitization.
    const digest = createHash("sha256").update(value).digest("hex");
    return `h${digest.match(/.{1,16}/g)!.join("|")}`;
  }

  private saveSessionPointer(path: string, identity: string, sessionId: string, at: number): Promise<void> {
    const epoch = this.sessionPointerEpoch;
    const write = this.sessionPointerWrite.catch(() => {}).then(async () => {
      if (epoch === this.sessionPointerEpoch) await writeAcpSession(path, identity, sessionId, at);
    });
    this.sessionPointerWrite = write;
    return write;
  }

  async start(): Promise<void> {
    try {
      const epoch = this.setDesiredRunning(true);
      await this.ensureStarted(epoch);
    } catch (error: unknown) {
      throw error;
    }
  }

  async stop(): Promise<void> {
    // A capability belongs to one live ACP session. Never carry a pending gate
    // or one-shot grant across stop/restart into a different agent session.
    this.setDesiredRunning(false);
    this.clearConfirmationState();
    try {
      await this.stopCurrentRuntime(new Error("ACP brain stopped"));
    } catch (error: unknown) {
      throw error;
    }
  }

  async send(message: string, options?: BrainTurnOptions): Promise<string> {
    const limit = this.config.maxResponseBytes ?? DEFAULT_ACP_RESPONSE_LIMIT_BYTES;
    const aggregateAbort = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([options.signal, aggregateAbort.signal])
      : aggregateAbort.signal;
    const chunks: string[] = [];
    let bytes = 0;
    try {
      for await (const chunk of this.sendStream(message, { ...options, signal })) {
        const nextBytes = UTF8.encode(chunk).byteLength;
        if (nextBytes > limit - bytes) {
          const error = new AcpResponseLimitError(limit);
          aggregateAbort.abort(error);
          throw error;
        }
        bytes += nextBytes;
        chunks.push(chunk);
      }
      return chunks.join("").trim();
    } catch (error: unknown) {
      throw error;
    }
  }

  async *sendStream(message: string, options: BrainTurnOptions = {}): AsyncGenerator<string> {
    this.cancelIdleCompact();
    try {
      yield* this.turnStream(message, options, false);
    } finally {
      this.scheduleIdleCompact();
    }
  }

  /** `raw` sends `message` verbatim: no injected context, no approval bookkeeping. */
  private async *turnStream(message: string, options: BrainTurnOptions, raw: boolean): AsyncGenerator<string> {
    const reservedRuntime = this.runtime;
    if (!reservedRuntime?.conn || !reservedRuntime.sessionId) {
      throw new Error("ACP brain not started — call start() first");
    }
    const reservedGeneration = reservedRuntime.generation;
    const maxPendingTurns = this.config.maxPendingTurns ?? DEFAULT_ACP_PENDING_TURN_LIMIT;
    if (this.pendingReservations.size >= maxPendingTurns) {
      throw new AcpTurnAdmissionError(maxPendingTurns);
    }
    // Serialize turns: a second caller (another websocket, the POST path) waits for
    // the in-flight turn instead of clobbering currentTurn and stealing its chunks.
    const prior = this.turnLock;
    let resolveGate!: () => void;
    let released = false;
    const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
    const release = (): void => {
      if (released) return;
      released = true;
      this.turnReleases.delete(release);
      resolveGate();
    };
    this.turnReleases.add(release);
    const reservationToken = {};
    this.pendingReservations.add(reservationToken);
    // Chain the reservation itself to its predecessor. That lets an aborted
    // queued caller release its own gate without allowing its successor to
    // bypass the still-active turn.
    const reservation = prior.then(() => gate);
    this.turnLock = reservation;
    void reservation.then(() => {
      this.pendingReservations.delete(reservationToken);
    }).catch((error: unknown) => {
      this.pendingReservations.delete(reservationToken);
      log("warn", `acp: queued turn reservation failed: ${this.describeAgentError(error)}`);
    });
    let acquired = true;
    const queuedSignal = options.signal;
    if (queuedSignal) {
      let removeAbortListener: (() => void) | undefined;
      try {
        const aborted = new Promise<boolean>((resolve) => {
          const onAbort = (): void => resolve(false);
          queuedSignal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => queuedSignal.removeEventListener("abort", onAbort);
          if (queuedSignal.aborted) onAbort();
        });
        acquired = await Promise.race([prior.then(() => true), aborted]);
      } finally {
        removeAbortListener?.();
      }
    } else {
      await prior;
    }
    if (!acquired) {
      release();
      return;
    }
    let releaseAfterCancellation: Promise<void> | null = null;
    try {
      // A queued caller may be aborted while another turn owns the session. Do
      // not start it — and, critically, do not cancel the other caller's turn.
      if (options.signal?.aborted) return;
      const runtime = this.runtime;
      if (
        runtime !== reservedRuntime
        || runtime.generation !== reservedGeneration
        || !runtime.conn
        || !runtime.sessionId
      ) {
        throw new Error("ACP brain stopped while waiting for turn");
      }
      if (!raw) this.noteApprovalIfPending(message);
      // Once — buildPrompt consumes one-shot mutable context, which a raw
      // command must leave for the next real turn.
      const promptText = raw ? message : this.buildPrompt(message, options.systemContext);
      for (let attempt = 0; attempt < 2; attempt++) {
        const conn = runtime.conn;
        const sessionId = runtime.sessionId;
        let stopReason: string | undefined;
        let turn!: ReturnType<ClientSideConnection["prompt"]>;
        let cancelNotification: Promise<void> | null = null;
        let active!: ActiveAcpTurn;
        const notifyCancel = (): Promise<void> => {
          cancelNotification ??= conn.cancel({ sessionId });
          return cancelNotification;
        };
        const queue = new ChunkQueue(
          this.config.maxQueuedBytes ?? DEFAULT_ACP_QUEUE_LIMIT_BYTES,
          (error) => active.cancel(error),
        );
        active = {
          queue,
          rowTurnId: `turn-${++this.rowTurnSequence}`,
          structured: [],
          structuredEvents: 0,
          onStructuredUpdate: options.onStructuredUpdate,
          cancelled: false,
          settled: false,
          cancellation: null,
          notifyCancel,
          onNotice: options.onNotice,
          toolNoticeSent: false,
          permissionHold: options.speculative ? options.speculativePermissionHold : undefined,
          speculative: options.speculative === true,
          cancel: (error?: Error): void => {
            active.cancelled = true;
            active.permissionHold?.cancelOwner(active);
            // Discard already-buffered speech on abort/overflow/stop. A prompt
            // that has settled may still have unread chunks, so discarding is
            // independent of protocol settlement.
            queue.end(error, true);
            if (active.settled || active.cancellation) return;
            active.cancellation = (async () => {
              const settlement = Promise.race([
                turn.then(() => true, () => true),
                runtime.stopped.then(() => true),
              ]);
              // Arm the deadline before attempting the best-effort protocol
              // write. A child that stopped reading stdin can leave cancel()
              // pending, but must not hold this stateful session's turn lock.
              const settlementDeadline = settlesWithin(
                settlement,
                this.config.cancelSettleMs ?? CANCEL_SETTLE_MS,
              );
              try {
                void notifyCancel().catch(() => { /* turn or pipe already gone */ });
              } catch { /* connection rejected the write synchronously */ }
              const didSettle = await settlementDeadline;
              if (
                !didSettle
                && this.runtime === runtime
                && runtime.generation === reservedGeneration
              ) {
                log("warn", "acp: cancelled turn did not settle — restarting the session before releasing its lock");
                const recoveryEpoch = this.lifecycleEpoch;
                if (!this.shouldRun(recoveryEpoch)) return;
                try {
                  await this.stopCurrentRuntime(new Error("ACP turn cancellation did not settle"));
                  if (this.shouldRun(recoveryEpoch)) await this.ensureStarted(recoveryEpoch);
                } catch (restartError: unknown) {
                  log("error", `acp: session restart after cancellation failed: ${this.describeAgentError(restartError)}`);
                }
              }
            })().catch((cancellationError: unknown) => {
              log("warn", `acp: cancellation cleanup failed: ${this.describeAgentError(cancellationError)}`);
            });
          },
        };
        runtime.activeTurn = active;
        turn = conn.prompt({
          sessionId,
          prompt: [{ type: "text", text: promptText }],
        });
        void turn.then(
          async (res) => {
            active.settled = true;
            active.permissionHold?.cancelOwner(active);
            stopReason = (res as { stopReason?: string }).stopReason;
            if (!active.cancelled && stopReason !== "cancelled" && this.runtime === runtime
              && !runtime.stopping && this.config.sessionFile && runtime.sessionIdentity) {
              try {
                await this.saveSessionPointer(this.config.sessionFile, runtime.sessionIdentity, sessionId, (this.config.now ?? Date.now)());
              } catch (error: unknown) {
                log("warn", `acp: could not update session timestamp: ${this.describeAgentError(error)}`);
              }
            }
            queue.end();
          },
          (turnError: unknown) => {
            active.settled = true;
            active.permissionHold?.cancelOwner(active);
            queue.end(new Error(`ACP agent turn failed: ${this.describeAgentError(turnError)}`));
          },
        ).catch((callbackError: unknown) => {
          active.settled = true;
          active.permissionHold?.cancelOwner(active);
          queue.end(new Error(`ACP turn settlement failed: ${this.describeAgentError(callbackError)}`));
        });

        let yielded = false;
        let drained = false;
        const cancelTurn = (): void => active.cancel();
        const signal = options.signal;
        signal?.addEventListener("abort", cancelTurn, { once: true });
        if (signal?.aborted) cancelTurn();
        try {
          for await (const chunk of queue.drain()) { yielded = true; yield chunk; }
          drained = true;
        } finally {
          signal?.removeEventListener("abort", cancelTurn);
          if (runtime.activeTurn === active) runtime.activeTurn = null;
          // Generator finalization remains a best-effort fallback for callers
          // that do not pass a signal. Signal-aware callers reach cancelTurn
          // even while next() is suspended in a silent tool loop.
          if (!drained && !active.settled) cancelTurn();
          if (active.cancellation) releaseAfterCancellation = active.cancellation;
        }
        if (signal?.aborted) break;
        // Belt to the braces above: if the agent STILL ate this turn with a
        // stale cancel (ended "cancelled" instantly, zero chunks, nobody here
        // asked for that), re-prompt once instead of returning silence.
        if (drained && !yielded && stopReason === "cancelled" && attempt === 0) {
          log("warn", "acp: turn was killed by a stale cancel — retrying once");
          continue;
        }
        break;
      }
    } finally {
      if (releaseAfterCancellation) {
        // Do not make the interrupted response wait for ACP settlement, but do
        // keep the next response queued until settlement (or a clean restart).
        void releaseAfterCancellation.then(release, release).catch((releaseError: unknown) => {
          log("warn", `acp: turn-lock release failed: ${this.describeAgentError(releaseError)}`);
          release();
        });
      } else {
        release();
      }
    }
  }

  injectContext(context: string): void {
    this.turnContext.inject(context);
  }

  async discardSession(): Promise<void> {
    this.skipStoredSession = true;
    this.sessionPointerEpoch++;
    this.setDesiredRunning(false);
    await this.stopCurrentRuntime(new Error("ACP session discarded"));
    await this.sessionPointerWrite.catch(() => {});
    if (this.config.sessionFile) await clearAcpSession(this.config.sessionFile);
  }

  async restart(): Promise<void> {
    this.turnContext.clear();
    this.clearConfirmationState();
    this.skipStoredSession = true;
    this.sessionPointerEpoch++;
    const epoch = this.setDesiredRunning(true, true);
    let stopError: unknown;
    try { await this.stopCurrentRuntime(new Error("ACP brain restarting")); }
    catch (error: unknown) { stopError = error; }
    await this.sessionPointerWrite.catch(() => {});
    if (this.config.sessionFile) await clearAcpSession(this.config.sessionFile);
    if (stopError) throw stopError;
    if (this.shouldRun(epoch)) await this.ensureStarted(epoch);
  }

  hasPendingConfirmation(): boolean {
    return this.pendingConfirmationStillFresh() !== null;
  }

  pendingConfirmations(): readonly PendingConfirmation[] {
    const pending = this.pendingConfirmationStillFresh();
    return pending ? [{ nonce: pending.nonce, summary: pending.summary }] : [];
  }

  resolvePendingConfirmation(approved: boolean, nonce: string): boolean {
    const pending = this.pendingConfirmationStillFresh();
    if (!pending) return false;
    // Every surface must echo the capability for this exact gate. Missing,
    // stale, cross-lane, and replayed nonces all fail this equality check.
    if (pending.nonce !== nonce) return false;
    this.pendingConfirmation = null;
    if (approved) {
      this.confirmationGrant = {
        until: Date.now() + CONFIRM_GRANT_MS,
        operationKey: pending.operationKey,
      };
      log("ok", "acp: spoken confirmation received");
      if (this.config.confirmRetry !== false) this.nudgeAfterApproval(pending.summary);
    } else {
      this.confirmationGrant = null;
      log("info", "acp: spoken confirmation cancelled");
    }
    return true;
  }

  private nudgeAfterApproval(summary: string): void {
    const prompt = `Approved: ${summary}. Proceed now — the permission will be granted this time.`;
    void this.send(prompt)
      .then((reply) => {
        if (reply) this.config.onNudgeReply?.(reply);
      })
      .catch((err: unknown) => {
        const msg = this.describeAgentError(err);
        log("warn", `acp: approved-confirmation auto-retry failed: ${msg}`);
      });
  }

  async health(): Promise<boolean> {
    const runtime = this.runtime;
    return runtime !== null
      && runtime.conn !== null
      && runtime.sessionId !== null
      && runtime.proc.exitCode === null;
  }

  private recordStructured(runtime: AcpRuntime, update: SessionNotification["update"]): void {
    const turn = runtime.activeTurn;
    if (!turn || turn.settled || turn.cancelled || (turn.structuredEvents ?? 0) >= MAX_STRUCTURED_EVENTS) return;
    let record: AcpStructuredUpdate;
    let replaceAt = -1;
    if (update.sessionUpdate === "plan") {
      if (turn.structured.length >= MAX_STRUCTURED_UPDATES) return;
      record = { kind: "plan", entries: update.entries.slice(0, MAX_PLAN_ENTRIES).map((entry) => ({
        title: safeTitle(this.redactAgentText(entry.content)), status: entry.status,
      })) };
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const toolCallId = this.safeToolCallId(update.toolCallId);
      replaceAt = turn.structured.findIndex((entry) => entry.toolCallId === toolCallId);
      if (replaceAt < 0 && turn.structured.length >= MAX_STRUCTURED_UPDATES) return;
      const previous = replaceAt >= 0 ? turn.structured[replaceAt] : undefined;
      record = {
        kind: update.sessionUpdate,
        toolCallId,
        ...(typeof update.title === "string" ? { title: safeTitle(this.redactAgentText(update.title)) } : previous?.title ? { title: previous.title } : {}),
        ...(update.kind ? { toolKind: update.kind } : previous?.toolKind ? { toolKind: previous.toolKind } : {}),
        ...(update.status ? { status: update.status } : previous?.status ? { status: previous.status } : {}),
      };
    } else return;
    record.sourceId = this.rowSourceId;
    record.turnId = turn.rowTurnId ?? "turn-0";
    if (record.entries) {
      for (const entry of record.entries) Object.freeze(entry);
      Object.freeze(record.entries);
    }
    Object.freeze(record);
    if (replaceAt >= 0) turn.structured[replaceAt] = record;
    else turn.structured.push(record);
    turn.structuredEvents = (turn.structuredEvents ?? 0) + 1;
    dashBus.structured(record);
    try { this.config.onStructuredUpdate?.(record); } catch { /* observer cannot break the turn */ }
    try { turn.onStructuredUpdate?.(record); } catch { /* observer cannot break the turn */ }
  }

  /** The Client side of ACP: receive streamed text and answer tool-permission asks. */
  private makeClient(runtime?: AcpRuntime): Client {
    return {
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        try {
          if (runtime && (this.runtime !== runtime || runtime.stopping || runtime.sessionId !== params.sessionId)) return;
          const update = params.update;
          const active = runtime?.activeTurn;
          if (
            update.sessionUpdate === "tool_call"
            && active && !active.cancellation && !active.settled && !active.toolNoticeSent
          ) {
            active.toolNoticeSent = true;
            try { active.onNotice?.({ type: "tool", text: TOOL_START_NOTICE }); } catch { /* optional notice */ }
          }
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            active?.queue.push(update.content.text);
          } else if (runtime) {
            this.recordStructured(runtime, update);
          }
        } catch (error: unknown) {
          log("warn", `acp: session update rejected: ${this.describeAgentError(error)}`);
        }
      },
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        try {
          // Permission capabilities belong to one live process/session. Requests
          // arriving from a closing transport fail closed and cannot arm a gate
          // in its replacement runtime.
          if (runtime && (this.runtime !== runtime || runtime.stopping || runtime.sessionId !== params.sessionId)) {
            return { outcome: { outcome: "cancelled" } };
          }
          const active = runtime?.activeTurn;
          if (runtime && (!active || active.cancelled || active.settled)) {
            return { outcome: { outcome: "cancelled" } };
          }
          const decide = (): RequestPermissionResponse => {
            // A held callback can settle after the agent turn or runtime ended.
            // Never apply an old request to a newer turn's approval policy.
            if (runtime && (this.runtime !== runtime || runtime.stopping || runtime.sessionId !== params.sessionId
              || runtime.activeTurn !== active || !active || active.cancelled || active.settled)) {
              return { outcome: { outcome: "cancelled" } };
            }
            const gated = this.confirmGate(params);
            if (gated) return gated;
            const wantKinds = this.config.autoApproveTools
              ? ["allow_once", "allow_always"]
              : ["reject_once", "reject_always"];
            // Never fall back to options[0]: an allow-only request with auto-approve
            // disabled must be cancelled, not silently authorized.
            const choice = params.options.find((o) => wantKinds.includes(o.kind));
            if (!choice) return { outcome: { outcome: "cancelled" } };
            return { outcome: { outcome: "selected", optionId: choice.optionId } };
          };
          if (active?.speculative && !active.permissionHold) return { outcome: { outcome: "cancelled" } };
          return active?.permissionHold ? await active.permissionHold.defer(decide, active) : decide();
        } catch (error: unknown) {
          log("warn", `acp: permission request failed closed: ${this.describeAgentError(error)}`);
          return { outcome: { outcome: "cancelled" } };
        }
      },
    };
  }

  /**
   * Fail-closed spoken-confirmation gate. Returns a response when the gate
   * decides (deny pending confirmation, or allow inside an approval window);
   * null falls through to the normal auto-approve logic.
   */
  private confirmGate(params: RequestPermissionRequest): RequestPermissionResponse | null {
    const patterns = this.config.confirmTools ?? [];
    if (patterns.length === 0) return null;
    const haystack = JSON.stringify(params.toolCall ?? {}).toLowerCase();
    if (!patterns.some((p) => haystack.includes(p.toLowerCase()))) return null;

    const rawTitle = (params.toolCall as { title?: string } | undefined)?.title;
    const title = typeof rawTitle === "string" ? safeTitle(this.redactAgentText(rawTitle)) : "a guarded tool";
    const operationKey = permissionOperationKey(params.toolCall ?? null);
    const pick = (kinds: string[]) =>
      params.options.find((o) => kinds.includes(o.kind));

    const grant = this.confirmationGrant;
    if (grant && Date.now() >= grant.until) this.confirmationGrant = null;
    else if (grant && grant.operationKey === operationKey) {
      this.confirmationGrant = null; // one approval = this exact tool call once
      log("ok", "acp: spoken-confirmed tool allowed");
      const allow = pick(["allow_once", "allow_always"]);
      if (!allow) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    } else if (grant) {
      // A grant for operation A cannot authorize operation B, even if both
      // happen to match the same broad confirm_tools pattern.
      this.confirmationGrant = null;
    }

    this.pendingConfirmation = {
      summary: title,
      at: Date.now(),
      nonce: createConfirmationNonce(),
      operationKey,
    };
    log("info", "acp: tool needs spoken confirmation, denied for now");
    const active = this.runtime?.activeTurn;
    if (active && !active.cancellation && !active.settled) {
      try { active.onNotice?.({ type: "confirmation", text: permissionNotice(params.toolCall?.kind) }); }
      catch { /* optional notice */ }
    }
    try {
      const notification = this.config.onConfirmationPending?.(title, this.pendingConfirmation.nonce);
      void Promise.resolve(notification).catch((err: unknown) => {
        log("warn", `acp: confirmation notification failed: ${this.describeAgentError(err)}`);
      });
    } catch (err: unknown) {
      log("warn", `acp: confirmation notification failed: ${this.describeAgentError(err)}`);
    }
    const reject = pick(["reject_once", "reject_always"]);
    if (!reject) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: reject.optionId } };
  }

  /**
   * A spoken approval shortly after a gated denial opens a one-shot window so
   * the agent's retry of the same guarded operation goes through.
   * Anything else — including silence past the pending TTL — leaves the gate
   * closed; there is no way to approve except an explicit fresh utterance.
   */
  private noteApprovalIfPending(message: string): void {
    const pending = this.pendingConfirmationStillFresh();
    if (!pending) return;
    const decision = confirmationDecision(message);
    if (decision !== null) this.resolvePendingConfirmation(decision, pending.nonce);
  }

  private pendingConfirmationStillFresh(): PendingConfirmationState | null {
    const pending = this.pendingConfirmation;
    if (!pending) return null;
    if (Date.now() - pending.at <= CONFIRM_PENDING_MS) return pending;
    this.pendingConfirmation = null;
    return null;
  }

  private clearConfirmationState(): void {
    this.pendingConfirmation = null;
    this.confirmationGrant = null;
  }

  private setDesiredRunning(desired: boolean, forceNewEpoch = false): number {
    if (forceNewEpoch || this.desiredRunning !== desired) {
      this.desiredRunning = desired;
      this.lifecycleEpoch++;
    }
    return this.lifecycleEpoch;
  }

  private shouldRun(epoch: number): boolean {
    return this.desiredRunning && this.lifecycleEpoch === epoch;
  }

  private async ensureStarted(epoch: number): Promise<void> {
    // Re-check ownership after every awaited lifecycle operation. Several
    // callers can be released by the same promise; the first one to loop starts
    // the replacement and the rest observe that new start instead of spawning
    // competing runtimes.
    while (true) {
      if (!this.shouldRun(epoch)) return;
      if (this.runtime?.sessionId && this.runtime.proc.exitCode === null) return;

      const pendingStart = this.startOperation;
      if (pendingStart) {
        const pendingEpoch = this.startOperationEpoch;
        try {
          await pendingStart;
        } catch (error: unknown) {
          if (pendingEpoch === epoch) throw error;
        }
        continue;
      }

      const pendingStop = this.stopOperation;
      if (pendingStop) {
        await pendingStop;
        continue;
      }
      break;
    }

    const operation = this.startOwnedRuntime(epoch);
    this.startOperation = operation;
    this.startOperationEpoch = epoch;
    try {
      await operation;
    } catch (error: unknown) {
      throw error;
    } finally {
      if (this.startOperation === operation) {
        this.startOperation = null;
        this.startOperationEpoch = 0;
      }
    }
  }

  private async stopCurrentRuntime(reason: Error): Promise<void> {
    // Usage and the idle timer describe the session being stopped.
    this.cancelIdleCompact();
    this.contextUsage = null;
    const interruptedStart = this.startOperation;
    if (this.stopOperation) {
      try {
        await this.stopOperation;
      } finally {
        await this.settleInterruptedStart(interruptedStart);
      }
      return;
    }

    const runtime = this.runtime;
    if (!runtime) {
      this.invalidateTurnReservations();
      await this.settleInterruptedStart(interruptedStart);
      return;
    }

    const operation = this.disposeRuntime(runtime, reason);
    this.stopOperation = operation;
    try {
      await operation;
    } finally {
      if (this.stopOperation === operation) this.stopOperation = null;
      await this.settleInterruptedStart(interruptedStart);
    }
  }

  private async startOwnedRuntime(epoch: number): Promise<void> {
    if (!this.shouldRun(epoch)) return;
    this.clearConfirmationState();
    const proc: OwnedAcpProcess = spawnOwnedProcess([this.config.binary, ...(this.config.args ?? [])], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: this.config.cwd ?? process.cwd(),
      env: this.buildEnv(),
    });

    let stopped = false;
    let resolveStopped!: () => void;
    const stoppedPromise = new Promise<void>((resolve) => { resolveStopped = resolve; });
    const runtime: AcpRuntime = {
      generation: ++this.generation,
      proc,
      conn: null,
      sessionId: null,
      sessionIdentity: null,
      initialize: null,
      restored: false,
      activeTurn: null,
      stderrDrain: Promise.resolve(),
      stopped: stoppedPromise,
      markStopped: () => {
        if (stopped) return;
        stopped = true;
        resolveStopped();
      },
      disposing: null,
      stopping: false,
    };
    runtime.stderrDrain = this.drainStderr(proc);
    this.runtime = runtime;

    const writable = new WritableStream<Uint8Array>({
      write: async (chunk): Promise<void> => {
        try {
          const sink = proc.stdin;
          if (!sink || typeof sink === "number") throw new Error("ACP stdin is unavailable");
          sink.write(chunk);
          await sink.flush();
        } catch (error: unknown) {
          throw error;
        }
      },
    });
    const stream = boundedNdJsonStream(writable, proc.stdout, {
      maxFrameBytes: this.config.maxFrameBytes ?? DEFAULT_ACP_FRAME_LIMIT_BYTES,
      onError: (error) => {
        void this.handleUnexpectedRuntimeExit(runtime, `violated the ACP wire contract: ${error.message}`).catch(
          (cleanupError: unknown) => {
            log("error", `acp: failed to close invalid protocol input: ${this.describeAgentError(cleanupError)}`);
          },
        );
      },
    });
    const conn = new ClientSideConnection(() => this.makeClient(runtime), {
      writable: stream.writable,
      readable: dropOffSpecUpdates(stream.readable, (usage) => {
        if (this.runtime === runtime) this.contextUsage = usage;
      }) as typeof stream.readable,
    });
    runtime.conn = conn;

    void proc.exited.then(
      (code) => {
        if (runtime.stopping) return;
        void this.handleUnexpectedRuntimeExit(runtime, `exited with code ${code}`).catch((error: unknown) => {
          log("error", `acp: failed to clean up exited agent: ${this.describeAgentError(error)}`);
        });
      },
      (error: unknown) => {
        if (runtime.stopping) return;
        void this.handleUnexpectedRuntimeExit(runtime, `exit wait failed: ${this.describeAgentError(error)}`).catch((cleanupError: unknown) => {
          log("error", `acp: failed to clean up broken agent: ${this.describeAgentError(cleanupError)}`);
        });
      },
    ).catch((error: unknown) => {
      log("error", `acp: process-exit watcher failed: ${this.describeAgentError(error)}`);
    });

    const timeout = this.config.startTimeoutMs ?? 20_000;
    try {
      runtime.initialize = await this.withRuntimeTimeout(
        conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          // We are not an editor: the agent uses its own tools, not our filesystem.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        }),
        runtime,
        timeout,
        "initialize",
      );
      const cwd = this.config.cwd ?? process.cwd();
      const mcpServers = this.config.mcpServers ?? [];
      const identity = createHash("sha256").update(JSON.stringify([
        this.config.binary, this.config.args ?? [], cwd,
        mcpServers.map((server) => ({
          name: server.name, command: server.command, args: server.args,
          env: server.env.map((variable) => variable.name),
        })),
      ])).digest("hex");
      const now = (this.config.now ?? Date.now)();
      const stored = this.config.sessionFile && !this.skipStoredSession
        ? await readAcpSession(this.config.sessionFile, identity) : null;
      const resumableId = resumableAcpSession(stored, this.config.sessionResume !== false, this.config.sessionResumeMaxAgeHours ?? 12, now);
      const opened = await openAcpSession(
        conn, { cwd, mcpServers }, resumableId, runtime.initialize.agentCapabilities?.loadSession === true,
        (operation, label) => this.withRuntimeTimeout(operation, runtime, timeout, label),
        (error) => runtime.stopping || runtime.proc.exitCode !== null
          || (error instanceof Error && error.message.startsWith("loadSession timed out")),
      );
      runtime.sessionId = opened.sessionId;
      runtime.sessionIdentity = identity;
      runtime.restored = opened.restored;
      if (resumableId && runtime.initialize.agentCapabilities?.loadSession === true && !opened.restored) {
        log("info", "acp: stored session could not be loaded; starting a new session");
      }
      if (this.runtime !== runtime || runtime.stopping || !this.shouldRun(epoch)) {
        throw new Error("agent stopped or its startup was superseded during session setup");
      }
      if (this.config.sessionFile && runtime.sessionId && !opened.restored) {
        const pointerEpoch = this.sessionPointerEpoch;
        await this.saveSessionPointer(this.config.sessionFile, identity, runtime.sessionId, now);
        if (pointerEpoch === this.sessionPointerEpoch && this.runtime === runtime
          && !runtime.stopping && this.shouldRun(epoch)) this.skipStoredSession = false;
      }
      log("ok", `🧠 ACP brain connected (${this.config.binary})`);
    } catch (error: unknown) {
      try {
        await this.disposeRuntime(runtime, new Error("ACP brain startup failed"));
      } catch (cleanupError: unknown) {
        log("error", `acp: startup cleanup failed: ${this.describeAgentError(cleanupError)}`);
      }
      throw new Error(
        `ACP brain failed to start (${this.redactAgentText(this.config.binary)} ${this.redactAgentText((this.config.args ?? []).join(" "))}): ${this.describeAgentError(error)}`,
      );
    }
  }

  private async handleUnexpectedRuntimeExit(runtime: AcpRuntime, detail: string): Promise<void> {
    if (runtime.stopping || runtime.disposing) return;
    const reason = new Error(`ACP agent ${detail}`);
    log("warn", `${reason.message}; closing its session`);
    const operation = this.disposeRuntime(runtime, reason);
    const ownsStopSlot = this.stopOperation === null;
    if (ownsStopSlot) this.stopOperation = operation;
    try {
      await operation;
    } finally {
      if (ownsStopSlot && this.stopOperation === operation) this.stopOperation = null;
    }
  }

  private disposeRuntime(runtime: AcpRuntime, reason: Error): Promise<void> {
    if (runtime.disposing) return runtime.disposing;
    const operation = this.disposeRuntimeNow(runtime, reason);
    runtime.disposing = operation;
    return operation;
  }

  private async disposeRuntimeNow(runtime: AcpRuntime, reason: Error): Promise<void> {
    runtime.stopping = true;
    const ownedCurrentRuntime = this.runtime === runtime;
    runtime.sessionId = null;
    if (ownedCurrentRuntime) {
      this.runtime = null;
      this.clearConfirmationState();
      this.invalidateTurnReservations();
    }

    const active = runtime.activeTurn;
    if (active) {
      active.permissionHold?.cancelOwner(active);
      active.queue.end(reason, true);
      if (!active.settled) {
        active.cancel(reason);
        const notification = active.notifyCancel().catch((error: unknown) => {
          log("info", `acp: protocol cancellation ended with the transport: ${this.describeAgentError(error)}`);
        });
        await settlesWithin(notification, STOP_CANCEL_FLUSH_MS);
      }
    }
    runtime.activeTurn = null;
    runtime.conn = null;

    try {
      await terminateOwnedAcpProcess(
        runtime.proc,
        Math.max(0, this.config.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS),
      );
    } finally {
      runtime.markStopped();
      // Tree cleanup should close inherited stderr on every supported path;
      // keep diagnostic draining bounded even if the transport itself wedges.
      await settlesWithin(runtime.stderrDrain, STOP_CANCEL_FLUSH_MS);
    }
  }

  private invalidateTurnReservations(): void {
    const releases = [...this.turnReleases];
    this.turnReleases.clear();
    this.pendingReservations.clear();
    this.turnLock = Promise.resolve();
    for (const release of releases) release();
  }

  private async settleInterruptedStart(operation: Promise<void> | null): Promise<void> {
    if (!operation) return;
    try {
      await operation;
    } catch { /* stop intentionally invalidated this startup handshake */ }
  }

  /** Surface the agent's stderr (auth prompts, crashes) instead of swallowing it. */
  private async drainStderr(proc: OwnedAcpProcess): Promise<void> {
    const stderr = proc.stderr;
    try {
      const decoder = new TextDecoder();
      for await (const chunk of stderr) {
        const text = decoder.decode(chunk).trim();
        if (text) log("info", `acp(${this.config.binary}): ${this.redactAgentText(text.slice(0, 200))}`);
      }
    } catch { /* process ended */ }
  }

  /** Child env: inherit the parent, add `config.env`, then drop `config.unsetEnv`. */
  private buildEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, ...(this.config.env ?? {}) };
    for (const key of this.config.unsetEnv ?? []) delete env[key];
    return env;
  }

  private buildPrompt(message: string, systemContext?: string): string {
    return this.turnContext.buildTextPrompt(message, false, systemContext);
  }

  private async withRuntimeTimeout<T>(
    promise: Promise<T>,
    runtime: AcpRuntime,
    ms: number,
    label: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms (agent did not respond)`)), ms);
    });
    const stopped = runtime.stopped.then<never>(() => {
      throw new Error(`${label} interrupted because the ACP agent stopped`);
    });
    try {
      return await Promise.race([promise, timeout, stopped]);
    } catch (error: unknown) {
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
