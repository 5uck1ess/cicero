import type { RuntimeConfig } from "../config";
import type {
  TerminalAdapter,
  Brain,
  BrainTurnOptions,
  Speaker,
  RouterResult,
  ExecutionResult,
  ActionConfig,
} from "../types";
import type { LLMProvider, ChatMessage } from "../backends/llm/provider";
import { log } from "../logger";
import { ContextStore } from "../brain/context-store";
import { segmentSentences } from "../speaker/sentence-stream";
import { compileShellCommand, type CompiledShellCommand } from "./shell-template";
import { runBoundedCommand, type BoundedCommandResult } from "../process/bounded-command";
import { resolveActionCommandLimits } from "../action-command-limits";

const VOICE_SYSTEM_PROMPT =
  "/no_think\nYou are a helpful voice assistant. Keep answers under 2 sentences. Be concise and natural. Do not use markdown.";
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const LOCAL_STREAM_INTERRUPTED_MESSAGE = "The local model stopped before it finished.";
const MODEL_FALLBACK_FAILED_MESSAGE = "I couldn't get a response from either model.";
const LOCAL_LLM_DEADLINE_MS = 30_000;

async function* singleToken(text: string): AsyncGenerator<string> {
  if (text) yield text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const detail = signal.reason === undefined ? "" : `: ${String(signal.reason)}`;
  return new Error(`Local LLM request aborted${detail}`);
}

/**
 * Race one provider operation against an abort signal. This is deliberately a
 * hard race rather than relying only on providers to honor `signal`: a custom
 * provider adapter must not be able to wedge the voice loop by ignoring abort.
 */
function beforeAbort<T>(
  start: () => PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    try {
      return Promise.resolve(start());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError(signal));
    };
    const onResolve = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    try {
      void Promise.resolve(start()).then(onResolve, onReject);
    } catch (error) {
      onReject(error);
    }
  });
}

function closeIterator(iterator: AsyncIterator<string>): void {
  try {
    const closing = iterator.return?.(undefined);
    if (closing) void Promise.resolve(closing).catch(() => { /* best-effort provider cleanup */ });
  } catch {
    // A provider may have already finalized itself while its abort was racing.
  }
}

