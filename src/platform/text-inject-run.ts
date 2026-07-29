import {
  boundInjectedText,
  buildTextInjection,
  resolveTextInjection,
  type InjectionEnvironment,
  type TextInjectionSpec,
  type TextInjectionSupport,
} from "./text-inject";
import { log } from "../logger";

/** Bound on one synthetic-typing run, so a wedged helper cannot hold a turn open. */
const INJECT_TIMEOUT_MS = 30_000;
/** Bound on confirming that a killed helper actually went away. */
const HELPER_REAP_GRACE_MS = 2_000;
const MAX_HELPER_ERROR_CHARS = 400;

export class TextInjectionUnavailableError extends Error {
  constructor(readonly reason: string, readonly fix?: string) {
    super(fix ? `${reason}. ${fix}` : reason);
    this.name = "TextInjectionUnavailableError";
  }
}

export type SpawnInjection = (spec: TextInjectionSpec) => ReturnType<typeof Bun.spawn>;

/**
 * The desktop-session facts the resolver needs, read from this process.
 *
 * Production used to call the resolver with only `hasBinary`, so `sessionType`
 * and `waylandDisplay` were always empty and the Wayland branch was unreachable
 * outside tests: a Wayland session fell through to X11 and reported `xdotool` as
 * supported. It reaches XWayland clients only, so dictation would have typed
 * into some windows and silently done nothing in others — the exact per-window
 * failure the resolver refuses on purpose.
 */
function sessionEnvironment(): InjectionEnvironment {
  return {
    hasBinary: (name) => Bun.which(name) !== null,
    ...(process.env.XDG_SESSION_TYPE ? { sessionType: process.env.XDG_SESSION_TYPE } : {}),
    ...(process.env.WAYLAND_DISPLAY ? { waylandDisplay: process.env.WAYLAND_DISPLAY } : {}),
  };
}

const spawnInjection: SpawnInjection = (spec) =>
  Bun.spawn(spec.command, { stdin: new TextEncoder().encode(spec.stdin), stdout: "ignore", stderr: "pipe" });

export interface InjectionTimeouts {
  /** Bound on one typing run. */
  injectMs?: number;
  /** Bound on confirming a killed helper actually exited. */
  reapMs?: number;
}

/**
 * Resolve this machine's injection capability once, and return a typer — or
 * throw with an actionable reason. Callers resolve at startup so an operator
 * learns dictation cannot type on their session at boot, not on first use.
 */
export function createTextInjector(
  env: InjectionEnvironment = {},
  spawn: SpawnInjection = spawnInjection,
  timeouts: InjectionTimeouts = {},
): (text: string) => Promise<void> {
  const injectMs = timeouts.injectMs ?? INJECT_TIMEOUT_MS;
  const reapMs = timeouts.reapMs ?? HELPER_REAP_GRACE_MS;
  const support = resolveTextInjection({ ...sessionEnvironment(), ...env });
  if (support.kind === "unsupported") throw new TextInjectionUnavailableError(support.reason, support.fix);

  /**
   * A helper that ignored its kill still owns the synthetic keyboard. Spawning a
   * second one would interleave two streams of keystrokes into the same focused
   * field, so the survivor is retained and the next injection fails closed until
   * its exit is confirmed. Retryable rather than latched: the moment it does go
   * away, dictation types again without a daemon restart.
   */
  let unreaped: ReturnType<typeof Bun.spawn> | null = null;

  return async (text: string): Promise<void> => {
    const bounded = boundInjectedText(text);
    if (bounded.truncated) {
      log("warn", `Dictation transcript was longer than the injection limit — typing the first ${bounded.text.length} characters`);
    }
    if (!bounded.text) return;
    if (unreaped) {
      if (!await confirmExit(unreaped, reapMs)) {
        throw new Error("a previous typing helper has not exited; refusing to type over it");
      }
      unreaped = null;
    }
    await runInjection(
      buildTextInjection(bounded.text, support.method),
      spawn,
      (proc) => { unreaped = proc; },
      { injectMs, reapMs },
    );
  };
}

/** Wait, bounded, for a helper to actually exit. True only when confirmed gone. */
async function confirmExit(proc: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      proc.exited.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runInjection(
  spec: TextInjectionSpec,
  spawn: SpawnInjection,
  retain: (proc: ReturnType<typeof Bun.spawn>) => void,
  bounds: { injectMs: number; reapMs: number },
): Promise<void> {
  const proc = spawn(spec);
  // Start draining stderr immediately. Reading it only after exit would let a
  // helper that floods stderr block on its own full pipe and never exit.
  const stderr = readHelperStderr(proc);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const code = await Promise.race([
      proc.exited,
      new Promise<number | null>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          try { proc.kill(); } catch { /* already gone */ }
          // Resolve rather than await the kill: a helper that ignores
          // termination must not wedge the caller past this deadline.
          resolve(null);
        }, bounds.injectMs);
      }),
    ]);
    if (timedOut) {
      // The kill above was fire-and-forget so the deadline stays honest. Confirm
      // it landed: an ignored kill leaves a helper still typing into the focused
      // field, and reporting a clean failure here let the next call spawn a
      // second one on top of it.
      if (!await confirmExit(proc, bounds.reapMs)) {
        retain(proc);
        throw new Error(
          `${spec.command[0]} did not finish typing within ${bounds.injectMs}ms and did not exit when killed`,
        );
      }
      throw new Error(`${spec.command[0]} did not finish typing within ${bounds.injectMs}ms`);
    }
    if (code !== 0) throw new Error(`${spec.command[0]} exited with ${code}${await stderr}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Never leave the drain unobserved, even on the timeout path.
    void stderr.catch(() => "");
  }
}

/**
 * Helper stderr is untrusted terminal-adjacent output: bound it and strip
 * control characters before it reaches the logger.
 */
function readHelperStderr(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  const stderr = proc.stderr;
  if (!stderr || typeof stderr === "number") return Promise.resolve("");
  return (async () => {
    const raw = await new Response(stderr).text();
    const clean = raw.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").trim();
    if (!clean) return "";
    const bounded = clean.length > MAX_HELPER_ERROR_CHARS ? `${clean.slice(0, MAX_HELPER_ERROR_CHARS)}…` : clean;
    return `: ${bounded}`;
  })().catch(() => "");
}

/** Capability report for `doctor` / `status`, without constructing a typer. */
export function describeTextInjection(env: InjectionEnvironment = {}): TextInjectionSupport {
  return resolveTextInjection({ ...sessionEnvironment(), ...env });
}
