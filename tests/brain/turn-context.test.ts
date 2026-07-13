import { describe, expect, test } from "bun:test";
import { BrainTurnContext } from "../../src/brain/turn-context";

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
});
