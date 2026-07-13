import type { Brain, BrainTurnOptions } from "../types";
import { log } from "../logger";
import { iterateTextStream } from "./stream-utils";
import { BrainTurnContext } from "./turn-context";
import {
  posixProcessGroupExists,
  processExitWithin,
  spawnOwnedProcess,
  terminateOwnedProcessTree,
  type OwnedProcess,
} from "../process/owned-process";

export interface SubprocessCLIBrainConfig {
  name: string;          // for logging
  binary: string;        // binary on PATH, e.g. "claude" / "codex" / "gemini" / "qwen"
  args: string[];        // args inserted before the prompt, e.g. ["--print"]
  promptViaStdin?: boolean; // if true, pipe prompt via stdin instead of argv
  env?: Record<string, string>;     // vars to add to the child env
  unsetEnv?: string[];              // vars to REMOVE from the child env (e.g. ANTHROPIC_API_KEY to force OAuth)
  /** False when the CLI itself resumes a stateful session. Default true. */
  rememberTurns?: boolean;
}

export type TurnProcess = OwnedProcess;
const CANCEL_GRACE_MS = 500;
const CANCEL_REAP_TIMEOUT_MS = 2_000;
const OUTPUT_CLOSE_EXIT_GRACE_MS = 500;
const turnTerminations = new WeakMap<TurnProcess, Promise<void>>();

