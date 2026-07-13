import type { LLMProvider, LLMProviderConfig, ChatMessage, LLMCompletionOpts } from "./provider";
import { startManagedServer, stopManagedServer, type ManagedProcess } from "../managed-server";
import { httpBase, isLocalHost } from "../net";
import { streamSSEContent } from "./sse";
import { join, dirname } from "path";
import { resolveVenvPython } from "../../platform/python";
import {
  PROVIDER_TIMEOUT_MS,
  providerSignal,
  readBoundedJson,
  readErrorDetail,
  requestTimeout,
  responseIsOk,
} from "../http-transfer";

export class MlxLmProvider implements LLMProvider {
  readonly name = "mlx-lm";
  private host?: string;
  private port: number;
  private model: string;
  // Extra request params merged into every completion body — e.g. mlx_lm.server's
  // `chat_template_kwargs: { enable_thinking: false }` to suppress Qwen3 thinking.
  private extra?: Record<string, unknown>;
  private readonly timeoutMs: number;
  private managed: ManagedProcess | null = null;

  constructor(config: LLMProviderConfig) {
    this.host = config.host;
    this.port = config.port ?? 8081;
    this.model = config.model ?? "mlx-community/Qwen3.5-0.8B-MLX-4bit";
    this.extra = config.extra;
    this.timeoutMs = requestTimeout(config.timeout_ms, PROVIDER_TIMEOUT_MS.llm);
  }

  async chatCompletion(messages: ChatMessage[], opts?: LLMCompletionOpts): Promise<string> {
    const body: Record<string, unknown> = {
      ...(this.extra ?? {}),
      model: this.model,
      messages,
      temperature: opts?.temperature ?? 0.0,
      max_tokens: opts?.max_tokens ?? 100,
    };
    if (opts?.responseFormat) body.response_format = opts.responseFormat;

    const response = await fetch(`${httpBase(this.host, this.port)}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: providerSignal(this.timeoutMs, opts?.signal),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`MLX LLM server returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    const data = await readBoundedJson<{ choices?: Array<{ message?: { content?: string } }> }>(response);
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content) {
      const { log } = await import("../../logger");
      log("warn", `MLX LLM returned empty content — response may be malformed`);
    }
    return content;
  }

  async *chatCompletionStream(messages: ChatMessage[], opts?: LLMCompletionOpts): AsyncGenerator<string> {
    const body: Record<string, unknown> = {
      ...(this.extra ?? {}),
      model: this.model,
      messages,
      temperature: opts?.temperature ?? 0.0,
      max_tokens: opts?.max_tokens ?? 100,
      stream: true,
    };

    const response = await fetch(`${httpBase(this.host, this.port)}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: providerSignal(this.timeoutMs, opts?.signal),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`MLX LLM server returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    if (!response.body) throw new Error("MLX LLM server returned no response body for streaming");

    yield* streamSSEContent(response.body);
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${httpBase(this.host, this.port)}/v1/models`, {
        signal: providerSignal(PROVIDER_TIMEOUT_MS.health),
      });
      return await responseIsOk(res);
    } catch (err: unknown) {
      const { log } = await import("../../logger");
      log("info", `mlx-lm health check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async start(): Promise<void> {
    if (!isLocalHost(this.host)) {
      const { log } = await import("../../logger");
      log("info", `mlx-lm: using remote server at ${httpBase(this.host, this.port)}`);
      return;
    }
    const projectRoot = join(dirname(dirname(dirname(import.meta.dir))));
    const python = resolveVenvPython(join(projectRoot, ".venv"));

    this.managed = await startManagedServer({
      name: "mlx-lm",
      port: this.port,
      command: [python, "-m", "mlx_lm.server", "--model", this.model, "--port", this.port.toString()],
      healthUrl: `${httpBase(this.host, this.port)}/v1/models`,
      timeoutMs: 60000,
    });
  }

  async stop(): Promise<void> {
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
