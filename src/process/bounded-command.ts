import {
  OwnedProcessReapError,
  posixProcessGroupExists,
  spawnOwnedProcess,
  terminateOwnedProcessTree,
} from "./owned-process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TERMINATE_GRACE_MS = 250;
const DEFAULT_STDOUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;
const DEFAULT_TOTAL_LIMIT_BYTES = 128 * 1024;
const DEFAULT_STDIN_LIMIT_BYTES = 64 * 1024 * 1024;
const REAP_CONFIRM_TIMEOUT_MS = 2_000;

export type OutputLimitBehavior = "truncate" | "error";
export type OutputCaptureMode = "head" | "tail" | "head-tail";

export interface BoundedCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** Optional bounded input written to the child and closed from process start. */
  stdin?: string | Uint8Array;
  /** Maximum UTF-8/input bytes accepted before spawning. */
  stdinLimitBytes?: number;
  /**
   * Absolute wall-clock budget for the command. It starts before spawn, is
   * never reset by progress, and initiates tree termination when reached.
   * TERM grace and confirmed reap cleanup can extend the returned duration.
   */
  timeoutMs?: number;
  /** Grace period between process-tree SIGTERM and SIGKILL. */
  terminateGraceMs?: number;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  /** Maximum raw bytes retained across stdout and stderr. */
  totalLimitBytes?: number;
  /**
   * `truncate` keeps draining after a cap is crossed and reports metadata.
   * `error` terminates and reaps the process tree, then throws.
   */
  outputLimitBehavior?: OutputLimitBehavior;
  stdoutCapture?: OutputCaptureMode;
  stderrCapture?: OutputCaptureMode;
  /**
   * Deliberate launcher escape hatch: let descendants survive a successful
   * root exit. Cancellation/deadline still terminate the owned tree. Keep this
   * false for commands expected to finish all of their work before returning.
   */
  allowBackgroundOnSuccess?: boolean;
}

export interface CommandStreamOutput {
  text: string;
  receivedBytes: number;
  capturedBytes: number;
  limitBytes: number;
  truncated: boolean;
}

export interface CommandCombinedOutput {
  receivedBytes: number;
  capturedBytes: number;
  limitBytes: number;
  /** True when the cumulative raw-byte cap was crossed. */
  truncated: boolean;
}

export interface BoundedCommandResult {
  command: readonly string[];
  exitCode: number;
  durationMs: number;
  stdout: CommandStreamOutput;
  stderr: CommandStreamOutput;
  combined: CommandCombinedOutput;
}

export type OutputLimitScope = "stdout" | "stderr" | "combined";

export class BoundedCommandError extends Error {
  constructor(
    message: string,
    readonly result: BoundedCommandResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BoundedCommandError";
  }
}

export class CommandDeadlineError extends BoundedCommandError {
  constructor(readonly timeoutMs: number, result: BoundedCommandResult) {
    super(`command exceeded its ${timeoutMs}ms wall deadline`, result);
    this.name = "CommandDeadlineError";
  }
}

export class CommandAbortError extends BoundedCommandError {
  constructor(result: BoundedCommandResult, cause?: unknown) {
    super("command was aborted", result, { cause });
    this.name = "CommandAbortError";
  }
}

export class CommandOutputLimitError extends BoundedCommandError {
  constructor(
    readonly scope: OutputLimitScope,
    readonly limitBytes: number,
    result: BoundedCommandResult,
  ) {
    super(`command exceeded the ${scope} output limit of ${limitBytes} bytes`, result);
    this.name = "CommandOutputLimitError";
  }
}

export class CommandIoError extends BoundedCommandError {
  constructor(result: BoundedCommandResult, cause: unknown) {
    super(`command pipe failed: ${errorMessage(cause)}`, result, { cause });
    this.name = "CommandIoError";
  }
}

export class CommandSpawnError extends Error {
  constructor(command: readonly string[], cause: unknown) {
    super(`could not spawn ${command[0] ?? "command"}: ${errorMessage(cause)}`, { cause });
    this.name = "CommandSpawnError";
  }
}

