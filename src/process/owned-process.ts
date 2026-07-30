/** Minimum process contract required by the shared tree lifecycle. */
export type OwnedProcess = Pick<ReturnType<typeof Bun.spawn>, "pid" | "exited" | "kill">;

export interface OwnedProcessTerminationOptions {
  /** Grace between TERM and forced termination. */
  terminateGraceMs?: number;
  /** Maximum wait for leader reap and POSIX group disappearance after KILL. */
  reapTimeoutMs?: number;
}

export type ProcessExitOutcome =
  | { kind: "exited"; code: number }
  | { kind: "rejected"; error: unknown }
  | { kind: "timeout" };

const DEFAULT_TERMINATE_GRACE_MS = 250;
const DEFAULT_REAP_TIMEOUT_MS = 2_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 1_000;
const treeTerminations = new WeakMap<OwnedProcess, Promise<void>>();
const directTerminations = new WeakMap<OwnedProcess, Promise<void>>();

export class OwnedProcessReapError extends Error {
  constructor(
    readonly pid: number,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`owned process ${pid} ${detail}`, options);
    this.name = "OwnedProcessReapError";
  }
}

/**
 * Spawn a child in its own POSIX session/process group. Windows tree ownership
 * is enforced at termination with taskkill /T; keeping the root attached there
 * lets taskkill enumerate descendants before the root becomes an orphan.
 */
export function spawnOwnedProcess<
  const In extends Bun.SpawnOptions.Writable = "ignore",
  const Out extends Bun.SpawnOptions.Readable = "pipe",
  const Err extends Bun.SpawnOptions.Readable = "inherit",
>(
  command: readonly string[],
  options: Bun.SpawnOptions.SpawnOptions<In, Out, Err>,
): Bun.Subprocess<In, Out, Err> {
  if (command.length === 0 || !command[0]) throw new TypeError("owned process command must not be empty");
  return Bun.spawn([...command], {
    ...options,
    detached: process.platform !== "win32",
    windowsHide: options.windowsHide ?? true,
  });
}

