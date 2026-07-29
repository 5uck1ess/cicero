import {
  boundInjectedText,
  buildTextInjection,
  resolveTextInjection,
  XDOTOOL_TYPE_DELAY_MS,
  type InjectionEnvironment,
  type InjectionMethod,
  type TextInjectionSpec,
  type TextInjectionSupport,
} from "./text-inject";
import { log } from "../logger";

/**
 * Bound on one synthetic-typing run, so a wedged helper cannot hold a turn open.
 *
 * It is a floor, not the whole budget: `xdotool` types at a fixed per-character
 * delay, so a long transcript legitimately takes longer than any constant. A
 * 3,000-character transcript needs ~36s of honest typing and used to be killed
 * at 30s, mid-sentence, and reported as a wedged helper. The deadline is derived
 * from the text instead — still absolute, and still bounded, because the text
 * itself is capped at MAX_INJECTED_CHARS.
 */
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
export interface TextInjector {
  (text: string): Promise<void>;
  /**
   * Reap the helper this injector holds and close it to further typing. Rejects
   * if the helper is still alive. Latched: once released, a late transcript is
   * refused rather than typed, so shutdown's "released" stays true.
   */
  stop(): Promise<void>;
}

export function createTextInjector(
  env: InjectionEnvironment = {},
  spawn: SpawnInjection = spawnInjection,
  timeouts: InjectionTimeouts = {},
): TextInjector {
  const injectMs = timeouts.injectMs ?? INJECT_TIMEOUT_MS;
  const reapMs = timeouts.reapMs ?? HELPER_REAP_GRACE_MS;
  const support = resolveTextInjection({ ...sessionEnvironment(), ...env });
  if (support.kind === "unsupported") throw new TextInjectionUnavailableError(support.reason, support.fix);

  /**
   * The helper this injector is responsible for: held from the instant it is
   * spawned until its exit is confirmed, so it covers a helper that is actively
   * typing as well as one that ignored its kill. Tracking only the latter meant
   * stop() had nothing to kill during the window that matters most — a shutdown
   * mid-injection returned "released" while xdotool went on typing.
   *
   * A helper that ignored its kill still owns the synthetic keyboard. Spawning a
   * second one would interleave two streams of keystrokes into the same focused
   * field, so the survivor is retained and the next injection fails closed until
   * its exit is confirmed. Retryable rather than latched: the moment it does go
   * away, dictation types again without a daemon restart.
   */
  let held: ReturnType<typeof Bun.spawn> | null = null;
  /**
   * Set by stop(): this injector may not spawn again. Releasing it is not enough
   * on its own — a transcription still in flight when the daemon began shutting
   * down resolves AFTER that release, and typing it spawned a fresh helper (up
   * to two minutes of xdotool for a capped transcript) that nothing owned any
   * more, while shutdown had already reported a confirmed release. Fail closed:
   * a transcript is worth less than a keyboard typing into whatever the operator
   * does next.
   */
  let closed = false;
  const refuseWhenClosed = (): void => {
    if (closed) throw new Error("the typing helper has been released for shutdown; the transcript was not typed");
  };
  const hold = (proc: ReturnType<typeof Bun.spawn>): void => { held = proc; };
  const release = (proc: ReturnType<typeof Bun.spawn>): void => { if (held === proc) held = null; };

  const typer = async (text: string): Promise<void> => {
    const bounded = boundInjectedText(text);
    if (bounded.truncated) {
      log("warn", `Dictation transcript was longer than the injection limit — typing the first ${bounded.text.length} characters`);
    }
    if (!bounded.text) return;
    refuseWhenClosed();
    if (held) {
      if (!await confirmExit(held, reapMs)) {
        throw new Error("a previous typing helper has not exited; refusing to type over it");
      }
      held = null;
      // The only await between the check above and the spawn below, so it is the
      // only window in which a shutdown can land unnoticed.
      refuseWhenClosed();
    }
    await runInjection(
      buildTextInjection(bounded.text, support.method),
      spawn,
      { hold, release },
      { injectMs: injectMs + typingAllowanceMs(bounded.text.length, support.method), reapMs },
    );
  };

  /**
   * Release a helper this injector is still holding. Without it the survivor was
   * reachable only from this closure, so daemon shutdown dropped the last
   * reference to a process that was still typing. Rejects when release is
   * unconfirmed, so the caller can retry rather than assume it is gone.
   */
  typer.stop = async (): Promise<void> => {
    // Synchronous, before any await: a caller already inside typer() must not be
    // able to slip a spawn past this.
    closed = true;
    const survivor = held;
    if (!survivor) return;
    try { survivor.kill(); } catch { /* already gone */ }
    if (!await confirmExit(survivor, reapMs)) {
      throw new Error("a typing helper has not exited");
    }
    release(survivor);
  };

  return typer;
}

/** Extra deadline a method genuinely needs for this much text. */
function typingAllowanceMs(chars: number, method: InjectionMethod): number {
  // Only xdotool paces itself per character; osascript and SendKeys do not.
  return method === "xdotool" ? chars * XDOTOOL_TYPE_DELAY_MS : 0;
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
  owner: {
    hold: (proc: ReturnType<typeof Bun.spawn>) => void;
    release: (proc: ReturnType<typeof Bun.spawn>) => void;
  },
  bounds: { injectMs: number; reapMs: number },
): Promise<void> {
  const proc = spawn(spec);
  // Owned from this instant, not just once a kill is refused: while this runs,
  // the injector's stop() is the only thing that can reach a helper that is
  // still typing.
  owner.hold(proc);
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
        // Stays held: it is still typing and nothing else can reach it.
        throw new Error(
          `${spec.command[0]} did not finish typing within ${bounds.injectMs}ms and did not exit when killed`,
        );
      }
      owner.release(proc);
      throw new Error(`${spec.command[0]} did not finish typing within ${bounds.injectMs}ms`);
    }
    owner.release(proc);
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