export class CommandReapError extends Error {
  constructor(readonly pid: number, options?: ErrorOptions) {
    super(`could not confirm that command process tree ${pid} was reaped`, options);
    this.name = "CommandReapError";
  }
}

type StreamName = "stdout" | "stderr";
type OwnedCommandProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

interface OutputViolation {
  scope: OutputLimitScope;
  limitBytes: number;
}

type StopReason =
  | { kind: "deadline" }
  | { kind: "abort"; cause?: unknown }
  | { kind: "output"; violation: OutputViolation }
  | { kind: "io"; cause: unknown };

interface OutputState {
  retainedBytes: number;
  receivedBytes: number;
  truncated: boolean;
}

class ByteCapture {
  private chunks: Uint8Array[] = [];
  private byteLength = 0;
  private headTailSplit = false;
  private headTailHeadBytes = 0;

  constructor(
    readonly limitBytes: number,
    private readonly mode: OutputCaptureMode,
  ) {}

  get size(): number {
    return this.byteLength;
  }

  append(chunk: Uint8Array, availableCombinedBytes: number): number {
    if (chunk.byteLength === 0) return 0;

    const capacityGrowth = Math.min(
      chunk.byteLength,
      Math.max(0, this.limitBytes - this.byteLength),
      Math.max(0, availableCombinedBytes),
    );
    const nextCapacity = this.byteLength + capacityGrowth;
    if (nextCapacity === 0) return 0;

    if (this.mode === "head") {
      if (capacityGrowth > 0) {
        this.chunks.push(chunk.slice(0, capacityGrowth));
        this.byteLength += capacityGrowth;
      }
      return capacityGrowth;
    }

    if (this.mode === "head-tail") {
      return this.appendHeadTail(chunk, capacityGrowth, nextCapacity);
    }

    // Tail capture reuses its already-allocated bounded storage after filling.
    // Slice only the retained suffix when one read is larger than the cap, so
    // even a very large stream chunk cannot create a large transient copy.
    if (chunk.byteLength >= nextCapacity) {
      this.chunks = [chunk.slice(chunk.byteLength - nextCapacity)];
      this.byteLength = nextCapacity;
      return capacityGrowth;
    }
    this.trimFront(nextCapacity - chunk.byteLength);
    this.chunks.push(chunk.slice());
    this.byteLength += chunk.byteLength;
    return capacityGrowth;
  }

  text(): string {
    if (this.byteLength === 0) return "";
    return new TextDecoder().decode(this.bytes());
  }

  private appendHeadTail(chunk: Uint8Array, capacityGrowth: number, nextCapacity: number): number {
    if (!this.headTailSplit && chunk.byteLength <= capacityGrowth) {
      this.chunks.push(chunk.slice());
      this.byteLength += chunk.byteLength;
      return capacityGrowth;
    }

    if (!this.headTailSplit) {
      const previous = this.bytes();
      const headBytes = nextCapacity <= 1 ? nextCapacity : Math.max(1, Math.floor(nextCapacity * 0.7));
      const tailBytes = nextCapacity - headBytes;
      const head = joinedPrefix(previous, chunk, headBytes);
      const tail = joinedSuffix(previous, chunk, tailBytes);
      this.chunks = tailBytes > 0 ? [head, tail] : [head];
      this.byteLength = nextCapacity;
      this.headTailHeadBytes = headBytes;
      this.headTailSplit = true;
      return capacityGrowth;
    }

    // Once split, the capture has reached its final stream/combined capacity:
    // preserve the original diagnostic prefix and roll only the suffix.
    const head = this.chunks[0] ?? new Uint8Array();
    const previousTail = this.chunks[1] ?? new Uint8Array();
    const tailBytes = Math.max(0, nextCapacity - this.headTailHeadBytes);
    const tail = joinedSuffix(previousTail, chunk, tailBytes);
    this.chunks = tailBytes > 0 ? [head, tail] : [head];
    this.byteLength = head.byteLength + tail.byteLength;
    return capacityGrowth;
  }

