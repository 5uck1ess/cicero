import type { Brain, BrainTurnOptions } from "../types";
import { log } from "../logger";
import { BrainTurnContext } from "./turn-context";
import {
  PROVIDER_TIMEOUT_MS,
  providerSignal,
  readBoundedJson,
  readErrorDetail,
  requestTimeout,
  responseIsOk,
} from "../backends/http-transfer";

export interface OllamaBrainConfig {
  port?: number;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
}

/**
 * Local Ollama brain — talks to the Ollama daemon's /api/chat over HTTP.
 * (Batch only; streaming via /api/chat stream:true is a possible follow-up.)
 */
export class OllamaBrain implements Brain {
  private port: number;
  private model: string;
  private systemPrompt: string;
  private readonly timeoutMs: number;
  private turnContext = new BrainTurnContext();

  constructor(config: OllamaBrainConfig = {}) {
    this.port = config.port ?? 11434;
    this.model = config.model ?? "qwen3.5:0.8b";
    this.systemPrompt = config.systemPrompt
      ?? "You are Cicero, a voice-controlled terminal assistant. Keep responses concise.";
    this.timeoutMs = requestTimeout(config.timeoutMs, PROVIDER_TIMEOUT_MS.llm);
  }

  async start(): Promise<void> {
    log("info", `Brain (Ollama ${this.model}) initialized on port ${this.port}`);
  }

  async stop(): Promise<void> {
    // Ollama runs as a separate daemon; nothing to stop from the brain side.
  }

  async send(message: string, options?: BrainTurnOptions): Promise<string> {
    try {
      const body = {
        model: this.model,
        messages: this.turnContext.buildChatMessages(message, this.systemPrompt, options?.systemContext),
        stream: false,
      };

      const res = await fetch(`http://localhost:${this.port}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: providerSignal(this.timeoutMs, options?.signal),
      });

      if (!res.ok) {
        const detail = await readErrorDetail(res);
        throw new Error(`Ollama returned ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      const data = await readBoundedJson<{ message?: { content?: string } }>(res);
      const reply = (data.message?.content ?? "").trim();
      this.turnContext.remember(message, reply);
      return reply;
    } catch (error) {
      throw new Error(`Ollama brain turn failed: ${(error as Error).message}`, { cause: error });
    }
  }

  injectContext(context: string): void {
    this.turnContext.inject(context);
  }

  async restart(): Promise<void> {
    this.turnContext.clear();
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${this.port}/api/tags`, {
        signal: providerSignal(PROVIDER_TIMEOUT_MS.health),
      });
      return await responseIsOk(res);
    } catch {
      return false;
    }
  }
}