/** Observe one exact exit promise without converting rejection into success. */
export async function processExitWithin(
  exited: Promise<number>,
  timeoutMs: number,
): Promise<ProcessExitOutcome> {
  const boundedTimeoutMs = nonNegativeInteger(timeoutMs, "timeoutMs");
  // Attach the rejection observer even for a zero-length poll. Callers use
  // zero to skip grace, but that must not turn a failed waitpid promise into an
  // unhandled rejection before the forced-cleanup observation is installed.
  const observation = exited.then(
    (code) => ({ kind: "exited" as const, code }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
  if (boundedTimeoutMs === 0) return { kind: "timeout" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      observation,
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), boundedTimeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * TERM an owned tree, escalate to KILL, and prove leader reap. POSIX additionally
 * proves the detached process group disappeared. Windows uses taskkill /T while
 * the root PID is still enumerable and fails closed when tree targeting fails.
 */
export function terminateOwnedProcessTree(
  proc: OwnedProcess,
  options: OwnedProcessTerminationOptions = {},
): Promise<void> {
  let graceMs: number;
  let reapTimeoutMs: number;
  try {
    positiveInteger(proc.pid, "pid");
    graceMs = nonNegativeInteger(
      options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
      "terminateGraceMs",
    );
    reapTimeoutMs = positiveInteger(
      options.reapTimeoutMs ?? DEFAULT_REAP_TIMEOUT_MS,
      "reapTimeoutMs",
    );
  } catch (error: unknown) {
    return Promise.reject(error);
  }

  const existing = treeTerminations.get(proc);
  if (existing) return existing;
  const task = process.platform === "win32"
    ? terminateWindowsTree(proc, graceMs, reapTimeoutMs)
    : terminatePosixTree(proc, graceMs, reapTimeoutMs);
  const tracked = task.catch((error: unknown) => {
    // A failed proof may be retried (for example, a late exit after timeout).
    // Keep successful ownership proofs cached so a later duplicate cannot
    // signal a recycled PID/process group through the stale subprocess handle.
    if (treeTerminations.get(proc) === tracked) treeTerminations.delete(proc);
    throw error;
  });
  treeTerminations.set(proc, tracked);
  return tracked;
}

/** TERM→KILL escalation for native helpers that are known not to spawn children. */
export function terminateOwnedDirectProcess(
  proc: OwnedProcess,
  options: OwnedProcessTerminationOptions = {},
): Promise<void> {
  let graceMs: number;
  let reapTimeoutMs: number;
  try {
    graceMs = nonNegativeInteger(
      options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
      "terminateGraceMs",
    );
    reapTimeoutMs = positiveInteger(
      options.reapTimeoutMs ?? DEFAULT_REAP_TIMEOUT_MS,
      "reapTimeoutMs",
    );
  } catch (error: unknown) {
    return Promise.reject(error);
  }

  const existing = directTerminations.get(proc);
  if (existing) return existing;
  const task = terminateDirectProcessNow(proc, graceMs, reapTimeoutMs);
  const tracked = task.catch((error: unknown) => {
    if (directTerminations.get(proc) === tracked) directTerminations.delete(proc);
    throw error;
  });
  directTerminations.set(proc, tracked);
  return tracked;
}

async function terminateDirectProcessNow(
  proc: OwnedProcess,
  graceMs: number,
  reapTimeoutMs: number,
): Promise<void> {
  try { proc.kill("SIGTERM"); } catch { /* already exited */ }
  const gracefulExit = await processExitWithin(proc.exited, graceMs);
  if (gracefulExit.kind === "exited") return;

  try { proc.kill("SIGKILL"); } catch { /* already exited */ }
  const finalExit = await processExitWithin(proc.exited, reapTimeoutMs);
  if (finalExit.kind === "timeout") {
    throw new OwnedProcessReapError(proc.pid, "direct child did not reap after SIGKILL");
  }
  if (finalExit.kind === "rejected") {
    throw new OwnedProcessReapError(
      proc.pid,
      `direct-child exit observation failed: ${errorMessage(finalExit.error)}`,
      { cause: finalExit.error },
    );
  }
}

/** True while a detached POSIX group with this leader id remains reachable. */
export function posixProcessGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== "ESRCH";
  }
}

async function terminatePosixTree(
  proc: OwnedProcess,
  graceMs: number,
  reapTimeoutMs: number,
): Promise<void> {
  signalPosixTree(proc, "SIGTERM");
  const [termExit, termGroupGone] = await Promise.all([
    processExitWithin(proc.exited, graceMs),
    waitForPosixGroupExit(proc.pid, graceMs),
  ]);

  if (termExit.kind !== "exited" || !termGroupGone) {
    signalPosixTree(proc, "SIGKILL");
  }

  const [finalExit, finalGroupGone] = await Promise.all([
    processExitWithin(proc.exited, reapTimeoutMs),
    waitForPosixGroupExit(proc.pid, reapTimeoutMs),
  ]);
  if (finalExit.kind === "timeout") {
    throw new OwnedProcessReapError(proc.pid, "leader did not reap after SIGKILL");
  }
  if (finalExit.kind === "rejected") {
    throw new OwnedProcessReapError(
      proc.pid,
      `leader exit observation failed: ${errorMessage(finalExit.error)}`,
      { cause: finalExit.error },
    );
  }
  if (!finalGroupGone) {
    throw new OwnedProcessReapError(proc.pid, "process group still exists after SIGKILL");
  }
}

async function terminateWindowsTree(
  proc: OwnedProcess,
  graceMs: number,
  reapTimeoutMs: number,
): Promise<void> {
  // Enumerate the tree before killing the root. Once the root disappears,
  // Windows cannot rediscover arbitrary descendants without a Job Object.
  const graceful = graceMs > 0
    ? await runWindowsTaskkill(proc.pid, false)
    : { outcome: "failed" as const, code: null };
  if (graceful.outcome === "targeted") {
    const gracefulExit = await processExitWithin(proc.exited, graceMs);
    if (gracefulExit.kind === "exited") return;
  }

  const forced = await runWindowsTaskkill(proc.pid, true);
  if (windowsForcedKillNeeded(forced.outcome)) {
    try { proc.kill("SIGKILL"); } catch { /* already exited */ }
  }
  const finalExit = await processExitWithin(proc.exited, reapTimeoutMs);
  if (finalExit.kind === "rejected") {
    throw new OwnedProcessReapError(
      proc.pid,
      `leader exit observation failed: ${errorMessage(finalExit.error)}`,
      { cause: finalExit.error },
    );
  }
  if (finalExit.kind === "timeout") {
    throw new OwnedProcessReapError(proc.pid, "leader did not reap after forced tree termination");
  }
  if (!windowsTreeAccountedFor(graceful.outcome, forced.outcome)) {
    // Report what taskkill actually said. "Targeting failed" alone gives an
    // operator holding a possibly-leaked child nothing to act on, and nothing to
    // tell apart a missing PID from a refused kill.
    throw new OwnedProcessReapError(
      proc.pid,
      "Windows tree targeting failed; only the leader was reaped "
      + `(graceful taskkill ${describeTaskkill(graceful)}, forced ${describeTaskkill(forced)})`,
    );
  }
}

/**
 * Whether the leader still needs a direct SIGKILL after the forced taskkill pass.
 *
 * Anything but a pass that reached the tree does, which is what main has always
 * done — it tested `taskkill`'s exit code for zero, so both a missing PID and a
 * refused kill fell through to this. Narrowing it to only a refused kill skipped
 * the call for exit 128, and `proc.kill()` is also what reaps Bun's own child
 * handle: without it `proc.exited` can stay pending, the bounded observation below
 * times out, and a caller still reading inherited pipes can be left waiting.
 *
 * The accounting verdict is a separate question with a different answer, so it is
 * a separate function; conflating the two is how the divergence happened.
 */
export function windowsForcedKillNeeded(forced: WindowsTaskkillOutcome): boolean {
  return forced !== "targeted";
}

/**
 * Whether the tree is accounted for, given how each taskkill pass ended and a
 * leader already confirmed exited.
 *
 * Split out as a pure decision because the surrounding function only runs on
 * win32 — the platform check is inline — so this is the only part of the Windows
 * reaper a test on another OS can reach. Real taskkill behavior is covered by
 * the Windows CI job.
 */
export function windowsTreeAccountedFor(
  graceful: WindowsTaskkillOutcome,
  forced: WindowsTaskkillOutcome,
): boolean {
  if (forced === "targeted") return true;
  // A forced pass that found no PID after a graceful pass that DID reach the
  // tree: that pass signalled every process then in it, so nothing was left
  // unsignalled, and the leader exited between the grace timeout and this call —
  // which happens often enough to matter.
  return forced === "absent" && graceful === "targeted";
}

function signalPosixTree(proc: OwnedProcess, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-proc.pid, signal);
    return;
  } catch (error: unknown) {
    if (errorCode(error) === "ESRCH") {
      try { proc.kill(signal); } catch { /* already exited */ }
      return;
    }
  }
  // EPERM or another group-signal failure does not prove the leader exited.
  // Signal it directly, then let the group confirmation fail loudly if needed.
  try { proc.kill(signal); } catch { /* already exited */ }
}