  private bytes(): Uint8Array {
    const bytes = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private trimFront(capacity: number): void {
    let excess = this.byteLength - capacity;
    while (excess > 0 && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      if (first.byteLength <= excess) {
        excess -= first.byteLength;
        this.byteLength -= first.byteLength;
        this.chunks.shift();
        continue;
      }
      this.chunks[0] = first.slice(excess);
      this.byteLength -= excess;
      excess = 0;
    }
  }
}

function joinedPrefix(previous: Uint8Array, chunk: Uint8Array, count: number): Uint8Array {
  if (count === 0) return new Uint8Array();
  const result = new Uint8Array(count);
  const previousBytes = Math.min(previous.byteLength, count);
  result.set(previous.subarray(0, previousBytes));
  if (previousBytes < count) result.set(chunk.subarray(0, count - previousBytes), previousBytes);
  return result;
}

function joinedSuffix(previous: Uint8Array, chunk: Uint8Array, count: number): Uint8Array {
  if (count === 0) return new Uint8Array();
  if (chunk.byteLength >= count) return chunk.slice(chunk.byteLength - count);
  const result = new Uint8Array(count);
  const previousBytes = count - chunk.byteLength;
  result.set(previous.subarray(previous.byteLength - previousBytes));
  result.set(chunk, previousBytes);
  return result;
}

/**
 * Run one direct-argv command with bounded output, an absolute wall deadline,
 * cancellable process-tree ownership, TERM→KILL escalation, and confirmed
 * direct-child reaping/tree termination. Both pipes drain from process start.
 * On POSIX, descendants left behind after a successful direct-child exit are
 * also terminated before the result is returned. Windows needs Job Objects to
 * make that same guarantee after the root PID has already disappeared.
 */
export async function runBoundedCommand(
  command: readonly string[],
  options: BoundedCommandOptions = {},
): Promise<BoundedCommandResult> {
  if (command.length === 0 || !command[0]) throw new TypeError("command must not be empty");

  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const terminateGraceMs = nonNegativeInteger(
    options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
    "terminateGraceMs",
  );
  const stdoutLimitBytes = nonNegativeInteger(
    options.stdoutLimitBytes ?? DEFAULT_STDOUT_LIMIT_BYTES,
    "stdoutLimitBytes",
  );
  const stderrLimitBytes = nonNegativeInteger(
    options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES,
    "stderrLimitBytes",
  );
  const totalLimitBytes = nonNegativeInteger(
    options.totalLimitBytes ?? DEFAULT_TOTAL_LIMIT_BYTES,
    "totalLimitBytes",
  );
  const outputLimitBehavior = options.outputLimitBehavior ?? "truncate";
  const stdinLimitBytes = nonNegativeInteger(
    options.stdinLimitBytes ?? DEFAULT_STDIN_LIMIT_BYTES,
    "stdinLimitBytes",
  );
  const stdin = typeof options.stdin === "string"
    ? new TextEncoder().encode(options.stdin)
    : options.stdin;
  if ((stdin?.byteLength ?? 0) > stdinLimitBytes) {
    throw new RangeError(`stdin exceeds the ${stdinLimitBytes}-byte input limit`);
  }
  const startedAt = performance.now();
  const deadlineAt = Date.now() + timeoutMs;

  if (options.signal?.aborted) {
    throw new CommandAbortError(emptyResult(command, startedAt, stdoutLimitBytes, stderrLimitBytes, totalLimitBytes), options.signal.reason);
  }

  const captures: Record<StreamName, ByteCapture> = {
    stdout: new ByteCapture(stdoutLimitBytes, options.stdoutCapture ?? "head"),
    stderr: new ByteCapture(stderrLimitBytes, options.stderrCapture ?? "tail"),
  };
  const received: Record<StreamName, number> = { stdout: 0, stderr: 0 };
  const truncated: Record<StreamName, boolean> = { stdout: false, stderr: false };
  const combined: OutputState = { retainedBytes: 0, receivedBytes: 0, truncated: false };

  let resolveStop!: (reason: StopReason) => void;
  const stopRequested = new Promise<StopReason>((resolve) => { resolveStop = resolve; });
  let stopReason: StopReason | undefined;
  const requestStop = (reason: StopReason): void => {
    if (stopReason) return;
    stopReason = reason;
    resolveStop(reason);
  };

  let proc: OwnedCommandProcess;
  try {
    proc = spawnOwnedProcess(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  } catch (error) {
    throw new CommandSpawnError(command, error);
  }

  const captureChunk = (name: StreamName, chunk: Uint8Array): void => {
    received[name] += chunk.byteLength;
    combined.receivedBytes += chunk.byteLength;

    const retained = captures[name].append(chunk, totalLimitBytes - combined.retainedBytes);
    combined.retainedBytes += retained;

    const streamLimit = name === "stdout" ? stdoutLimitBytes : stderrLimitBytes;
    const streamExceeded = received[name] > streamLimit;
    const combinedExceeded = combined.receivedBytes > totalLimitBytes;
    const omitted = captures[name].size < Math.min(received[name], streamLimit);
    truncated[name] ||= streamExceeded || omitted;
    combined.truncated ||= combinedExceeded;

    if (outputLimitBehavior !== "error") return;
    if (streamExceeded) {
      requestStop({ kind: "output", violation: { scope: name, limitBytes: streamLimit } });
    } else if (combinedExceeded) {
      requestStop({ kind: "output", violation: { scope: "combined", limitBytes: totalLimitBytes } });
    }
  };

  let releasingPipes = false;
  const activeReaders: Partial<Record<StreamName, ReadableStreamDefaultReader<Uint8Array>>> = {};
  const drain = async (name: StreamName, stream: ReadableStream<Uint8Array>): Promise<void> => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      reader = stream.getReader();
      activeReaders[name] = reader;
      while (true) {
        const item = await reader.read();
        if (item.done) return;
        captureChunk(name, item.value);
      }
    } catch (error) {
      if (!releasingPipes) requestStop({ kind: "io", cause: error });
    } finally {
      if (activeReaders[name] === reader) delete activeReaders[name];
      reader?.releaseLock();
    }
  };

