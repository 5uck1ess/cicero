import { log } from "../logger";
import {
  BoundedCommandError,
  runBoundedCommand,
  type BoundedCommandResult,
} from "../process/bounded-command";
import {
  processExitWithin,
  spawnOwnedProcess,
  terminateOwnedProcessTree,
} from "../process/owned-process";
import {
  abortableDelay,
  PROVIDER_TIMEOUT_MS,
  providerSignal,
  responseIsOk,
} from "./http-transfer";

type ManagedSubprocess = Bun.Subprocess<"ignore", "ignore", "pipe">;

export interface ManagedProcess {
  proc: ManagedSubprocess | null;
  containerId?: string;
  dockerCommand?: string;
  port: number;
  managed: boolean;
  mode: "process" | "docker";
  /** Set by stopManagedServer so the supervisor ignores the intentional exit. */
  stopping?: boolean;
  /** Internal lifecycle ownership for a supervised process. */
  supervisorAbort?: AbortController | null;
  /** Settles only after the supervisor has released backoff/readiness work. */
  supervisorTask?: Promise<void> | null;
}

interface StartOpts {
  name: string;
  port: number;
  command: string[];
  healthUrl: string;
  timeoutMs?: number;
  intervalMs?: number;
  mode?: "process" | "docker";
  /**
   * Respawn the child if it dies after a healthy start (GPU OOM, segfault…).
   * Without this a mid-session crash silently degrades every call to the
   * provider's fallback until the next daemon restart. Backoff 1s/5s/15s;
   * gives up after 3 consecutive failed revivals (loud error each time).
   */
  supervise?: boolean;
}

const REVIVE_BACKOFF_MS = [1000, 5000, 15000];
const PROCESS_TERMINATE_GRACE_MS = 250;
const PROCESS_REAP_TIMEOUT_MS = 2_000;
const STDERR_DRAIN_TIMEOUT_MS = 1_000;
const STDERR_PARTIAL_LIMIT_CHARS = 16 * 1024;
const STDERR_TRUNCATION_MARKER = "...[truncated] ";
const DOCKER_STOP_GRACE_SECONDS = 5;
const DOCKER_STOP_TIMEOUT_MS = 10_000;
const DOCKER_OUTPUT_LIMIT_BYTES = 4 * 1024;
const DOCKER_CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const stderrTailCaptures = new WeakMap<ManagedSubprocess, StderrTailCapture>();

interface StderrTailCapture {
  lines: string[];
  done: Promise<void>;
  cancel: () => Promise<void>;
}

/** Watch a supervised child; on unexpected exit, respawn until stopped. */
function superviseProcess(mp: ManagedProcess, opts: StartOpts, attempt = 0): void {
  if (!mp.proc || mp.supervisorTask) return;
  const controller = new AbortController();
  mp.supervisorAbort = controller;
  const task = runSupervisor(mp, opts, attempt, controller.signal).catch((err: unknown) => {
    if (!controller.signal.aborted) {
      // e.g. Bun.spawn ENOENT if the binary was deleted mid-session — never
      // let supervisor failure take the daemon down with it.
      log("error", `${opts.name} supervisor error (no further revivals): ${err instanceof Error ? err.message : String(err)}`);
    }
  }).finally(() => {
    if (mp.supervisorTask === task) mp.supervisorTask = null;
    if (mp.supervisorAbort === controller) mp.supervisorAbort = null;
  });
  mp.supervisorTask = task;
}

