import { expect, test } from "bun:test";
import { ActionExecutor } from "../src/executor";
import { ContextStore } from "../src/brain/context-store";
import type {
  Brain,
  BrainTurnOptions,
  RouterResult,
  Speaker,
  TerminalAdapter,
} from "../src/types";
import type { LLMProvider } from "../src/backends/llm/provider";

function inertBrain(send: Brain["send"]): Brain {
  return {
    start: async () => {},
    stop: async () => {},
    send,
    injectContext: () => {},
    restart: async () => {},
    health: async () => true,
  };
}

test("non-streaming brain execution receives the local turn signal", async () => {
  let received: AbortSignal | undefined;
  const brain = inertBrain(async (_message: string, options?: BrainTurnOptions) => {
    received = options?.signal;
    return "done";
  });
  const executor = new ActionExecutor(
    { actions: {}, ttsLocalMaxTokens: 32 } as never,
    {} as TerminalAdapter,
    brain,
    {} as Speaker,
    new ContextStore(),
    {} as LLMProvider,
  );
  const controller = new AbortController();
  const route: RouterResult = { intent: "chat", category: "brain", params: {} };

  const result = await executor.execute(route, "hello", { signal: controller.signal });

  expect(result.success).toBe(true);
  expect(received).toBe(controller.signal);
});

test("local-LLM batch fallback preserves the local turn signal", async () => {
  const seen: Array<AbortSignal | undefined> = [];
  const brain = inertBrain(async (_message: string, options?: BrainTurnOptions) => {
    seen.push(options?.signal);
    return "fallback";
  });
  const llm = {
    chatCompletion: async (_messages: unknown, options?: { signal?: AbortSignal }) => {
      seen.push(options?.signal);
      throw new Error("offline");
    },
  } as unknown as LLMProvider;
  const executor = new ActionExecutor(
    { actions: {}, ttsLocalMaxTokens: 32 } as never,
    {} as TerminalAdapter,
    brain,
    {} as Speaker,
    new ContextStore(),
    llm,
  );
  const controller = new AbortController();
  const route: RouterResult = { intent: "chat", category: "local-llm", params: {} };

  const result = await executor.execute(route, "hello", { signal: controller.signal });

  expect(result.output).toBe("fallback");
  expect(seen).toEqual([controller.signal, controller.signal]);
});
