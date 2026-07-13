import type { BrainTurnOptions } from "../types";
import {
  awaitOwnedTurnExit,
  awaitTurnExitAfterOutput,
  SubprocessCLIBrain,
  terminateTurn,
} from "./subprocess-cli";
import { iterateJsonLines } from "../agent/jsonl";
import { codexAgentMessages, codexThreadId, narrateCodexEvents } from "../agent/codex-narration";
import { log } from "../logger";
import { collectBoundedTextTail, type BoundedTextTail } from "../stream/bounded-text-tail";

const STDERR_TAIL_BYTES = 8_000;

/**
 * Codex CLI brain. `codex exec` runs a single prompt non-interactively.
 * Session metadata (version, model, sandbox) goes to stderr, so stdout is just
 * the model's answer. `--color never` keeps that answer free of ANSI codes (it
 * gets streamed to TTS), and `--skip-git-repo-check` lets Cicero answer from any
 * working directory, not only inside a git repo. The legacy `--quiet` flag was
 * removed in newer Codex; pass autonomy flags (e.g. `-s workspace-write`) via
 * `binary_args` when the agent should run commands.
 */
export class CodexBrain extends SubprocessCLIBrain {
  /** Args for the `--json` event stream used by progress narration. */
  private readonly jsonArgs: string[];
  /** Common flags shared by fresh-exec and resume invocations. */
  private readonly commonArgs: string[];
  /** When true, turns after the first continue the same codex session. */
  private readonly resumeSessions: boolean;
  /** Exact thread owned by this brain instance; never inferred from global recency. */
  private sessionId: string | null = null;
  /** Resume-enabled turns are serialized so one thread never receives overlapping prompts. */
  private turnTail: Promise<void> = Promise.resolve();

  constructor(binary = "codex", extraArgs: string[] = [], unsetEnv: string[] = [], opts: { resume?: boolean } = {}) {
    super({
      name: "Codex CLI",
      binary,
      args: ["exec", "--color", "never", "--skip-git-repo-check", ...extraArgs],
      unsetEnv,
      rememberTurns: !(opts.resume ?? false),
    });
    this.commonArgs = ["--color", "never", "--skip-git-repo-check", ...extraArgs];
    this.jsonArgs = ["exec", "--json", ...this.commonArgs];
    this.resumeSessions = opts.resume ?? false;
  }

  /**
   * Conversation continuity for lane use. The first JSON turn captures the
   * thread UUID emitted by Codex; later turns resume that exact UUID. A manual
   * Codex run or another Cicero lane can never steal this brain's conversation.
   */
  protected override argsForTurn(): string[] {
    if (this.resumeSessions && this.sessionId) {
      // exec-level flags must precede the resume subcommand — codex rejects
      // `exec resume --color …` with "unexpected argument".
      return ["exec", ...this.commonArgs, "resume", this.sessionId];
    }
    return this.config.args;
  }

  /** JSON form of the same fresh/resume invocation, used to capture identity. */
  protected jsonArgsForTurn(): string[] {
    if (this.resumeSessions && this.sessionId) {
      return ["exec", "--json", ...this.commonArgs, "resume", this.sessionId];
    }
    return this.jsonArgs;
  }