async function runSupervisor(
  mp: ManagedProcess,
  opts: StartOpts,
  attempt: number,
  signal: AbortSignal,
): Promise<void> {
  let proc = mp.proc;
  while (proc && !signal.aborted && !mp.stopping) {
    let exited: Awaited<ReturnType<typeof waitForProcessExitOrStop>>;
    try {
      exited = await waitForProcessExitOrStop(proc, signal);
    } catch (error: unknown) {
      if (signal.aborted || mp.stopping || mp.proc !== proc) return;
      // A rejected wait does not prove this launcher or its workers are gone.
      // Drive fail-closed cleanup before the supervisor gives up; the shared
      // helper preserves the rejected observer as a typed ownership failure.
      try {
        await terminateAndReap(proc);
      } catch (cleanupError: unknown) {
        const observationDetail = error instanceof Error ? error.message : String(error);
        const cleanupDetail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(
          `${opts.name} process ${proc.pid} exit observation failed: ${observationDetail}; cleanup failed: ${cleanupDetail}`,
          { cause: new AggregateError([error, cleanupError], "managed process exit observation and cleanup failed") },
        );
      }
      throw new Error(
        `${opts.name} process ${proc.pid} exit observation failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (exited.kind === "stopped" || signal.aborted || mp.stopping) return;
    if (mp.proc !== proc) return;

    // A launcher can exit while one of its workers remains in the detached
    // group. Prove the retired tree is gone before diagnostics or any revival
    // can wait on inherited pipes or claim the same port/GPU resources.
    await terminateAndReap(proc);
    releaseManagedProcess(mp, proc);

    const crashTail = stderrTailCaptures.get(proc);
    if (crashTail) {
      await finishStderrTail(crashTail);
      stderrTailCaptures.delete(proc);
      if (crashTail.lines.length > 0) {
        log("error", `${opts.name} crash stderr (last ${Math.min(crashTail.lines.length, 5)} lines):\n  ${crashTail.lines.slice(-5).join("\n  ")}`);
      }
    }

    let code: number | NodeJS.Signals = exited.code;
    while (!signal.aborted && !mp.stopping) {
      if (attempt >= REVIVE_BACKOFF_MS.length) {
        log("error", `${opts.name} server died again (code ${code}) — giving up after ${attempt} failed revivals; ${opts.name} stays DOWN until restart`);
        return;
      }

      const delay = REVIVE_BACKOFF_MS[attempt] ?? 15000;
      log("error", `${opts.name} server exited unexpectedly (code ${code}) — reviving in ${delay / 1000}s (attempt ${attempt + 1}/${REVIVE_BACKOFF_MS.length})`);
      if (!(await waitForLifecycleDelay(delay, signal)) || mp.stopping) return;

      const next = spawnOwnedProcess(opts.command, {
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env },
        windowsHide: true,
      });
      // Publish ownership in the same synchronous turn as spawn. stop() can
      // always reach a revival child, including during readiness.
      mp.proc = next;
      const stderrTail = collectStderrTail(next);
      const outcome = await waitForHealthOrExit(
        next,
        opts.healthUrl,
        opts.timeoutMs ?? 60000,
        opts.intervalMs ?? 1000,
        signal,
      );

      if (outcome === "stopped" || signal.aborted || mp.stopping) {
        // stopManagedServer owns cancellation cleanup and then awaits this task.
        // Never call it here: a supervisor awaiting itself would deadlock.
        return;
      }
      if (outcome === "healthy") {
        log("ok", `${opts.name} server revived on :${opts.port}`);
        proc = next;
        attempt = 0;
        break;
      }

      await terminateAndReap(next);
      releaseManagedProcess(mp, next);
      await finishStderrTail(stderrTail);
      stderrTailCaptures.delete(next);
      if (stderrTail.lines.length > 0) {
        log("error", `${opts.name} revival stderr (last ${Math.min(stderrTail.lines.length, 5)} lines):\n  ${stderrTail.lines.slice(-5).join("\n  ")}`);
      }
      code = next.exitCode ?? next.signalCode ?? -1;
      attempt += 1;
    }
  }
}

async function waitForProcessExitOrStop(
  proc: ManagedSubprocess,
  signal: AbortSignal,
): Promise<{ kind: "exited"; code: number } | { kind: "stopped" }> {
  if (signal.aborted) return { kind: "stopped" };
  let onAbort: (() => void) | undefined;
  try {
    const stopped = new Promise<{ kind: "stopped" }>((resolve) => {
      onAbort = () => resolve({ kind: "stopped" });
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([
      proc.exited.then((code) => ({ kind: "exited" as const, code })),
      stopped,
    ]);
  } catch (err: unknown) {
    throw err;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function waitForLifecycleDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  try {
    await abortableDelay(ms, signal);
    return true;
  } catch (err: unknown) {
    if (signal.aborted) return false;
    throw err;
  }
}

async function checkHealth(
  url: string,
  timeoutMs: number = PROVIDER_TIMEOUT_MS.health,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  try {
    const probe = fetch(url, { signal: providerSignal(timeoutMs, signal) }).then((res) => responseIsOk(res));
    return signal ? await valueOrAbort(probe, signal, false) : await probe;
  } catch {
    return false;
  }
}

async function waitForHealth(url: string, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probeBudgetMs = Math.max(1, Math.min(PROVIDER_TIMEOUT_MS.health, deadline - Date.now()));
    if (await checkHealth(url, probeBudgetMs)) return true;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await Bun.sleep(Math.min(Math.max(0, intervalMs), remainingMs));
  }
  return false;
}

/**
 * Like {@link waitForHealth}, but also watches the child process: a server that
 * crashes at launch resolves "exited" within one poll interval instead of
 * silently burning the whole health timeout.
 */
async function waitForHealthOrExit(
  proc: ManagedSubprocess,
  url: string,
  timeoutMs: number,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<"healthy" | "exited" | "timeout" | "stopped"> {
  // Install the exit observer as soon as readiness begins. Polling only Bun's
  // nullable exitCode fields leaves a rejected `exited` promise unhandled and
  // can misclassify a broken/dead launcher as merely unhealthy until timeout.
  let exitObserved = false;
  void proc.exited.then(
    () => { exitObserved = true; },
    () => { exitObserved = true; },
  );
  const processExited = (): boolean =>
    exitObserved || proc.exitCode !== null || proc.signalCode !== null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return "stopped";
    if (processExited()) return "exited";
    const probeBudgetMs = Math.max(1, Math.min(PROVIDER_TIMEOUT_MS.health, deadline - Date.now()));
    const healthy = await checkHealth(url, probeBudgetMs, signal);
    if (processExited()) return "exited";
    if (healthy) return "healthy";
    if (signal?.aborted) return "stopped";
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const delayMs = Math.min(Math.max(0, intervalMs), remainingMs);
    if (signal) {
      if (!(await waitForLifecycleDelay(delayMs, signal))) return "stopped";
    } else {
      await Bun.sleep(delayMs);
    }
  }
  return "timeout";
}

async function valueOrAbort<T>(promise: Promise<T>, signal: AbortSignal, abortedValue: T): Promise<T> {
  if (signal.aborted) return abortedValue;
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<T>((resolve) => {
      onAbort = () => resolve(abortedValue);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([promise, aborted]);
  } catch (err: unknown) {
    throw err;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Drain a child's piped stderr into a rolling, memory-bounded diagnostic tail. */
function collectStderrTail(proc: ManagedSubprocess, maxLines = 40): StderrTailCapture {
  const lines: string[] = [];
  const stderr = proc.stderr;
  if (!stderr || typeof stderr === "number") {
    return { lines, done: Promise.resolve(), cancel: () => Promise.resolve() };
  }

  const reader = (stderr as ReadableStream<Uint8Array>).getReader();
  let partial = "";
  let partialTruncated = false;
  const pushLine = (): void => {
    const suffix = partial.trimEnd();
    if (suffix) {
      lines.push(`${partialTruncated ? STDERR_TRUNCATION_MARKER : ""}${suffix}`);
      while (lines.length > Math.max(1, maxLines)) lines.shift();
    }
    partial = "";
    partialTruncated = false;
  };
  const appendPartial = (fragment: string): void => {
    if (!fragment) return;
    if (fragment.length >= STDERR_PARTIAL_LIMIT_CHARS) {
      partialTruncated ||= partial.length > 0 || fragment.length > STDERR_PARTIAL_LIMIT_CHARS;
      partial = fragment.slice(-STDERR_PARTIAL_LIMIT_CHARS);
      return;
    }
    const available = STDERR_PARTIAL_LIMIT_CHARS - fragment.length;
    if (partial.length > available) {
      partial = partial.slice(partial.length - available);
      partialTruncated = true;
    }
    partial += fragment;
  };
  const consume = (text: string): void => {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      if (newline === -1) {
        appendPartial(text.slice(offset));
        return;
      }
      appendPartial(text.slice(offset, newline));
      pushLine();
      offset = newline + 1;
    }
  };

  const done = (async () => {
    try {
      const decoder = new TextDecoder();
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        consume(decoder.decode(item.value, { stream: true }));
      }
      consume(decoder.decode());
      pushLine();
    } catch { /* process ended */ }
    finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  })();

  const capture = {
    lines,
    done,
    cancel: () => reader.cancel().then(() => undefined).catch(() => undefined),
  };
  stderrTailCaptures.set(proc, capture);
  return capture;
}

export async function startManagedServer(opts: StartOpts): Promise<ManagedProcess | null> {
  const { name, port, command, healthUrl, timeoutMs = 60000, intervalMs = 1000, mode = "process" } = opts;

  if (await checkHealth(healthUrl)) {
    log("ok", `${name} server already running on :${port}`);
    return { proc: null, port, managed: false, mode };
  }

  const binary = mode === "docker" ? "docker" : command[0];
  // Bun.which() is cross-platform (PATH/PATHEXT on Windows); fall back to a
  // direct file check for absolute/relative paths it won't resolve.
  const resolvedBinary = Bun.which(binary, { PATH: process.env.PATH })
    ?? (await Bun.file(binary).exists() ? binary : null);
  if (!resolvedBinary) {
    log("error", `${name}: binary '${binary}' not found — ${name} is DISABLED this run (every ${name} call will fail). If this is a venv path, create the venv/symlink it points at.`);
    return null;
  }

  log("info", `Starting ${name} server on :${port}...`);

  if (mode === "docker") {
    const dockerCommand = resolvedBinary;
    let result: BoundedCommandResult;
    try {
      result = await runBoundedCommand([dockerCommand, "run", "-d", "-p", `${port}:${port}`, ...command], {
        env: { ...process.env },
        timeoutMs,
        terminateGraceMs: PROCESS_TERMINATE_GRACE_MS,
        stdoutLimitBytes: DOCKER_OUTPUT_LIMIT_BYTES,
        stderrLimitBytes: DOCKER_OUTPUT_LIMIT_BYTES,
        totalLimitBytes: DOCKER_OUTPUT_LIMIT_BYTES * 2,
      });
    } catch (err: unknown) {
      const containerId = err instanceof BoundedCommandError
        ? parseDockerContainerId(err.result.stdout.text)
        : null;
      if (containerId) await stopDockerContainer(containerId, name, dockerCommand);
      log("warn", `${name}: docker run failed within its ${timeoutMs}ms budget: ${boundedCommandMessage(err)}`);
      return null;
    }
    const containerId = parseDockerContainerId(result.stdout.text);

    if (result.exitCode !== 0) {
      if (containerId) await stopDockerContainer(containerId, name, dockerCommand);
      const detail = result.stderr.text.trim();
      log("warn", `${name}: docker run exited with code ${result.exitCode}${detail ? `: ${detail}` : ""}`);
      return null;
    }
    if (!containerId) {
      log("warn", `${name}: docker run produced no single valid container ID — check image and command`);
      return null;
    }

    const healthy = await waitForHealth(healthUrl, timeoutMs, intervalMs);
    if (healthy) {
      log("ok", `${name} server ready on :${port} (docker: ${containerId.substring(0, 12)})`);
      return { proc: null, containerId, dockerCommand, port, managed: true, mode };
    }
    log("warn", `${name} server did not become healthy in ${timeoutMs / 1000}s — continuing in degraded mode`);
    await stopDockerContainer(containerId, name, dockerCommand);
    return null;
  }

  const proc = spawnOwnedProcess(command, {
    stdout: "ignore", stderr: "pipe", env: { ...process.env },
  });
  const stderrTail = collectStderrTail(proc);

  const outcome = await waitForHealthOrExit(proc, healthUrl, timeoutMs, intervalMs);
  if (outcome === "healthy") {
    log("ok", `${name} server ready on :${port}`);
    const mp: ManagedProcess = { proc, port, managed: true, mode };
    if (opts.supervise) superviseProcess(mp, opts);
    return mp;
  }

  if (outcome === "exited") {
    log("error", `${name} server exited during startup (code ${proc.exitCode ?? proc.signalCode})`);
  } else {
    log("warn", `${name} server did not become healthy in ${timeoutMs / 1000}s — stopping it and continuing in degraded mode`);
  }
  await terminateAndReap(proc);
  await finishStderrTail(stderrTail);
  stderrTailCaptures.delete(proc);
  if (stderrTail.lines.length > 0) {
    log("error", `${name} stderr (last ${Math.min(stderrTail.lines.length, 10)} lines):\n  ${stderrTail.lines.slice(-10).join("\n  ")}`);
  }
  return null;
}

export async function stopManagedServer(mp: ManagedProcess): Promise<void> {
  mp.stopping = true; // intentional — the supervisor must not revive
  const supervisorTask = mp.supervisorTask;
  const supervisorAbort = mp.supervisorAbort;
  if (supervisorAbort && !supervisorAbort.signal.aborted) {
    supervisorAbort.abort(new Error("managed server is stopping"));
  }

  try {
    if (!mp.managed) return;
    if (mp.mode === "docker" && mp.containerId) {
      await stopDockerContainer(mp.containerId, "Managed", mp.dockerCommand);
    } else if (mp.proc) {
      const proc = mp.proc;
      await terminateAndReap(proc);
      releaseManagedProcess(mp, proc);
      const stderrTail = stderrTailCaptures.get(proc);
      if (stderrTail) await finishStderrTail(stderrTail);
      stderrTailCaptures.delete(proc);
    }
  } finally {
    // runSupervisor never calls stopManagedServer; its cancellation path
    // returns to this external owner, so awaiting the tracked task cannot make
    // the supervisor await itself.
    if (supervisorTask) await supervisorTask.catch(() => { /* already logged */ });
  }
}

/** Drop only the exact child whose cleanup was confirmed; never erase a revival. */
function releaseManagedProcess(mp: ManagedProcess, proc: ManagedSubprocess): void {
  if (mp.proc === proc) mp.proc = null;
}

/**
 * Stop the shared owned tree and confirm leader reap. POSIX also confirms group
 * disappearance; Windows uses taskkill /T while a live root is enumerable.
 */
async function terminateAndReap(proc: ManagedSubprocess): Promise<void> {
  try {
    // Once a Windows root has already exited, taskkill can no longer enumerate
    // its descendants. Preserve the existing exact-leader proof for that race;
    // live roots use the shared fail-closed tree fallback below.
    if (process.platform === "win32" && (proc.exitCode !== null || proc.signalCode !== null)) {
      const observed = await processExitWithin(proc.exited, PROCESS_REAP_TIMEOUT_MS);
      if (observed.kind === "exited") return;
      if (observed.kind === "rejected") {
        throw new Error(`managed process ${proc.pid} exit observation failed`, { cause: observed.error });
      }
      throw new Error(`could not confirm that managed process ${proc.pid} was reaped`);
    }
    await terminateOwnedProcessTree(proc, {
      terminateGraceMs: PROCESS_TERMINATE_GRACE_MS,
      reapTimeoutMs: PROCESS_REAP_TIMEOUT_MS,
    });
  } catch (err: unknown) {
    throw new Error(`managed process ${proc.pid} cleanup failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

async function finishStderrTail(capture: StderrTailCapture): Promise<void> {
  try {
    if (await promiseSettledWithin(capture.done, STDERR_DRAIN_TIMEOUT_MS)) return;
    await promiseSettledWithin(capture.cancel(), PROCESS_TERMINATE_GRACE_MS);
    await promiseSettledWithin(capture.done, PROCESS_TERMINATE_GRACE_MS);
  } catch { /* diagnostics are best effort after confirmed process cleanup */ }
}

async function promiseSettledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
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

async function stopDockerContainer(
  containerId: string,
  name: string,
  dockerCommand = "docker",
): Promise<void> {
  try {
    const result = await runBoundedCommand([
      dockerCommand,
      "stop",
      `--timeout=${DOCKER_STOP_GRACE_SECONDS}`,
      containerId,
    ], {
      env: { ...process.env },
      timeoutMs: DOCKER_STOP_TIMEOUT_MS,
      terminateGraceMs: PROCESS_TERMINATE_GRACE_MS,
      stdoutLimitBytes: DOCKER_OUTPUT_LIMIT_BYTES,
      stderrLimitBytes: DOCKER_OUTPUT_LIMIT_BYTES,
      totalLimitBytes: DOCKER_OUTPUT_LIMIT_BYTES * 2,
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.text.trim();
      log("info", `${name} docker stop for container ${containerId} exited with code ${result.exitCode}${detail ? `: ${detail}` : ""}`);
    }
  } catch (err: unknown) {
    log("info", `${name} docker stop for container ${containerId} failed within its ${DOCKER_STOP_TIMEOUT_MS}ms budget: ${boundedCommandMessage(err)}`);
  }
}

function boundedCommandMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof BoundedCommandError)) return message;
  const stderr = error.result.stderr.text.trim();
  return stderr ? `${message}: ${stderr}` : message;
}

function parseDockerContainerId(stdout: string): string | null {
  const candidate = stdout.trim();
  return DOCKER_CONTAINER_ID_PATTERN.test(candidate) ? candidate : null;
}