  let exitCode = -1;
  const exitPromise = proc.exited.then(
    (code) => {
      exitCode = code;
    },
    (error: unknown) => {
      requestStop({ kind: "io", cause: error });
    },
  );
  const stdoutDrain = drain("stdout", proc.stdout);
  const stderrDrain = drain("stderr", proc.stderr);
  const stdinPump = (async (): Promise<void> => {
    try {
      if (stdin && stdin.byteLength > 0) await proc.stdin.write(stdin);
      await proc.stdin.end();
    } catch (error: unknown) {
      // A child that exits before consuming all input owns that decision; its
      // exit code remains authoritative. Other pipe failures are operational.
      if (errorCode(error) !== "EPIPE") requestStop({ kind: "io", cause: error });
    }
  })();
  const completed = Promise.all([exitPromise, stdinPump, stdoutDrain, stderrDrain]).then(() => undefined);
  // Even a launcher opt-out must finish ownership of its input pipe before we
  // return. Output pipes may intentionally remain inherited by the launched GUI
  // and are released below, but an unobserved blocked stdin write is never safe.
  const completion = options.allowBackgroundOnSuccess
    ? Promise.all([exitPromise, stdinPump]).then(() => undefined)
    : completed;

  const releasePipeDrains = async (): Promise<void> => {
    releasingPipes = true;
    const readers = Object.values(activeReaders);
    await Promise.all(readers.map((reader) => reader.cancel().catch(() => {})));
    await Promise.all([stdoutDrain, stderrDrain]);
  };

  const abort = (): void => requestStop({ kind: "abort", cause: options.signal?.reason });
  options.signal?.addEventListener("abort", abort, { once: true });
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (remainingMs === 0) {
    requestStop({ kind: "deadline" });
  } else {
    deadlineTimer = setTimeout(() => requestStop({ kind: "deadline" }), remainingMs);
  }

