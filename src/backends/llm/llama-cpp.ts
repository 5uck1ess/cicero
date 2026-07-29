import { LLM_DEFAULT_MODEL, normalizedLlmModel } from "./provider";
import type { LLMProvider, LLMProviderConfig, ChatMessage, LLMCompletionOpts } from "./provider";
import { startManagedServer, stopManagedServer, type ManagedProcess } from "../managed-server";
import { httpBase, isLocalHost } from "../net";
import { streamSSEContent } from "./sse";
import {
  PROVIDER_TIMEOUT_MS,
  providerSignal,
  readBoundedJson,
  readErrorDetail,
  requestTimeout,
  responseIsOk,
} from "../http-transfer";

// llama.cpp's `llama-server` exposes an OpenAI-compatible /v1/chat/completions
// endpoint (same shape as mlx-lm) plus GBNF/json_schema constrained decoding.
export class LlamaCppProvider implements LLMProvider {
  readonly name = "llama-cpp";
  private host?: string;
  private port: number;
  private model: string;
  private readonly timeoutMs: number;
  /** Fresh cancellation scope for one startup; replaces any settled predecessor. */
  private beginStartup(): AbortSignal {
    const abort = new AbortController();
    this.startAbort = abort;
    return abort.signal;
  }

  /**
   * Latch synchronously, BEFORE any await, so a launch in flight sees it and
   * reaps the child it already spawned. Public because an owner holding a
   * candidate (see ProviderSlot) must be able to cancel a minutes-long startup
   * without waiting it out first. Safe to call at any time, including twice.
   */
  cancelStartup(): void {
    this.startAbort?.abort(new Error("llama-cpp" + " is stopping"));
    this.startAbort = null;
  }

  private managed: ManagedProcess | null = null;
  /** Cancels a startup still in flight, so stop() can reach a child that
   *  start() has not published yet. Set synchronously by stop(). */
  private startAbort: AbortController | null = null;

  constructor(config: LLMProviderConfig) {
    this.host = config.host;
    this.port = config.port ?? 8080; // llama-server default port
    // llama-server serves whatever GGUF it loaded; the request model field is
    // informational. A concrete value is used as the -m path when auto-launching.
    // Doctor applies the same normalization before checking local launch
    // prerequisites. Whitespace must not select a different -m/-hf argument.
    this.model = normalizedLlmModel(config.model, LLM_DEFAULT_MODEL["llama-cpp"]);
    this.timeoutMs = requestTimeout(config.timeout_ms, PROVIDER_TIMEOUT_MS.llm);
  }

  async chatCompletion(messages: ChatMessage[], opts?: LLMCompletionOpts): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: opts?.temperature ?? 0.0,
      max_tokens: opts?.max_tokens ?? 100,
      // Reuse the server's KV cache across turns — the persona/system prefix
      // is identical every turn (explicit for older llama-server builds).
      cache_prompt: true,
    };

    if (opts?.responseFormat) {
      body.response_format = opts.responseFormat;
    }

    const response = await fetch(`${httpBase(this.host, this.port)}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: providerSignal(this.timeoutMs, opts?.signal),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`llama.cpp server returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    const data = await readBoundedJson<{ choices?: Array<{ message?: { content?: string } }> }>(response);
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content) {
      const { log } = await import("../../logger");
      log("warn", `llama.cpp returned empty content — response may be malformed`);
    }
    return content;
  }

  /**
   * Stream tokens as they're generated. This is the dominant latency lever for
   * back-and-forth voice: the speaker can start on the first sentence instead of
   * waiting for the whole reply. llama-server speaks OpenAI-style SSE, same as
   * mlx-lm/openai, so it shares the streamSSEContent parser.
   */
  async *chatCompletionStream(messages: ChatMessage[], opts?: LLMCompletionOpts): AsyncGenerator<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: opts?.temperature ?? 0.0,
      max_tokens: opts?.max_tokens ?? 100,
      stream: true,
      cache_prompt: true, // llama.cpp KV reuse (see chatCompletion)
    };

    if (opts?.responseFormat) {
      body.response_format = opts.responseFormat;
    }

    const response = await fetch(`${httpBase(this.host, this.port)}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: providerSignal(this.timeoutMs, opts?.signal),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`llama.cpp server returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    if (!response.body) throw new Error("llama.cpp server returned no response body for streaming");

    yield* streamSSEContent(response.body);
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${httpBase(this.host, this.port)}/health`, {
        signal: providerSignal(PROVIDER_TIMEOUT_MS.health),
      });
      return await responseIsOk(res);
    } catch (err: unknown) {
      const { log } = await import("../../logger");
      log("info", `llama-cpp health check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async start(): Promise<void> {
    if (!isLocalHost(this.host)) {
      const { log } = await import("../../logger");
      log("info", `llama-cpp: using remote server at ${httpBase(this.host, this.port)}`);
      return;
    }
    // Connects to an already-running llama-server if healthy; otherwise launches
    // one. A local GGUF path (ends in .gguf) loads via -m; anything else is
    // treated as an HF repo id (owner/repo[:quant]) and auto-downloaded + cached
    // via -hf — ollama-style "just name it" UX, but the model stays resident so
    // there are no per-turn reload stalls.
    const command = ["llama-server", "--host", "127.0.0.1", "--port", this.port.toString()];
    if (this.model && this.model !== LLM_DEFAULT_MODEL["llama-cpp"]) {
      const isLocalGguf = this.model.toLowerCase().endsWith(".gguf");
      command.push(isLocalGguf ? "-m" : "-hf", this.model);
    }
    this.managed = await startManagedServer({
      signal: this.beginStartup(),
      name: "llama-cpp",
      port: this.port,
      command,
      healthUrl: `${httpBase(this.host, this.port)}/health`,
      timeoutMs: 60000,
    });
  }

  async stop(): Promise<void> {
    // Synchronous, before any await: a startup still in flight must see this.
    this.cancelStartup();
    if (this.managed) {
      const managed = this.managed;
      try {
        await stopManagedServer(managed);
      } finally {
        if (this.managed === managed) this.managed = null;
      }
    }
  }
}
