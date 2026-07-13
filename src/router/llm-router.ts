import type { Router, RouterResult, ActionConfig } from "../types";
import type { LLMProvider } from "../backends/llm/provider";
import { log } from "../logger";

export class LLMRouter implements Router {
  private provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  async classify(text: string, actions: Record<string, ActionConfig>, context?: string): Promise<RouterResult> {
    const systemPrompt = this.buildSystemPrompt(actions);

    const messages: Array<{role: "system" | "user" | "assistant", content: string}> = [
      { role: "system", content: systemPrompt },
    ];

    // Inject conversation history if available
    if (context) {
      messages.push({
        role: "system",
        content: `Recent conversation:\n${context}\n\nNow classify the next command:`,
      });
    }

    messages.push({ role: "user", content: text });

    try {
      const content = await this.provider.chatCompletion(messages, {
        temperature: 0.0,
        max_tokens: 100,
      });
      return this.parseResponse(content);
    } catch (err: unknown) {
      throw new Error("LLM router unavailable", { cause: err });
    }
  }

  async health(): Promise<boolean> {
    return this.provider.health();
  }

  private buildSystemPrompt(actions: Record<string, ActionConfig>): string {
    const actionList = Object.entries(actions)
      .map(([name, action]) => `- ${name} (${action.category}): ${action.examples.slice(0, 2).join(", ")}`)
      .join("\n");

    return `/no_think
Classify the voice command into JSON: {"intent":"<name>","category":"<cat>","params":{...},"confidence":<0-1>}

Actions:
${actionList}

Special intents:
- simple_question (category: local-llm): factual questions, jokes, definitions, conversational chat
- complex (category: brain): code tasks, file editing, multi-step reasoning, project work

Examples:
User: switch to the sales tab
{"intent":"tab_switch","category":"terminal","params":{"tab":"sales"},"confidence":0.95}

User: type ls into the prompt
{"intent":"text_inject","category":"brain","params":{"payload":"ls"},"confidence":0.95}

User: mute
{"intent":"runtime_mute","category":"local","params":{},"confidence":0.95}

User: what is the capital of France
{"intent":"simple_question","category":"local-llm","params":{"query":"what is the capital of France"},"confidence":0.9}

User: refactor the auth module to use JWT tokens
{"intent":"complex","category":"brain","params":{"query":"refactor the auth module to use JWT tokens"},"confidence":0.9}

Classify:`;
  }

  private parseResponse(content: string): RouterResult {
    try {
      // Strip Qwen3 thinking blocks
      const cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      // Try to extract JSON from the response
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          intent: parsed.intent || "complex",
          category: parsed.category || "brain",
          params: parsed.params || {},
          confidence: parsed.confidence || 0.5,
        };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log("warn", `Failed to parse LLM router response: ${msg} — raw: "${content.substring(0, 200)}"`);
    }

    // Fallback: treat as complex
    return {
      intent: "complex",
      category: "brain",
      params: { query: content },
      confidence: 0.0,
    };
  }
}
