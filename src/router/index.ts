import type { RuntimeConfig } from "../config";
import type { Router } from "../types";
import type { LLMProvider } from "../backends/llm/provider";
import { LLMRouter } from "./llm-router";
import { FallbackRouter } from "./fallback-router";

export function createRouter(config: RuntimeConfig, llmProvider: LLMProvider): Router {
  return new FallbackRouter(
    new LLMRouter(llmProvider),
    config.phoneticAliases,
  );
}
