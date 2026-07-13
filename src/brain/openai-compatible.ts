import type { Brain, BrainTurnOptions } from "../types";
import { log } from "../logger";
import { OpenAiProvider } from "../backends/llm/openai";
import type { LLMProviderConfig, ChatMessage } from "../backends/llm/provider";
import { BrainTurnContext } from "./turn-context";

const DEFAULT_MAX_TOKENS = 1024;

/**
 * Brain backed by any OpenAI-compatible chat API — OpenRouter, a local server
 * (vLLM / LM Studio / llama.cpp), or a LAN Hermes model (gemma4 / qwen3-coder
 * served by llama-swap). Wraps {@link OpenAiProvider}, so it streams and treats
 * private-LAN hosts as keyless.
 *
 * Unlike the CLI agent brains (claude-code / codex), this ANSWERS with a model —
 * it does not run tools or edit files. Use it as a cloud/local coding-answer or
 * conversation brain; use a CLI agent when the turn must take actions.
 */
export class OpenAiCompatibleBrain implements Brain {
  private readonly provider: OpenAiProvider;
  private readonly maxTokens: number;
  private readonly label: string;
  private turnContext = new BrainTurnContext();

  constructor(config: LLMProviderConfig, maxTokens: number = DEFAULT_MAX_TOKENS) {
    this.provider = new OpenAiProvider(config);
    this.maxTokens = maxTokens;
    this.label = config.backend ?? "openai-compatible";
  }

  async start(): Promise<void> {
    await this.provider.start();
    log("info", `Brain (${this.label}) ready`);
  }

  async stop(): Promise<void> {
    // Stateless HTTP client — nothing persistent to tear down.
  }

  async send(message: string, options?: BrainTurnOptions): Promise<string> {
    try {
      const out = await this.provider.chatCompletion(this.buildMessages(message), {
        max_tokens: this.maxTokens,
        signal: options?.signal,
      });
      this.turnContext.remember(message, out);
      return out.trim();
    } catch (error) {
      throw new Error(`${this.label} brain turn failed: ${(error as Error).message}`, { cause: error });
    }
  }

  async *sendStream(message: string, options?: BrainTurnOptions): AsyncGenerator<string> {
    try {
      let out = "";
      for await (const chunk of this.provider.chatCompletionStream(this.buildMessages(message), {
        max_tokens: this.maxTokens,
        signal: options?.signal,
      })) {
        out += chunk;
        yield chunk;
      }
      this.turnContext.remember(message, out);
    } catch (error) {
      throw new Error(`${this.label} brain stream failed: ${(error as Error).message}`, { cause: error });
    }
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
    return this.provider.health();
  }

  /** Prepend any injected context as a system message ahead of the user turn. */
  private buildMessages(message: string): ChatMessage[] {
    return this.turnContext.buildChatMessages(message) as ChatMessage[];
  }
}
