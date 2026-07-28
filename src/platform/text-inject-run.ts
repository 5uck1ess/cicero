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
const MAX_HELPER_ERROR_CHARS = 400;

export class TextInjectionUnavailableError extends Error {
  constructor(readonly reason: string, readonly fix?: string) {
    super(fix ? `${reason}. ${fix}` : reason);
    this.name = "TextInjectionUnavailableError";
  }
}

export type SpawnInjection = (spec: TextInjectionSpec) => ReturnType<typeof Bun.spawn>;

const spawnInjection: SpawnInjection = (spec) =>
  Bun.spawn(spec.command, { stdin: new TextEncoder().encode(spec.stdin), stdout: "ignore", stderr: "pipe" });

/**
 * Resolve this machine's injection capability once, and return a typer — or
 * throw with an actionable reason. Callers resolve at startup so an operator
 * learns dictation cannot type on their session at boot, not on first use.
 */
export function createTextInjector(
  env: InjectionEnvironment = {},
  spawn: SpawnInjection = spawnInjection,
): (text: string) => Promise<void> {
  const support = resolveTextInjection({ hasBinary: (name) => Bun.which(name) !== null, ...env });
  if (support.kind === "unsupported") throw new TextInjectionUnavailableError(support.reason, support.fix);

  return async (text: string): Promise<void> => {
    const bounded = boundInjectedText(text);
    if (bounded.truncated) {
      log("warn", `Dictation transcript was longer than the injection limit — typing the first ${bounded.text.length} characters`);
    }
    if (!bounded.text) return;
    await runInjection(buildTextInjection(bounded.text, support.method), spawn);
  };
}

async function runInjection(spec: TextInjectionSpec, spawn: SpawnInjection): Promise<void> {
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
        }, INJECT_TIMEOUT_MS);
      }),
    ]);
    if (timedOut) throw new Error(`${spec.command[0]} did not finish typing within ${INJECT_TIMEOUT_MS}ms`);
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
  return resolveTextInjection({ hasBinary: (name) => Bun.which(name) !== null, ...env });
}