  override async send(message: string, options: BrainTurnOptions = {}): Promise<string> {
    if (!this.resumeSessions) return super.send(message, options);
    try {
      let out = "";
      for await (const chunk of this.sendStream(message, options)) out += chunk;
      return out.trim();
    } catch (error: unknown) {
      log("error", `Brain (Codex CLI) error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  override async *sendStream(message: string, options: BrainTurnOptions = {}): AsyncGenerator<string> {
    if (!this.resumeSessions) {
      yield* super.sendStream(message, options);
      return;
    }
    const release = await this.acquireTurn(options.signal);
    try {
      yield* this.streamJsonTurn(message, options, false);
    } finally {
      release();
    }
  }

  override async restart(): Promise<void> {
    if (!this.resumeSessions) return super.restart();
    const release = await this.acquireTurn();
    try {
      this.sessionId = null;
      await super.restart();
    } finally {
      release();
    }
  }

  /**
   * Stream the agent's work as speakable progress: codex's own messages, the
   * commands it runs, and the final answer — so Cicero narrates what it's doing.
   */
  async *streamProgress(message: string, options: BrainTurnOptions = {}): AsyncGenerator<string> {
    const release = this.resumeSessions ? await this.acquireTurn(options.signal) : null;
    try {
      yield* this.streamJsonTurn(message, options, true);
    } finally {
      release?.();
    }
  }

  private async *streamJsonTurn(
    message: string,
    options: BrainTurnOptions,
    narrateProgress: boolean,
  ): AsyncGenerator<string> {
    options.signal?.throwIfAborted();
    const proc = this.spawnWithArgs(this.jsonArgsForTurn(), message);
    const ownedExit = awaitOwnedTurnExit(proc);
    void ownedExit.catch(() => { /* observed by the owned cleanup barrier */ });
    let cancellation: Promise<void> | null = null;
    const cancel = () => {
      cancellation ??= terminateTurn(proc);
      void cancellation.catch(() => {});
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const stderrPromise = collectBoundedTextTail(proc.stderr as ReadableStream<Uint8Array>, {
      maxBytes: STDERR_TAIL_BYTES,
      context: "Codex CLI stderr",
    });
    void stderrPromise.catch(() => { /* observed again during owned cleanup */ });
    let completed = false;
    let streamError: unknown;
    let observedSession: string | null = null;
    let remembered = "";
    let stdoutHead = "";
    let exitCode = 0;
    let stderr: BoundedTextTail | null = null;
    try {
      const self = this;
      const events = (async function* (): AsyncGenerator<unknown> {
        for await (const event of iterateJsonLines(proc.stdout as ReadableStream<Uint8Array>)) {
          if (stdoutHead.length < 2_000) {
            stdoutHead += `${JSON.stringify(event)}\n`.slice(0, 2_000 - stdoutHead.length);
          }
          const id = codexThreadId(event);
          if (id) {
            if (self.sessionId && id !== self.sessionId) {
              throw new Error(`Codex resumed unexpected thread ${id}; expected ${self.sessionId}`);
            }
            observedSession = id;
          }
          yield event;
        }
      })();
      const chunks = narrateProgress ? narrateCodexEvents(events) : codexAgentMessages(events);
      for await (const chunk of chunks) {
        if (options.signal?.aborted) break;
        remembered = (remembered + chunk).slice(-8_000);
        yield chunk;
      }
      completed = true;
    } catch (error: unknown) {
      streamError = error;
    } finally {
      if (!completed || options.signal?.aborted) cancel();
      let cleanupError: unknown;
      try {
        if (cancellation) await cancellation;
        exitCode = completed && !options.signal?.aborted
          ? await awaitTurnExitAfterOutput(proc, ownedExit)
          : await ownedExit;
      } catch (error: unknown) {
        cleanupError = error;
      }
      try {
        stderr = await stderrPromise;
      } catch (error: unknown) {
        cleanupError ??= error;
      }
      // Keep cancellation armed through the exit/reap and stderr-drain barrier.
      // A CLI may close JSON stdout while its process is still alive.
      options.signal?.removeEventListener("abort", cancel);
      if (cleanupError) {
        const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        const abortDetail = options.signal?.aborted
          ? `${options.signal.reason instanceof Error ? options.signal.reason.message : String(options.signal.reason)}; `
          : "";
        throw new Error(`Codex progress ${abortDetail}cleanup failed: ${detail}`, { cause: cleanupError });
      }
    }
    options.signal?.throwIfAborted();
    if (streamError) throw streamError;
    if (exitCode !== 0) {
      const stderrDetail = stderr?.text.trim() ?? "";
      const detail = stderrDetail || stdoutHead.trim() || "(no output)";
      const truncation = stderr?.truncated && stderrDetail ? "\n[stderr truncated; tail retained]" : "";
      throw new Error(`Codex CLI exited with ${exitCode}: ${detail}${truncation}`);
    }
    if (this.resumeSessions) {
      if (!observedSession) {
        throw new Error("Codex completed without reporting its thread UUID; refusing unsafe resume");
      }
      this.sessionId = observedSession;
    }
    this.rememberTurn(message, remembered);
  }

  private async acquireTurn(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const previous = this.turnTail;
    let releaseGate!: () => void;
    let released = false;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const release = () => {
      if (released) return;
      released = true;
      releaseGate();
    };
    this.turnTail = previous.then(() => gate, () => gate);

    if (!signal) {
      await previous.catch(() => {});
      return release;
    }
    const abortError = () => signal.reason ?? new DOMException("Codex turn cancelled", "AbortError");
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<void>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([previous.catch(() => {}), aborted]);
      signal.throwIfAborted();
      return release;
    } catch (error: unknown) {
      release();
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