async function waitForPosixGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (posixProcessGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(10);
  }
  return true;
}

/**
 * Whether `taskkill` reached the tree.
 *
 * `absent` is deliberately not `failed`: taskkill exits non-zero both when it
 * could not reach the process and when no leader carries that PID any more.
 * Keeping them distinct preserves the exit-code diagnostic and lets a prior
 * targeted pass account for the tree; absence alone proves nothing about
 * descendants.
 */
export type WindowsTaskkillOutcome = "targeted" | "absent" | "failed";

/** taskkill's exit code when no process carries the requested PID. */
const WINDOWS_TASKKILL_NOT_FOUND = 128;

/** The outcome plus the exit code it was derived from, for diagnostics. */
export interface WindowsTaskkillResult {
  outcome: WindowsTaskkillOutcome;
  /** taskkill's exit code, or null when it could not be run at all. */
  code: number | null;
}

function describeTaskkill(result: WindowsTaskkillResult): string {
  return result.code === null ? `${result.outcome} (not run)` : `${result.outcome} (exit ${result.code})`;
}

async function runWindowsTaskkill(pid: number, force: boolean): Promise<WindowsTaskkillResult> {
  const args = ["taskkill", "/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
  try {
    const helper = Bun.spawn(args, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    const code = await helper.exited;
    if (code === 0) return { outcome: "targeted", code };
    // Matched on the exit code rather than the message: taskkill's "not found"
    // text is localized, so parsing stderr would silently stop recognizing it
    // on a non-English Windows.
    return { outcome: code === WINDOWS_TASKKILL_NOT_FOUND ? "absent" : "failed", code };
  } catch {
    return { outcome: "failed", code: null };
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}
