import { lstat } from "node:fs/promises";
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
