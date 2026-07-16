import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** `~/.cicero/telegram-call` — the daemon ↔ call-sidecar handoff directory.
 *  Mirrors `WORKDIR` in `sidecars/telegram-call/call_agent.py`. */
export const TELEGRAM_CALL_DIR = join(homedir(), ".cicero", "telegram-call");

/** The single fixed-path spool the daemon writes and the sidecar's
 *  `callback_poll` consumes. One file, overwritten per request — so a
 *  consumer-less install accumulates at most one stale file, never a pile. */
export const CALLBACK_SPOOL_PATH = join(TELEGRAM_CALL_DIR, "callback.request");

/** Heartbeat the sidecar's `callback_poll` loop re-touches every tick. Its
 *  mtime is the daemon's only honest signal that a dial-back CONSUMER is
 *  alive. It stays fresh even while the sidecar legitimately DEFERS a ring
 *  (mid-call, empty allowlist) — those branches keep the poll loop running —
 *  so the daemon can tell "listener present but waiting" apart from "no
 *  listener at all", which the presence of the spool file alone cannot. */
export const LISTENER_HEARTBEAT_PATH = join(TELEGRAM_CALL_DIR, "listener.alive");

/** The sidecar re-touches the heartbeat every 5s; six missed ticks (30s) is a
 *  generous "the listener process is gone" threshold that still tolerates a
 *  slow tick or a brief hiccup without falsely reporting the line down. */
export const LISTENER_HEARTBEAT_FRESH_MS = 30_000;

/** True only when a dial-back consumer (the call sidecar) is provably alive:
 *  its heartbeat exists and was touched within {@link LISTENER_HEARTBEAT_FRESH_MS}
 *  of `now`. Fails closed — a missing, stale, unreadable, or absurdly
 *  future-dated heartbeat returns false — so the daemon never promises a ring
 *  it cannot confirm will happen. */
export async function callbackConsumerAlive(
  now: number = Date.now(),
  heartbeatPath: string = LISTENER_HEARTBEAT_PATH,
  thresholdMs: number = LISTENER_HEARTBEAT_FRESH_MS,
): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(heartbeatPath);
    const age = now - mtimeMs;
    // Accept a small negative age (clock skew makes a just-written heartbeat
    // look future-dated) but reject an absurd future mtime as not-alive.
    return age <= thresholdMs && age >= -thresholdMs;
  } catch {
    return false;
  }
}
