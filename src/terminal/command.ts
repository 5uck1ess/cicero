export interface TerminalCommandOptions {
  captureStdout?: boolean;
  timeoutMs?: number;
  label?: string;
}

export interface TerminalCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type TerminalCommandExecutor = (
  args: string[],
  options?: TerminalCommandOptions,
) => Promise<TerminalCommandResult>;

const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;

/** Execute a terminal CLI command with bounded runtime and observable failures. */
export const executeTerminalCommand: TerminalCommandExecutor = async (
  args,
  options = {},
) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const label = options.label ?? args.slice(0, 3).join(" ");
  const proc = Bun.spawn(args, {
    stdout: options.captureStdout ? "pipe" : "ignore",
    stderr: "pipe",
  });
  const stdoutPromise = proc.stdout instanceof ReadableStream
    ? new Response(proc.stdout).text().then(
      (value) => ({ value, error: null as unknown }),
      (error: unknown) => ({ value: "", error }),
    )
    : Promise.resolve({ value: "", error: null as unknown });
  const stderrPromise = new Response(proc.stderr).text().then(
    (value) => ({ value, error: null as unknown }),
    (error: unknown) => ({ value: "", error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    const [stdoutResult, stderrResult] = await Promise.all([stdoutPromise, stderrPromise]);
    if (stdoutResult.error) {
      throw stdoutResult.error instanceof Error
        ? stdoutResult.error
        : new Error(`Could not read ${label} stdout: ${String(stdoutResult.error)}`);
    }
    if (stderrResult.error) {
      throw stderrResult.error instanceof Error
        ? stderrResult.error
        : new Error(`Could not read ${label} stderr: ${String(stderrResult.error)}`);
    }
    const stdout = stdoutResult.value;
    const stderr = stderrResult.value;
    if (exitCode !== 0) {
      const detail = stderr.trim();
      throw new Error(`${label} failed with exit code ${exitCode}${detail ? `: ${detail}` : ""}`);
    }
    return { stdout, stderr, exitCode };
  } catch (err: unknown) {
    if (timedOut) {
      try {
        proc.kill(9);
      } catch {
        // The process may have exited between the deadline and SIGKILL.
      }
      await Promise.race([
        proc.exited.catch(() => -1),
        Bun.sleep(250).then(() => -1).catch(() => -1),
      ]).catch(() => -1);
    }
    if (err instanceof Error) throw err;
    throw new Error(`${label} failed: ${String(err)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