function linkDeadline(
  callerSignal?: AbortSignal,
): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Local LLM request timed out after ${LOCAL_LLM_DEADLINE_MS}ms`));
  }, LOCAL_LLM_DEADLINE_MS);
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  if (callerSignal?.aborted) abortFromCaller();

  return {
    controller,
    clear: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function partialMarkerLength(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1);
  for (let length = max; length > 0; length--) {
    if (value.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

/**
 * Incrementally removes model reasoning blocks while retaining marker prefixes
 * split across provider chunks. A trailing, incomplete opening marker is emitted
 * as text when the stream ends; an unclosed reasoning block is discarded.
 */
class ThinkBlockFilter {
  private pending = "";
  private insideThink = false;

  push(chunk: string): string {
    this.pending += chunk;
    return this.drain(false);
  }

  finish(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let output = "";

    while (this.pending) {
      const marker = this.insideThink ? THINK_CLOSE : THINK_OPEN;
      const markerIndex = this.pending.indexOf(marker);

      if (markerIndex !== -1) {
        if (!this.insideThink) output += this.pending.slice(0, markerIndex);
        this.pending = this.pending.slice(markerIndex + marker.length);
        this.insideThink = !this.insideThink;
        continue;
      }

      if (final) {
        if (!this.insideThink) output += this.pending;
        this.pending = "";
        break;
      }

      const retainedLength = partialMarkerLength(this.pending, marker);
      if (!this.insideThink) {
        output += this.pending.slice(0, this.pending.length - retainedLength);
      }
      this.pending = retainedLength === 0 ? "" : this.pending.slice(-retainedLength);
      break;
    }

    return output;
  }
}

function stripThinkBlocks(text: string): string {
  const filter = new ThinkBlockFilter();
  return filter.push(text) + filter.finish();
}

export class ActionExecutor {
  private config: RuntimeConfig;
  private terminal: TerminalAdapter;
  private brain: Brain;
  private speaker: Speaker;
  private contextStore: ContextStore;
  private llm: LLMProvider;

  constructor(config: RuntimeConfig, terminal: TerminalAdapter, brain: Brain, speaker: Speaker, contextStore: ContextStore, llm: LLMProvider) {
    this.config = config;
    this.terminal = terminal;
    this.brain = brain;
    this.speaker = speaker;
    this.contextStore = contextStore;
    this.llm = llm;
  }

  /**
   * Run trusted action syntax while keeping router/LLM parameters out of the
   * shell program. `sh -c` assigns arguments after the sentinel to $1, $2, ….
   */
  private startActionCommand(
    action: ActionConfig,
    params: Readonly<Record<string, string>>,
    inheritEnv = false,
    signal?: AbortSignal,
  ): { display: string; completion: Promise<BoundedCommandResult> } {
    const command = compileShellCommand(action.command, params);
    return {
      display: command.display,
      completion: this.executeActionCommand(command, action, inheritEnv, signal),
    };
  }

  private executeActionCommand(
    command: CompiledShellCommand,
    action: ActionConfig,
    inheritEnv: boolean,
    signal?: AbortSignal,
  ): Promise<BoundedCommandResult> {
    const limits = resolveActionCommandLimits(action);
    return runBoundedCommand(["sh", "-c", command.script, "cicero-action", ...command.args], {
      signal,
      timeoutMs: limits.timeoutMs,
      stdoutLimitBytes: limits.outputLimitBytes,
      stderrLimitBytes: limits.outputLimitBytes,
      totalLimitBytes: limits.outputLimitBytes * 2,
      outputLimitBehavior: "truncate",
      stdoutCapture: "head",
      stderrCapture: "head-tail",
      ...(inheritEnv ? { env: { ...process.env } } : {}),
    });
  }

  private actionOutput(result: BoundedCommandResult): string {
    const output = result.stdout.text.trim();
    return result.stdout.truncated ? `${output}\n[stdout truncated]`.trim() : output;
  }

  private actionError(result: BoundedCommandResult): string {
    const detail = result.stderr.text.trim();
    if (!detail) return `Exit code ${result.exitCode}`;
    const bounded = detail.length <= 1000
      ? detail
      : `${detail.slice(0, 700)}\n… diagnostic output truncated …\n${detail.slice(-250)}`;
    const suffix = result.stderr.truncated ? "\n[stderr truncated; head and tail retained]" : "";
    return `Exit code ${result.exitCode}: ${bounded}${suffix}`;
  }

  async execute(
    route: RouterResult,
    originalText: string,
    options: BrainTurnOptions = {},
  ): Promise<ExecutionResult> {
    const signal = options.signal;
    const start = Date.now();

    try {
      // Handle special intents that need custom logic (not just shell commands)
      switch (route.intent) {
        case "text_inject":
          return await this.executeTextInject(route, originalText, options);
        case "runtime_mute":
          return { success: true, output: "TTS disabled.", duration_ms: Date.now() - start };
        case "runtime_unmute":
          return { success: true, output: "TTS enabled.", duration_ms: Date.now() - start };
        case "runtime_restart_brain":
          return { success: true, output: "Restarting brain...", duration_ms: Date.now() - start };
        case "runtime_voice_toggle":
          return { success: true, output: "", duration_ms: Date.now() - start };
      }

      // Category-based dispatch for registered actions
      switch (route.category) {
        case "terminal":
          return await this.executeTerminal(route, signal);
        case "cli":
          return await this.executeCLI(route, signal);
        case "local":
          return await this.executeLocal(route, originalText, signal);
        case "local-llm":
          return await this.executeLocalLLM(route, originalText, options);
        case "brain":
          return await this.executeBrain(route, originalText, options);
        default:
          return await this.executeBrain(route, originalText, options);
      }
    } catch (err) {
      return {
        success: false,
        output: "",
        error: (err as Error).message,
        duration_ms: Date.now() - start,
      };
    }
  }

  private async executeTerminal(route: RouterResult, signal?: AbortSignal): Promise<ExecutionResult> {
    const start = Date.now();
    const action = this.config.actions[route.intent];

    if (route.intent === "tab_switch" || route.intent === "tab_list") {
      if (route.intent === "tab_switch" && route.params.tab) {
        // Reject vague tab names like "another", "a different", etc.
        const tabName = route.params.tab.replace(/[.,!?]+$/, "").trim();
        if (/^(a\s+different|another|something|some\s+other|different|other|new|that|this|next|previous|last|first|a\s+new|any|some|one|it)$/i.test(tabName)) {
          return {
            success: false,
            output: "Which tab? Say the tab name, like 'switch to sales'.",
            duration_ms: Date.now() - start,
          };
        }
        log("run", `Focusing tab: ${tabName}`);
        await this.terminal.focusTab(tabName);
        return {
          success: true,
          output: `Switched to ${route.params.tab} tab`,
          duration_ms: Date.now() - start,
        };
      }

      if (route.intent === "tab_list") {
        log("run", "Listing tabs...");
        const tabs = await this.terminal.listTabs();
        const tabList = tabs.map(t => `${t.title}${t.is_focused ? " (active)" : ""}`).join(", ");
        const output = `Open tabs: ${tabList}`;
        log("result", output);
        return {
          success: true,
          output,
          duration_ms: Date.now() - start,
        };
      }
    }

    // Generic terminal command
    if (action?.command) {
      const command = this.startActionCommand(action, route.params, false, signal);
      log("run", `Running action: ${command.display}`);
      const result = await command.completion;
      return {
        success: result.exitCode === 0,
        output: this.actionOutput(result),
        error: result.exitCode === 0 ? undefined : this.actionError(result),
        duration_ms: Date.now() - start,
      };
    }

    return { success: false, output: "", error: "Unknown terminal action", duration_ms: Date.now() - start };
  }

  private async executeCLI(route: RouterResult, signal?: AbortSignal): Promise<ExecutionResult> {
    const start = Date.now();
    const action = this.config.actions[route.intent];

    if (!action) {
      return { success: false, output: "", error: `Unknown action: ${route.intent}`, duration_ms: 0 };
    }

    const command = this.startActionCommand(action, route.params, true, signal);
    log("run", `Running action: ${command.display}`);
    const completed = await command.completion;
    const result = this.actionOutput(completed);
    log("result", result.substring(0, 200) + (result.length > 200 ? "..." : ""));

    // Inject into brain context
    this.brain.injectContext(`[Command] ${command.display}\n[Output] ${result}`);

    return {
      success: completed.exitCode === 0,
      output: result,
      error: completed.exitCode !== 0 ? this.actionError(completed) : undefined,
      duration_ms: Date.now() - start,
    };
  }

  private async executeLocal(route: RouterResult, originalText: string, signal?: AbortSignal): Promise<ExecutionResult> {
    const start = Date.now();
    const action = this.config.actions[route.intent];

    // No-command actions — canned responses
    if (!action?.command) {
      if (route.intent === "help") {
        const output = "I'm Cicero, your voice assistant. I can check the time, date, battery, and disk space. I can switch your terminal tabs, run shell commands, and answer simple questions. For complex tasks, I send them to Claude Code.";
        return { success: true, output, duration_ms: Date.now() - start };
      }
      // Greeting
      const greetings = [
        "Hey! What can I do for you?",
        "Hello! Ready when you are.",
        "Hey there. What do you need?",
      ];
      const output = greetings[Math.floor(Math.random() * greetings.length)];
      return { success: true, output, duration_ms: Date.now() - start };
    }

    // Run local shell command
    const command = this.startActionCommand(action, route.params, false, signal);
    log("run", `Local action: ${command.display}`);
    const completed = await command.completion;
    const rawOutput = this.actionOutput(completed);

    if (completed.exitCode !== 0) {
      return {
        success: false,
        output: rawOutput,
        error: this.actionError(completed),
        duration_ms: Date.now() - start,
      };
    }

    // Humanize output for TTS — raw numbers/symbols confuse the model
    const output = this.humanizeLocalOutput(route.intent, rawOutput);

    return {
      success: true,
      output,
      duration_ms: Date.now() - start,
    };
  }

  private humanizeLocalOutput(intent: string, raw: string): string {
    switch (intent) {
      case "time_check":
        return `It's ${raw}.`;
      case "date_check":
        return `Today is ${raw}.`;
      case "battery":
        return `Battery is at ${raw.replace("%", " percent")}.`;
      case "disk_space":
        return `You have ${raw}.`;
      case "uptime":
        return `System has been ${raw.toLowerCase()}.`;
      default:
        return raw;
    }
  }

  // Build the voice chat prompt: system instruction + recent turns + this query.
  private buildLocalLLMMessages(query: string): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: "system", content: VOICE_SYSTEM_PROMPT }];
    for (const turn of this.contextStore.getRecentTurns(5)) {
      messages.push({ role: "user", content: turn.text });
      if (turn.output) {
        messages.push({ role: "assistant", content: turn.output.substring(0, 200) });
      }
    }
    messages.push({ role: "user", content: query });
    return messages;
  }

  private async executeLocalLLM(
    route: RouterResult,
    originalText: string,
    options: BrainTurnOptions,
  ): Promise<ExecutionResult> {
    const start = Date.now();
    // Use the full utterance, not the router's extracted params.query — the router
    // can truncate it ("Can you hear me?" → "hear me"), which the model then parrots.
    const query = originalText || route.params.query || "";

    log("run", `Local LLM: "${query}"`);

    try {
      // Route through the configured provider — honors host/port/protocol/auth and
      // the backend's extra (e.g. chat_template_kwargs), so remote/cloud brains work.
      const raw = await this.llm.chatCompletion(this.buildLocalLLMMessages(query), {
        temperature: 0.7,
        max_tokens: this.config.ttsLocalMaxTokens,
        signal: options.signal,
      });
      const output = (raw || "(no response)").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      log("result", output);

      return { success: true, output, duration_ms: Date.now() - start };
    } catch (err) {
      if (options.signal?.aborted) throw err;
      log("warn", `Local LLM failed, falling back to brain: ${(err as Error).message}`);
      return this.executeBrain(route, originalText, options);
    }
  }

  /**
   * Streaming version of executeLocalLLM — yields complete sentences as they arrive.
   * Used in conversational mode for low-latency TTS pipeline. Routes through the
   * configured LLMProvider; falls back to a single non-streamed completion when the
   * provider has no streaming support.
   */
  async *executeLocalLLMStreaming(
    route: RouterResult,
    originalText: string,
    callerSignal?: AbortSignal,
  ): AsyncGenerator<string> {
    if (callerSignal?.aborted) return;

    // Use the full utterance, not the router's extracted params.query — the router
    // can truncate it ("Can you hear me?" → "hear me"), which the model then parrots.
    const query = originalText || route.params.query || "";
    log("run", `Local LLM (streaming): "${query}"`);

    const messages = this.buildLocalLLMMessages(query);
    const opts = { temperature: 0.7, max_tokens: this.config.ttsLocalMaxTokens };

    if (!this.llm.chatCompletionStream) {
      // No streaming support → one completion, strip <think>, split into sentences.
      const deadline = linkDeadline(callerSignal);
      let yieldedAnswer = false;
      let batchFailed = false;
      let batchFailure: unknown;
      try {
        const raw = await beforeAbort(
          () => this.llm.chatCompletion(messages, { ...opts, signal: deadline.controller.signal }),
          deadline.controller.signal,
        );
        if (callerSignal?.aborted) return;
        // The provider has completed successfully; downstream sentence/TTS
        // pacing is not part of the provider deadline.
        deadline.clear();

        const cleaned = stripThinkBlocks(raw).trim();
        for await (const sentence of segmentSentences(singleToken(cleaned))) {
          if (callerSignal?.aborted) return;
          yieldedAnswer = true;
          yield sentence;
        }

        if (!yieldedAnswer) {
          log("warn", "Local LLM returned no speakable answer; falling back to brain");
        }
      } catch (err) {
        if (callerSignal?.aborted) return;
        batchFailed = true;
        batchFailure = err;
      } finally {
        deadline.clear();
      }

      if (callerSignal?.aborted) return;
      if (batchFailed) {
        log("warn", `Local LLM batch failed, falling back to brain: ${errorMessage(batchFailure)}`);
        yield* this.streamBrainFallback(query, { signal: callerSignal });
      } else if (!yieldedAnswer) {
        yield* this.streamBrainFallback(query, { signal: callerSignal });
      }
      return;
    }

    // Absolute deadline guard: the iterator.next() race below enforces this even
    // when a third-party provider ignores AbortSignal entirely.
    const deadline = linkDeadline(callerSignal);

    let yieldedAnswer = false;
    let streamFailed = false;
    let streamFailure: unknown;
    try {
      const filter = new ThinkBlockFilter();
      const chatCompletionStream = this.llm.chatCompletionStream.bind(this.llm);
      const cleanTokens = async function* (): AsyncGenerator<string> {
        const source = chatCompletionStream(messages, {
          ...opts,
          signal: deadline.controller.signal,
        })[Symbol.asyncIterator]();
        let sourceCompleted = false;
        try {
          while (true) {
            const next = await beforeAbort(() => source.next(), deadline.controller.signal);
            if (next.done) {
              if (deadline.controller.signal.aborted) throw abortError(deadline.controller.signal);
              sourceCompleted = true;
              // Once the provider has ended naturally, its trailing text may be
              // flushed safely; downstream TTS pacing must not turn that success
              // into a later timeout.
              deadline.clear();
              break;
            }
            if (deadline.controller.signal.aborted) throw abortError(deadline.controller.signal);
            const clean = filter.push(next.value);
            if (clean) yield clean;
          }
          if (deadline.controller.signal.aborted) throw abortError(deadline.controller.signal);
          const remaining = filter.finish();
          if (remaining) yield remaining;
        } catch (err) {
          if (deadline.controller.signal.aborted) throw abortError(deadline.controller.signal);
          throw new Error(`Local LLM token stream failed: ${errorMessage(err)}`, { cause: err });
        } finally {
          if (!sourceCompleted) closeIterator(source);
        }
      }();

      for await (const sentence of segmentSentences(cleanTokens)) {
        if (callerSignal?.aborted) return;
        if (deadline.controller.signal.aborted) throw abortError(deadline.controller.signal);
        yieldedAnswer = true;
        yield sentence;
      }

      if (callerSignal?.aborted) return;
    } catch (err) {
      if (callerSignal?.aborted) return;
      streamFailed = true;
      streamFailure = err;
    } finally {
      deadline.clear();
    }

    if (callerSignal?.aborted) return;
    if (streamFailed && !yieldedAnswer) {
      log("warn", `Local LLM stream failed before output, falling back to brain: ${errorMessage(streamFailure)}`);
      yield* this.streamBrainFallback(query, { signal: callerSignal });
    } else if (streamFailed) {
      log("warn", `Local LLM stream stopped after partial output: ${errorMessage(streamFailure)}`);
      yield LOCAL_STREAM_INTERRUPTED_MESSAGE;
    } else if (!yieldedAnswer) {
      log("warn", "Local LLM stream returned no speakable answer; falling back to brain");
      yield* this.streamBrainFallback(query, { signal: callerSignal });
    }
  }

  private async *streamBrainFallback(
    query: string,
    options: BrainTurnOptions,
  ): AsyncGenerator<string> {
    if (options.signal?.aborted) return;

    let yieldedAnswer = false;
    try {
      if (this.brain.sendStream) {
        for await (const sentence of segmentSentences(this.brain.sendStream(query, options))) {
          if (options.signal?.aborted) return;
          yieldedAnswer = true;
          yield sentence;
        }
      } else {
        const response = await this.brain.send(query, options);
        if (options.signal?.aborted) return;
        for await (const sentence of segmentSentences(singleToken(response))) {
          yieldedAnswer = true;
          yield sentence;
        }
      }

      if (!yieldedAnswer && !options.signal?.aborted) {
        log("warn", "Brain fallback returned no speakable answer");
        yield MODEL_FALLBACK_FAILED_MESSAGE;
      }
    } catch (err) {
      if (options.signal?.aborted) return;
      log("warn", `Brain fallback failed: ${errorMessage(err)}`);
      yield MODEL_FALLBACK_FAILED_MESSAGE;
    }
  }

  private async executeTextInject(
    route: RouterResult,
    originalText: string,
    options: BrainTurnOptions,
  ): Promise<ExecutionResult> {
    const start = Date.now();
    const payload = route.params.payload || route.params.query || originalText;

    if (!payload || payload.length < 2) {
      return {
        success: false,
        output: "What should I type? Say something like 'type ls' or 'tell Claude to fix the bug'.",
        duration_ms: Date.now() - start,
      };
    }

    // Reject vague/pronoun payloads
    if (/^(it|that|this|something|stuff|things?)$/i.test(payload)) {
      return {
        success: false,
        output: "What should I type? Be specific.",
        duration_ms: Date.now() - start,
      };
    }

    log("run", `Injecting into brain: "${payload}"`);
    const output = await this.brain.send(payload, options);
    return {
      success: true,
      output,
      duration_ms: Date.now() - start,
    };
  }

  private async executeBrain(
    route: RouterResult,
    originalText: string,
    options: BrainTurnOptions,
  ): Promise<ExecutionResult> {
    const start = Date.now();
    const action = this.config.actions[route.intent];

    let message: string;
    if (action?.command && action.category === "brain") {
      // It's a slash command - send it directly
      message = action.command;
      log("run", `Brain: ${message}`);
    } else {
      // Complex query — always use originalText to avoid sending raw router output
      message = originalText;
      log("run", `Brain: "${message}"`);
    }

    const output = await this.brain.send(message, options);
    log("result", output.substring(0, 200) + (output.length > 200 ? "..." : ""));

    return {
      success: true,
      output,
      duration_ms: Date.now() - start,
    };
  }
}
