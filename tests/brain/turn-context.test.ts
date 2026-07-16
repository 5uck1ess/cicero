import { describe, expect, test } from "bun:test";
import { BrainTurnContext, MAX_SYSTEM_CONTEXT_CHARS } from "../../src/brain/turn-context";

describe("BrainTurnContext", () => {
  test("injected context is one-shot", () => {
    const context = new BrainTurnContext();
    context.inject("command output");
    expect(context.buildTextPrompt("first", false)).toContain("command output");
    expect(context.buildTextPrompt("second", false)).toBe("second");
  });

  test("stateless chat history contains only completed bounded turns", () => {
    const context = new BrainTurnContext();
    for (let i = 0; i < 20; i++) context.remember(`question ${i}`, `answer ${i}`);
    const messages = context.buildChatMessages("latest");
    expect(messages).toHaveLength(25); // 12 remembered user/assistant pairs + current user
    expect(messages[0]).toEqual({ role: "user", content: "question 8" });
    expect(messages.at(-1)).toEqual({ role: "user", content: "latest" });
  });

  test("pending context is capped and clear resets both context and history", () => {
    const context = new BrainTurnContext();
    for (let i = 0; i < 60; i++) context.inject(`entry ${i}`);
    expect(context.pendingSize).toBe(50);
    context.remember("question", "answer");
    context.clear();
    expect(context.pendingSize).toBe(0);
    expect(context.buildChatMessages("fresh")).toEqual([{ role: "user", content: "fresh" }]);
  });

  test("system context follows the system prompt and precedes history", () => {
    const context = new BrainTurnContext();
    context.remember("old question", "old answer");
    const messages = context.buildChatMessages("current", "base prompt", "snapshot A");
    expect(messages.map((message) => message.role)).toEqual([
      "system", "system", "user", "assistant", "user",
    ]);
    expect(messages[0]!.content).toBe("base prompt");
    expect(messages[1]!.content).toContain("snapshot A");
  });

  test("text prompts frame host context immediately before the current request", () => {
    const context = new BrainTurnContext();
    context.remember("old question", "old answer");
    const prompt = context.buildTextPrompt("current question", true, "snapshot B");
    expect(prompt.indexOf("Conversation so far:")).toBeLessThan(prompt.indexOf("Host operational context"));
    expect(prompt.indexOf("snapshot B")).toBeLessThan(prompt.indexOf("Current user request:"));
  });

  test("system context is bounded and never retained in history", () => {
    const context = new BrainTurnContext();
    const first = context.buildChatMessages("first", undefined, "x".repeat(MAX_SYSTEM_CONTEXT_CHARS * 2));
    expect(first[0]!.content.length).toBeLessThan(MAX_SYSTEM_CONTEXT_CHARS + 100);
    context.remember("first", "answer");
    const second = context.buildChatMessages("second");
    expect(second.some((message) => message.content.includes("Host operational context"))).toBe(false);
    expect(second.some((message) => message.content.includes("snapshot"))).toBe(false);
  });

  test("concurrent invocations never cross system contexts", async () => {
    const context = new BrainTurnContext();
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => context.buildChatMessages("A", undefined, "context-A")),
      Promise.resolve().then(() => context.buildChatMessages("B", undefined, "context-B")),
    ]);
    expect(a.map((m) => m.content).join("\n")).toContain("context-A");
    expect(a.map((m) => m.content).join("\n")).not.toContain("context-B");
    expect(b.map((m) => m.content).join("\n")).toContain("context-B");
    expect(b.map((m) => m.content).join("\n")).not.toContain("context-A");
  });
});
