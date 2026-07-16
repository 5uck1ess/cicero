import { randomUUID } from "node:crypto";
import { lstat, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** `~/.cicero/telegram-call` — the daemon ↔ call-sidecar handoff directory.
 *  Mirrors `WORKDIR` in `sidecars/telegram-call/call_agent.py`. */
export const TELEGRAM_CALL_DIR = join(homedir(), ".cicero", "telegram-call");

/** The single fixed-path spool the daemon writes and the sidecar's
 *  `callback_poll` consumes. One file, overwritten per request — so a
 *  consumer-less install accumulates at most one stale file, never a pile. */
export const CALLBACK_SPOOL_PATH = join(TELEGRAM_CALL_DIR, "callback.request");

/** Heartbeat a task beside the sidecar's `callback_poll` re-touches every
 *  tick. It stays fresh while polling is blocked placing or deferring a ring.
 *  A startup configuration without an allowed callback owner advertises no
 *  heartbeat because it cannot consume the spool. */
export const LISTENER_HEARTBEAT_PATH = join(TELEGRAM_CALL_DIR, "listener.alive");

/** Pyrogram persists Client("cicero", ..., workdir=TELEGRAM_CALL_DIR) as this
 *  SQLite session. Both call_agent.py and login.py use that exact client name. */
export const TELEGRAM_SESSION_NAME = "cicero";
export const TELEGRAM_SESSION_PATH = join(TELEGRAM_CALL_DIR, `${TELEGRAM_SESSION_NAME}.session`);

/** The sidecar re-touches the heartbeat every 5s; six missed ticks (30s) is a
 *  generous "the listener process is gone" threshold that still tolerates a
 *  slow tick or a brief hiccup without falsely reporting the line down. */
export const LISTENER_HEARTBEAT_FRESH_MS = 30_000;

export type CallbackSpoolWriter = (path: string, content: string) => Promise<unknown>;

/** Publish one fixed-path callback request without leaving a turn-aborted
 * request visible after its write finishes. A per-write nonce makes the exact
 * content an ownership token, preserving even an identical newer producer's
 * overwrite. A consumer can still claim the file in the microsecond
 * write→compensation gap; that bounded residual is accepted. */
export async function writeCallbackSpool(
  content: string,
  signal: AbortSignal,
  spoolPath: string = CALLBACK_SPOOL_PATH,
  writer: CallbackSpoolWriter = (path, value) => Bun.write(path, value),
): Promise<boolean> {
  signal.throwIfAborted();
  const payload: unknown = JSON.parse(content);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("callback spool payload must be a JSON object");
  }
  const ownedContent = JSON.stringify({ ...payload, nonce: randomUUID() });
  await writer(spoolPath, ownedContent);
  if (!signal.aborted) return true;
  try {
    if (await readFile(spoolPath, "utf8") === ownedContent) {
      await unlink(spoolPath);
    }
  } catch {
    // Best-effort compensation: the consumer may already have claimed it, or
    // a newer producer may be replacing it. Either state must remain owned by
    // that actor rather than turning abort cleanup into a second failure.
  }
  return false;
}

/** Three-state compatibility check for the independently deployed sidecar:
 *  a fresh regular heartbeat is alive; a present stale/non-regular heartbeat
 *  is down; an absent heartbeat falls back to the legacy sidecar's regular
 *  Pyrogram session file in the same workdir. A sidecar upgraded and then
 *  rolled back leaves a stale heartbeat and therefore reads down until the
 *  operator removes listener.alive; this is the deliberately accepted edge. */
export async function callbackConsumerAlive(
  now: number = Date.now(),
  heartbeatPath: string = LISTENER_HEARTBEAT_PATH,
  thresholdMs: number = LISTENER_HEARTBEAT_FRESH_MS,
): Promise<boolean> {
  try {
    const heartbeat = await lstat(heartbeatPath);
    if (!heartbeat.isFile()) return false;
    const { mtimeMs } = heartbeat;
    const age = now - mtimeMs;
    // Accept a small negative age (clock skew makes a just-written heartbeat
    // look future-dated) but reject an absurd future mtime as not-alive.
    return age <= thresholdMs && age >= -thresholdMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    try {
      const legacySessionPath = join(dirname(heartbeatPath), `${TELEGRAM_SESSION_NAME}.session`);
      return (await lstat(legacySessionPath)).isFile();
    } catch {
      return false;
    }
  }
}
