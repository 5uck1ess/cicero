import type { BrainTurnOptions } from "../types";
import {
  awaitOwnedTurnExit,
  awaitTurnExitAfterOutput,
  SubprocessCLIBrain,
  terminateTurn,
} from "./subprocess-cli";
import { iterateJsonLines } from "../agent/jsonl";
import { narrateClaudeEvents } from "../agent/claude-narration";
import { collectBoundedTextTail, type BoundedTextTail } from "../stream/bounded-text-tail";

const REMEMBERED_PROGRESS_CHARS = 8_000;
const STDERR_TAIL_BYTES = 8_000;

/**
 * Claude Code brain — `claude --print <prompt>` per turn. Inherits batch +
 * streaming behaviour from SubprocessCLIBrain.
 *
 * Note: `claude` prefers `ANTHROPIC_API_KEY` from the env over the logged-in
 * (OAuth/subscription) session — an invalid key there makes it exit 1 with
 * "Invalid API key". Pass `unset_env: ["ANTHROPIC_API_KEY"]` (config) to force
 * the OAuth login. Autonomy flags (e.g. `--dangerously-skip-permissions`) go via
 * `binary_args` when the agent should run tools.
 */
export class ClaudeCodeBrain extends SubprocessCLIBrain {
  /** Args for the `stream-json` event stream used by progress narration. */
  private readonly streamJsonArgs: string[];

  constructor(binary = "claude", extraArgs: string[] = [], unsetEnv: string[] = []) {
    super({
      name: "Claude Code",
      binary,
      args: ["--print", ...extraArgs],
      unsetEnv,
    });
    this.streamJsonArgs = ["--print", "--output-format", "stream-json", "--verbose", ...extraArgs];
  }

  /**
   * Stream the agent's work as speakable progress: its messages, the tools it
   * runs ("Running ls.", "Editing auth.ts."), and the final answer — so Cicero
   * narrates what it's doing. Tools only run when allowed (see `binary_args`).
   */
  async *streamProgress(message: string, options: BrainTurnOptions = {}): AsyncGenerator<string> {
    options.signal?.throwIfAborted();
    const proc = this.spawnWithArgs(this.streamJsonArgs, message, options.systemContext);
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
      context: "Claude Code stderr",
    });
    void stderrPromise.catch(() => { /* observed again during owned cleanup */ });
    let completed = false;
    let streamError: unknown;
    let exitCode = 0;
    let stderr: BoundedTextTail | null = null;
    let remembered = "";
    try {
      for await (const chunk of narrateClaudeEvents(iterateJsonLines(proc.stdout as ReadableStream<Uint8Array>))) {
        if (options.signal?.aborted) break;
        remembered = (remembered + chunk).slice(-REMEMBERED_PROGRESS_CHARS);
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
      // Stdout can close before the process exits; removing this listener at
      // EOF leaves a window where an abort cannot interrupt that live child.
      options.signal?.removeEventListener("abort", cancel);
      if (cleanupError) {
        const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        const abortDetail = options.signal?.aborted
          ? `${options.signal.reason instanceof Error ? options.signal.reason.message : String(options.signal.reason)}; `
          : "";
        throw new Error(`Claude Code progress ${abortDetail}cleanup failed: ${detail}`, { cause: cleanupError });
      }
    }

    options.signal?.throwIfAborted();
    if (streamError) {
      const detail = streamError instanceof Error ? streamError.message : String(streamError);
      throw new Error(`Claude Code progress stream failed: ${detail}`, { cause: streamError });
    }
    if (exitCode !== 0) {
      const stderrDetail = stderr?.text.trim() ?? "";
      const detail = stderrDetail || remembered.trim() || "(no output)";
      const truncation = stderr?.truncated && stderrDetail
        ? "\n[stderr truncated; tail retained]"
        : "";
      throw new Error(`Claude Code progress stream failed: Claude Code exited with ${exitCode}: ${detail}${truncation}`);
    }
    this.onTurnComplete();
    this.rememberTurn(message, remembered);
  }
}
