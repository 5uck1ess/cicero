import { test, expect } from "bun:test";
import {
  cleanCommand,
  codexAgentMessages,
  codexThreadId,
  narrateCodexEvents,
} from "../src/agent/codex-narration";

async function* from(events: unknown[]): AsyncGenerator<unknown> {
  for (const e of events) yield e;
}

async function narrate(events: unknown[]): Promise<string[]> {
  const out: string[] = [];
  for await (const s of narrateCodexEvents(from(events))) out.push(s);
  return out;
}

test("cleanCommand strips the shell wrapper codex prepends", () => {
  expect(cleanCommand("/bin/zsh -lc ls")).toBe("ls");
  expect(cleanCommand("/bin/bash -lc npm test")).toBe("npm test");
  expect(cleanCommand("ls -la")).toBe("ls -la");
});

test("narrates agent messages + command starts; skips bookkeeping, output, success exits", async () => {
  // Real codex `exec --json` event shapes (captured from codex-cli).
  const out = await narrate([
    { type: "thread.started", thread_id: "x" },
    { type: "item.completed", item: { type: "error", message: "bad hooks config" } },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "I’ll list the current directory." } },
    { type: "item.started", item: { type: "command_execution", command: "/bin/zsh -lc ls", status: "in_progress" } },
    { type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc ls", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { type: "agent_message", text: "There are 14 entries." } },
    { type: "turn.completed", usage: {} },
  ]);
  expect(out).toEqual(["I’ll list the current directory.", "Running ls.", "There are 14 entries."]);
});

test("flags a non-zero command exit", async () => {
  const out = await narrate([
    { type: "item.started", item: { type: "command_execution", command: "/bin/zsh -lc false" } },
    { type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc false", exit_code: 1, status: "completed" } },
  ]);
  expect(out).toEqual(["Running false.", "That command failed."]);
});

test("extracts only a validated thread.started UUID", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  expect(codexThreadId({ type: "thread.started", thread_id: id })).toBe(id);
  expect(codexThreadId({ type: "turn.started", thread_id: id })).toBeNull();
  expect(() => codexThreadId({ type: "thread.started", thread_id: "latest" })).toThrow("valid thread UUID");
  expect(() => codexThreadId({ type: "thread.started" })).toThrow("valid thread UUID");
});

test("normal Codex output streams agent messages with stable boundaries", async () => {
  const out: string[] = [];
  const events = from([
    { type: "thread.started", thread_id: "11111111-1111-4111-8111-111111111111" },
    { type: "item.started", item: { type: "command_execution", command: "pwd" } },
    { type: "item.completed", item: { type: "agent_message", text: "First" } },
    { type: "item.completed", item: { type: "command_execution", exit_code: 0 } },
    { type: "item.completed", item: { type: "agent_message", text: "Second" } },
  ]);
  for await (const chunk of codexAgentMessages(events)) out.push(chunk);
  expect(out).toEqual(["First", "\nSecond"]);
});
