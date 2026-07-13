/**
 * Per-backend fallback for an unset (or whitespace-only) llm.model. Runtime
 * providers and doctor must derive the model from the same expression, or
 * diagnostics can verify a model the daemon never launches or requests.
 */
export const LLM_DEFAULT_MODEL = {
  ollama: "qwen3.5:0.8b",
  "llama-cpp": "local",
} as const;

/** The one shared normalization: trimmed config value, or the backend default. */
export function normalizedLlmModel(model: string | undefined, fallback: string): string {
  return model?.trim() || fallback;
}

export interface LLMProviderConfig {
  backend?: string;
  host?: string; // for remote model servers (defaults to localhost)
  port?: number;
  model?: string;
  apiKey?: string;
  baseUrl?: string; // full base URL for OpenAI-compatible/cloud APIs (e.g. https://api.openai.com/v1)
  apiKeyEnv?: string; // env var to read the API key from when apiKey is unset
  // Extra HTTP headers sent on every request (e.g. a Hermes session id for
  // server-side multi-turn memory: { "X-Hermes-Session-Id": "<uuid>" }).
  extraHeaders?: Record<string, string>;
  /** Absolute per-completion deadline in milliseconds (default 120 seconds). */
  timeout_ms?: number;
  extra?: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMCompletionOpts {
  temperature?: number;
  max_tokens?: number;
  responseFormat?: {
    type: "json_schema";
    json_schema: Record<string, unknown>;
  };
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly name: string;
  chatCompletion(messages: ChatMessage[], opts?: LLMCompletionOpts): Promise<string>;
  /**
   * Stream the completion as content tokens. Optional — callers must fall back to
   * {@link chatCompletion} when a provider doesn't implement it. Because the
   * conversational path now routes through the provider (not a hardcoded
   * localhost URL), a remote brain — e.g. a Hermes/Claude endpoint — streams too.
   */
  chatCompletionStream?(messages: ChatMessage[], opts?: LLMCompletionOpts): AsyncIterable<string>;
  health(): Promise<boolean>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