/** Terminate the whole owned turn tree, escalate, and confirm leader reap. */
export function terminateTurn(proc: TurnProcess): Promise<void> {
  const existing = turnTerminations.get(proc);
  if (existing) return existing;
  const task = terminateOwnedProcessTree(proc, {
    terminateGraceMs: CANCEL_GRACE_MS,
    reapTimeoutMs: CANCEL_REAP_TIMEOUT_MS,
  }).catch((error: unknown) => {
    throw new Error(
      `could not confirm turn process tree ${proc.pid} exited: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  });
  const tracked = task.finally(() => {
    if (turnTerminations.get(proc) === tracked) turnTerminations.delete(proc);
  });
  turnTerminations.set(proc, tracked);
  return tracked;
}

/**
 * Observe the leader from spawn time and reap POSIX descendants left behind by
 * a normal CLI exit. Starting this immediately also closes inherited pipes.
 */
export async function awaitOwnedTurnExit(proc: TurnProcess): Promise<number> {
  let code: number;
  try {
    code = await proc.exited;
  } catch (error: unknown) {
    // A broken exit observer proves nothing about the leader or descendants.
    // Still drive the shared fail-closed cleanup before surfacing the ownership
    // failure, retaining both causes when confirmation necessarily fails too.
    return failTurnExitObservation(proc, error);
  }
  if (process.platform !== "win32" && posixProcessGroupExists(proc.pid)) {
    await terminateTurn(proc);
  }
  return code;
}

/**
 * A closed JSON stdout is terminal for a progress turn. Give the CLI a short
 * normal-exit grace, then own/reap it and report the protocol hang explicitly.
 */
export async function awaitTurnExitAfterOutput(
  proc: TurnProcess,
  ownedExit: Promise<number> = awaitOwnedTurnExit(proc),
): Promise<number> {
  const observed = await processExitWithin(ownedExit, OUTPUT_CLOSE_EXIT_GRACE_MS);
  if (observed.kind === "exited") return observed.code;
  if (observed.kind === "rejected") {
    return failTurnExitObservation(proc, observed.error);
  }
  await terminateTurn(proc);
  throw new Error(`turn process ${proc.pid} remained alive after its output stream closed`);
}

async function failTurnExitObservation(proc: TurnProcess, observationError: unknown): Promise<never> {
  const detail = observationError instanceof Error ? observationError.message : String(observationError);
  try {
    await terminateTurn(proc);
  } catch (cleanupError: unknown) {
    const cleanupDetail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new Error(
      `turn process ${proc.pid} exit observation failed: ${detail}; cleanup failed: ${cleanupDetail}`,
      { cause: new AggregateError([observationError, cleanupError], "turn exit observation and cleanup failed") },
    );
  }
  throw new Error(`turn process ${proc.pid} exit observation failed: ${detail}`, { cause: observationError });
}

/**
 * Shared base for CLI-backed brains that spawn a fresh subprocess per turn.
 * Handles context buffering, the argv-vs-stdin prompt modes, and both batch
 * (`send`) and streaming (`sendStream`) output.
 */
export class SubprocessCLIBrain implements Brain {
  protected turnContext = new BrainTurnContext();
  protected config: SubprocessCLIBrainConfig;

  constructor(config: SubprocessCLIBrainConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    log("info", `Brain (${this.config.name}) initialized`);
  }

  async stop(): Promise<void> {
    // Each send spawns its own subprocess; nothing persistent to stop.
  }

  // Inline-literal spawn options keep Bun's stdout/stderr narrowed to
  // ReadableStream (a hoisted options object would widen them to a union).
  /** Child env: inherit the parent, add `config.env`, then drop `config.unsetEnv`. */
  private buildEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, ...(this.config.env || {}) };
    for (const key of this.config.unsetEnv ?? []) delete env[key];
    return env;
  }

  /** Args for the next turn — subclasses can vary these (e.g. session resume). */
  protected argsForTurn(): string[] {
    return this.config.args;
  }

  /** Called after a turn's subprocess exits 0 — hook for session tracking. */
  protected onTurnComplete(): void {}

  private spawnProc(message: string) {
    const fullMessage = this.buildPrompt(message);
    const env = this.buildEnv();
    const { binary } = this.config;
    const args = this.argsForTurn();

    if (this.config.promptViaStdin) {
      return spawnOwnedProcess([binary, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env,
        stdin: new Response(fullMessage).body ?? undefined,
      });
    }
    // stdin: "ignore" hands the child immediate EOF. A non-interactive CLI like
    // `codex exec` otherwise reads from the inherited terminal and can block.
    return spawnOwnedProcess([binary, ...args, fullMessage], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
  }

  /**
   * Spawn the binary with an explicit arg list (e.g. a JSON/streaming mode for
   * progress narration) instead of the configured `args`. Same env + stdin
   * handling as {@link spawnProc}.
   */
  protected spawnWithArgs(args: string[], message: string) {
    const env = this.buildEnv();
    return spawnOwnedProcess([this.config.binary, ...args, this.buildPrompt(message)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
  }

  async send(message: string, options: BrainTurnOptions = {}): Promise<string> {
    try {
      options.signal?.throwIfAborted();
      const proc = this.spawnProc(message);
      let cancellation: Promise<void> | null = null;
      const cancel = () => {
        cancellation ??= terminateTurn(proc);
        void cancellation.catch(() => {});
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      const ownedExit = awaitOwnedTurnExit(proc);
      void ownedExit.catch(() => { /* observed by the turn cleanup below */ });
      let pipeFailure = false;
      let pipeError: unknown;
      const readPipe = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
        try {
          return await new Response(stream).text();
        } catch (error: unknown) {
          if (!pipeFailure) {
            pipeFailure = true;
            pipeError = error;
          }
          // A failed pipe read proves nothing about the subprocess. Start and
          // await the same owned cleanup barrier used for explicit aborts.
          cancel();
          return "";
        }
      };
      let output: string;
      let stderr: string;
      let exitCode: number;
      try {
        [output, stderr, exitCode] = await Promise.all([
          readPipe(proc.stdout as ReadableStream<Uint8Array>),
          readPipe(proc.stderr as ReadableStream<Uint8Array>),
          ownedExit,
        ]);
        if (cancellation) await cancellation;
        if (pipeFailure && !options.signal?.aborted) throw pipeError;
      } finally {
        options.signal?.removeEventListener("abort", cancel);
      }
      options.signal?.throwIfAborted();
      if (exitCode !== 0) {
        throw new Error(this.exitError(exitCode, stderr, output));
      }
      this.onTurnComplete();
      this.rememberTurn(message, output);
      return output.trim();
    } catch (err) {
      log("error", `Brain (${this.config.name}) error: ${(err as Error).message}`);
      throw err;
    }
  }

  async *sendStream(message: string, options: BrainTurnOptions = {}): AsyncGenerator<string> {
    options.signal?.throwIfAborted();
    const proc = this.spawnProc(message);
    // Keep a bounded head of stdout so a non-zero exit can report the real cause
    // (CLIs like `claude` print "Invalid API key" to stdout, not stderr).
    let head = "";
    let remembered = "";
    let completed = false;
    let streamError: unknown;
    let cancellation: Promise<void> | null = null;
    const cancel = () => {
      cancellation ??= terminateTurn(proc);
      void cancellation.catch(() => {});
    };
    const stderrPromise = new Response(proc.stderr).text();
    const ownedExit = awaitOwnedTurnExit(proc);
    void ownedExit.catch(() => { /* observed by the turn cleanup below */ });
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    let exitCode = 0;
    let stderr = "";
    try {
      for await (const piece of iterateTextStream(proc.stdout as ReadableStream<Uint8Array>)) {
        if (options.signal?.aborted) break;
        if (head.length < 2000) head += piece;
        remembered = (remembered + piece).slice(-8_000);
        yield piece;
      }
      completed = true;
    } catch (err: unknown) {
      streamError = err;
    } finally {
      if (!completed || options.signal?.aborted) cancel();
      try {
        if (cancellation) await cancellation;
        [exitCode, stderr] = await Promise.all([ownedExit, stderrPromise]);
      } finally {
        options.signal?.removeEventListener("abort", cancel);
      }
    }
    options.signal?.throwIfAborted();
    if (streamError) throw streamError;
    if (exitCode !== 0) {
      throw new Error(this.exitError(exitCode, stderr, head));
    }
    this.onTurnComplete();
    this.rememberTurn(message, remembered);
  }

  /**
   * Build a useful failure message. CLI brains often write their real error
   * (auth failures, usage limits) to STDOUT and leave stderr empty, so fall back
   * to stdout when stderr is blank — otherwise the cause is silently lost and the
   * caller only ever sees a bare "exited with 1".
   */
  private exitError(exitCode: number, stderr: string, stdout: string): string {
    const detail = stderr.trim() || stdout.trim() || "(no output)";
    return `${this.config.name} exited with ${exitCode}: ${detail}`;
  }

  protected buildPrompt(message: string): string {
    return this.turnContext.buildTextPrompt(message, this.config.rememberTurns !== false);
  }

  protected rememberTurn(message: string, response: string): void {
    if (this.config.rememberTurns !== false) this.turnContext.remember(message, response);
  }

  injectContext(context: string): void {
    this.turnContext.inject(context);
  }

  async restart(): Promise<void> {
    this.turnContext.clear();
    await this.stop();
    await this.start();
  }

  async health(): Promise<boolean> {
    // Bun.which() resolves the binary on PATH cross-platform (Windows included).
    return Bun.which(this.config.binary) !== null || (await Bun.file(this.config.binary).exists());
  }
}
