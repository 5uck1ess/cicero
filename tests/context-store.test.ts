import { test, expect, describe } from "bun:test";
import { ContextStore } from "../src/brain/context-store";

describe("ContextStore", () => {
  test("adds and retrieves entries", () => {
    const store = new ContextStore();
    store.add("slack-cli.ts search", "3 messages");
    expect(store.size).toBe(1);
    expect(store.getContext()).toContain("slack-cli.ts search");
    expect(store.getContext()).toContain("3 messages");
  });

  test("respects max entries", () => {
    const store = new ContextStore(3);
    store.add("cmd1", "out1");
    store.add("cmd2", "out2");
    store.add("cmd3", "out3");
    store.add("cmd4", "out4");
    expect(store.size).toBe(3);
    expect(store.getContext()).not.toContain("cmd1");
    expect(store.getContext()).toContain("cmd4");
  });

  test("clear empties store", () => {
    const store = new ContextStore();
    store.add("cmd", "out");
    store.clear();
    expect(store.size).toBe(0);
  });
});

describe("ContextStore — structured turns", () => {
  test("addTurn stores structured turn data", () => {
    const store = new ContextStore();
    store.addTurn({
      text: "type ls",
      intent: "text_inject",
      category: "brain",
      params: { payload: "ls" },
    });
    expect(store.lastTurn).toBeDefined();
    expect(store.lastTurn!.intent).toBe("text_inject");
  });

  test("getRecentTurns returns last N turns", () => {
    const store = new ContextStore();
    store.addTurn({ text: "hello", intent: "greeting", category: "local", params: {} });
    store.addTurn({ text: "type ls", intent: "text_inject", category: "brain", params: { payload: "ls" } });
    store.addTurn({ text: "check slack", intent: "slack_check", category: "cli", params: {} });

    const recent = store.getRecentTurns(2);
    expect(recent.length).toBe(2);
    expect(recent[0].intent).toBe("text_inject");
    expect(recent[1].intent).toBe("slack_check");
  });

  test("getRecentTurnsForPrompt formats for LLM consumption", () => {
    const store = new ContextStore();
    store.addTurn({ text: "type ls", intent: "text_inject", category: "brain", params: { payload: "ls" }, output: "Listed files" });
    store.addTurn({ text: "now type cd src", intent: "text_inject", category: "brain", params: { payload: "cd src" } });

    const prompt = store.getRecentTurnsForPrompt(5);
    expect(prompt).toContain("type ls");
    expect(prompt).toContain("text_inject");
    expect(prompt).toContain("now type cd src");
  });

  test("lastTurn returns null when empty", () => {
    const store = new ContextStore();
    expect(store.lastTurn).toBeNull();
  });

  test("respects maxEntries for turns", () => {
    const store = new ContextStore(3);
    for (let i = 0; i < 5; i++) {
      store.addTurn({ text: `cmd ${i}`, intent: "test", category: "local", params: {} });
    }
    const turns = store.getRecentTurns(10);
    expect(turns.length).toBe(3);
    expect(turns[0].text).toBe("cmd 2"); // oldest kept
  });

  test("legacy add() still works", () => {
    const store = new ContextStore();
    store.add("hello", "world");
    expect(store.getContext()).toContain("[Command] hello");
    expect(store.size).toBe(1);
  });
});

describe("ContextStore — turn-to-prompt round trip", () => {
  test("turns format correctly for LLM consumption", () => {
    const store = new ContextStore();
    store.addTurn({
      text: "type ls",
      intent: "text_inject",
      category: "brain",
      params: { payload: "ls" },
      output: "Listed 5 files in current directory",
    });
    store.addTurn({
      text: "now type cd src",
      intent: "text_inject",
      category: "brain",
      params: { payload: "cd src" },
    });

    const prompt = store.getRecentTurnsForPrompt(5);

    // Should contain both turns with quoted text, intent, and category
    expect(prompt).toContain('User: "type ls" → text_inject (brain)');
    expect(prompt).toContain("Result: Listed 5 files");
    expect(prompt).toContain('User: "now type cd src" → text_inject (brain)');
    // Second turn has no output, so no Result line
    expect(prompt).not.toMatch(/now type cd src.*\nResult:/);
  });
});
