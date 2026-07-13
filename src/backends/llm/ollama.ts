import { LLM_DEFAULT_MODEL, normalizedLlmModel } from "./provider";
import type { LLMProvider, LLMProviderConfig, ChatMessage, LLMCompletionOpts } from "./provider";
import { startManagedServer, stopManagedServer, type ManagedProcess } from "../managed-server";
import { httpBase, isLocalHost } from "../net";
import {
  PROVIDER_TIMEOUT_MS,
  providerSignal,
  readBoundedJson,
  readErrorDetail,
  requestTimeout,
  responseIsOk,
} from "../http-transfer";

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  private host?: string;
  private port: number;
  private model: string;
  private readonly timeoutMs: number;
  private managed: ManagedProcess | null = null;

  constructor(config: LLMProviderConfig) {
    this.host = config.host;
    this.port = config.port ?? 11434;
    // Doctor applies the same normalization before checking /api/tags. Keep
    // launch/request identity exact so diagnostics cannot verify another model.
    this.model = normalizedLlmModel(config.model, LLM_DEFAULT_MODEL.ollama);
    this.timeoutMs = requestTimeout(config.timeout_ms, PROVIDER_TIMEOUT_MS.llm);
  }

  async chatCompletion(messages: ChatMessage[], opts?: LLMCompletionOpts): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      // Pin the model in memory. Ollama's 5-minute default unloads it between
      // turns, so the first turn after any conversational pause eats a multi-
      // second reload from disk — the main reason ollama "feels slow" in a voice
      // loop. -1 keeps it resident for the life of the daemon.
      keep_alive: -1,
      options: {
        temperature: opts?.temperature ?? 0.0,
        num_predict: opts?.max_tokens ?? 100,
      },
    };

    if (opts?.responseFormat?.json_schema) {
      body.format = opts.responseFormat.json_schema;
    } else if (opts?.responseFormat) {
      body.format = "json";
    }

    const response = await fetch(`${httpBase(this.host, this.port)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: providerSignal(this.timeoutMs, opts?.signal),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`Ollama returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    const data = await readBoundedJson<{ message?: { content?: string } }>(response);
    const content = data.message?.content ?? "";
    if (!content) {
      const { log } = await import("../../logger");
      log("warn", `Ollama returned empty content — model may not be loaded`);
    }
    return content;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${httpBase(this.host, this.port)}/api/tags`, {
        signal: providerSignal(PROVIDER_TIMEOUT_MS.health),
      });
      return await responseIsOk(res);
    } catch (err: unknown) {
      const { log } = await import("../../logger");
      log("info", `ollama health check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async start(): Promise<void> {
    if (!isLocalHost(this.host)) {
      const { log } = await import("../../logger");
      log("info", `ollama: using remote server at ${httpBase(this.host, this.port)}`);
      return;
    }
    this.managed = await startManagedServer({
      name: "ollama",
      port: this.port,
      command: ["ollama", "serve"],
      healthUrl: `${httpBase(this.host, this.port)}/api/tags`,
      timeoutMs: 30000,
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
