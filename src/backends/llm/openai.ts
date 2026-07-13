import type { LLMProvider, LLMProviderConfig, ChatMessage, LLMCompletionOpts } from "./provider";
import { isKeylessHost } from "../net";
import { streamSSEContent } from "./sse";
import {
  PROVIDER_TIMEOUT_MS,
  providerSignal,
  readBoundedJson,
  readErrorDetail,
  requestTimeout,
  responseIsOk,
} from "../http-transfer";

export interface OpenAiTarget {
  baseUrl: string;
  apiKeyEnv: string;
}

// Named presets for OpenAI-compatible APIs — Western and Chinese alike. Every one
// of these speaks POST {baseUrl}/chat/completions with a Bearer key, so a single
// client covers them all. Anything not listed works via `backend: "openai-compatible"`
// plus an explicit `baseUrl`.
const PRESETS: Record<string, OpenAiTarget> = {
  openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
  "openai-compatible": { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" },
  together: { baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY" },
  // Chinese providers (all OpenAI-compatible):
  deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" },
  moonshot: { baseUrl: "https://api.moonshot.cn/v1", apiKeyEnv: "MOONSHOT_API_KEY" },
  kimi: { baseUrl: "https://api.moonshot.cn/v1", apiKeyEnv: "MOONSHOT_API_KEY" },
  dashscope: { baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", apiKeyEnv: "DASHSCOPE_API_KEY" },
  "qwen-api": { baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", apiKeyEnv: "DASHSCOPE_API_KEY" },
  zhipu: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKeyEnv: "ZHIPUAI_API_KEY" },
  glm: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKeyEnv: "ZHIPUAI_API_KEY" },
  minimax: { baseUrl: "https://api.minimax.chat/v1", apiKeyEnv: "MINIMAX_API_KEY" },
};

/** Resolve a preset or explicit OpenAI-compatible target without reading credentials. */
export function resolveOpenAiTarget(config: LLMProviderConfig): OpenAiTarget {
  const backend = config.backend ?? "openai";
  const preset = PRESETS[backend] ?? PRESETS.openai!;
  return {
    baseUrl: (config.baseUrl ?? preset.baseUrl).replace(/\/+$/, ""),
    apiKeyEnv: config.apiKeyEnv ?? preset.apiKeyEnv,
  };
}

/** A credential-safe endpoint label for logs and diagnostics. */
export function openAiBaseUrlForDisplay(baseUrl: string): string {
  try {
    const display = new URL(baseUrl);
    if (display.protocol !== "http:" && display.protocol !== "https:") {
      return "<unsupported configured URL>";
    }
    display.username = "";
    display.password = "";
    display.search = "";
    display.hash = "";
    return display.toString().replace(/\/$/, "");
  } catch {
    return "<invalid configured URL>";
  }
}

/** Backend names routed to {@link OpenAiProvider} (used by the registry). */
export const OPENAI_COMPATIBLE_BACKENDS = Object.keys(PRESETS);

/**
 * OpenAI-compatible chat-completions provider — the cloud/paid (or remote) brain.
 *
 * Works against OpenAI, OpenRouter, Groq, Together, a local vLLM, AND the Chinese
 * providers (DeepSeek, Qwen/DashScope, Moonshot/Kimi, Zhipu/GLM, MiniMax). Pick a
 * preset by `backend` name, or `backend: "openai-compatible"` + an explicit
 * `baseUrl` for anything else. No local server is launched; auth is a Bearer key
 * from `config.apiKey` or the preset's env var.
 */
export class OpenAiProvider implements LLMProvider {
  readonly name: string;
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private apiKeyEnv: string;
  /** Extra headers sent on every request (e.g. a Hermes session id for multi-turn memory). */
  private readonly extraHeaders: Record<string, string>;
  /** Local/LAN OpenAI-compatible servers (LM Studio, vLLM, Jan, llama-swap, a LAN Hermes) need no key. */
  private readonly local: boolean;
  private readonly timeoutMs: number;

  constructor(config: LLMProviderConfig) {
    const backend = config.backend ?? "openai";
    const target = resolveOpenAiTarget(config);
    this.name = backend;
    this.baseUrl = target.baseUrl;
    this.apiKeyEnv = target.apiKeyEnv;
    this.apiKey = config.apiKey ?? process.env[this.apiKeyEnv] ?? "";
    this.model = config.model ?? "gpt-4o-mini";
    this.extraHeaders = config.extraHeaders ?? {};
    this.timeoutMs = requestTimeout(config.timeout_ms, PROVIDER_TIMEOUT_MS.llm);
    let host: string | undefined;
    try { host = new URL(this.baseUrl).hostname; } catch { host = undefined; }
    this.local = isKeylessHost(host);
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...this.extraHeaders };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async chatCompletion(messages: ChatMessage[], opts?: LLMCompletionOpts): Promise<string> {
    if (!this.apiKey && !this.local) {
      throw new Error(
        `${this.name}: no API key — set config.apiKey or the ${this.apiKeyEnv} environment variable`,
      );
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: opts?.temperature ?? 0.0,
      max_tokens: opts?.max_tokens ?? 100,
    };
    // llama.cpp only (cloud endpoints can reject unknown params): reuse the KV
    // cache across turns — the persona/system prefix is identical every turn.
    if (this.local) body.cache_prompt = true;
    if (opts?.responseFormat) {
      body.response_format = opts.responseFormat;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
      signal: providerSignal(this.timeoutMs, opts?.signal),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`${this.name} returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    const data = await readBoundedJson<{ choices?: Array<{ message?: { content?: string } }> }>(response);
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content) {
      const { log } = await import("../../logger");
      log("warn", `${this.name} returned empty content — response may be malformed`);
    }
    return content;
  }

  async *chatCompletionStream(messages: ChatMessage[], opts?: LLMCompletionOpts): AsyncGenerator<string> {
    if (!this.apiKey && !this.local) {
      throw new Error(
        `${this.name}: no API key — set config.apiKey or the ${this.apiKeyEnv} environment variable`,
      );
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: opts?.temperature ?? 0.0,
      max_tokens: opts?.max_tokens ?? 100,
      stream: true,
    };
    if (this.local) body.cache_prompt = true; // llama.cpp KV reuse (see chatCompletion)

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
      signal: providerSignal(this.timeoutMs, opts?.signal),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`${this.name} returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    if (!response.body) throw new Error(`${this.name} returned no response body for streaming`);

    yield* streamSSEContent(response.body);
  }

  async health(): Promise<boolean> {
    if (!this.apiKey && !this.local) return false;
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.authHeaders(),
        signal: providerSignal(PROVIDER_TIMEOUT_MS.health),
      });
      return await responseIsOk(res);
    } catch {
      return false; // unreachable = unhealthy
    }
  }

  async start(): Promise<void> {
    const { log } = await import("../../logger");
    if (!this.apiKey && !this.local) {
      log("warn", `${this.name} brain: no API key (set ${this.apiKeyEnv}); requests will fail until it is provided`);
      return;
    }
    const auth = this.apiKey ? "" : " (no key — local)";
    log("info", `${this.name} brain: ${openAiBaseUrlForDisplay(this.baseUrl)} (model ${this.model})${auth}`);
  }
}