  try {
    const outcome = await Promise.race([
      completion.then(() => ({ kind: "completed" as const })),
      stopRequested.then((reason) => ({ kind: "stopped" as const, reason })),
    ]);

    if (outcome.kind === "completed") {
      // A shell can report success after backgrounding a child whose stdio was
      // redirected away from our pipes. The child still belongs to the detached
      // POSIX process group, so never let it outlive a supposedly finished
      // command. On Windows taskkill /T cannot reliably rediscover descendants
      // after the root PID exits; cancellation/deadline paths invoke it while
      // the root is still present, while normal-exit parity requires Job Objects.
      if (options.allowBackgroundOnSuccess && exitCode === 0) {
        // A deliberately launched GUI may inherit the launcher's stdio handles.
        // Once the root exits, stop owning those pipes as well as the process;
        // otherwise pipe closure would incorrectly turn the opt-out into a
        // deadline and kill the application it was meant to leave running.
        await releasePipeDrains();
      } else {
        if (process.platform !== "win32" && posixProcessGroupExists(proc.pid)) {
          await terminateCommandTree(proc, terminateGraceMs);
        }
        // The launcher exception applies only to success. A failed launcher
        // still owns its descendants and diagnostics, including inherited
        // pipes that remain open after the root has exited.
        if (!(await settlesWithin(completed, REAP_CONFIRM_TIMEOUT_MS))) {
          await terminateCommandTree(proc, terminateGraceMs);
        }
        if (!(await settlesWithin(completed, REAP_CONFIRM_TIMEOUT_MS))) {
          throw new CommandReapError(proc.pid);
        }
      }
      return buildResult();
    }

    await terminateCommandTree(proc, terminateGraceMs);
    if (!(await settlesWithin(completed, REAP_CONFIRM_TIMEOUT_MS))) {
      throw new CommandReapError(proc.pid);
    }
    const result = buildResult();
    switch (outcome.reason.kind) {
      case "deadline":
        throw new CommandDeadlineError(timeoutMs, result);
      case "abort":
        throw new CommandAbortError(result, outcome.reason.cause);
      case "output":
        throw new CommandOutputLimitError(
          outcome.reason.violation.scope,
          outcome.reason.violation.limitBytes,
          result,
        );
      case "io":
        throw new CommandIoError(result, outcome.reason.cause);
    }
    throw new Error("unreachable command stop reason");
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", abort);
  }

  function buildResult(): BoundedCommandResult {
    return {
      command: [...command],
      exitCode,
      durationMs: performance.now() - startedAt,
      stdout: {
        text: captures.stdout.text(),
        receivedBytes: received.stdout,
        capturedBytes: captures.stdout.size,
        limitBytes: stdoutLimitBytes,
        truncated: truncated.stdout,
      },
      stderr: {
        text: captures.stderr.text(),
        receivedBytes: received.stderr,
        capturedBytes: captures.stderr.size,
        limitBytes: stderrLimitBytes,
        truncated: truncated.stderr,
      },
      combined: {
        receivedBytes: combined.receivedBytes,
        capturedBytes: combined.retainedBytes,
        limitBytes: totalLimitBytes,
        truncated: combined.truncated,
      },
    };
  }
}

async function terminateCommandTree(proc: OwnedCommandProcess, graceMs: number): Promise<void> {
  try {
    await terminateOwnedProcessTree(proc, {
      terminateGraceMs: graceMs,
      reapTimeoutMs: REAP_CONFIRM_TIMEOUT_MS,
    });
  } catch (error: unknown) {
    if (error instanceof OwnedProcessReapError) {
      throw new CommandReapError(proc.pid, { cause: error });
    }
    throw error;
  }
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs === 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function emptyResult(
  command: readonly string[],
  startedAt: number,
  stdoutLimitBytes: number,
  stderrLimitBytes: number,
  totalLimitBytes: number,
): BoundedCommandResult {
  return {
    command: [...command],
    exitCode: -1,
    durationMs: performance.now() - startedAt,
    stdout: { text: "", receivedBytes: 0, capturedBytes: 0, limitBytes: stdoutLimitBytes, truncated: false },
    stderr: { text: "", receivedBytes: 0, capturedBytes: 0, limitBytes: stderrLimitBytes, truncated: false },
    combined: { receivedBytes: 0, capturedBytes: 0, limitBytes: totalLimitBytes, truncated: false },
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const value = Reflect.get(error, "code");
  return typeof value === "string" ? value : undefined;
}
