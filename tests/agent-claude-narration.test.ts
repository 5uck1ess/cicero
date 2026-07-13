import { test, expect } from "bun:test";
import { narrateClaudeEvents } from "../src/agent/claude-narration";

async function* from(events: unknown[]): AsyncGenerator<unknown> {
  for (const e of events) yield e;
}

async function narrate(events: unknown[]): Promise<string[]> {
  const out: string[] = [];
  for await (const s of narrateClaudeEvents(from(events))) out.push(s);
  return out;
}

test("narrates assistant text + tool calls; skips thinking, output, result, system", async () => {
  // Real claude `stream-json` shapes (captured from claude-cli).
  const out = await narrate([
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "let me think" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls", description: "list" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", is_error: false, content: "a\nb\nc" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "There are 3 entries." }] } },
    { type: "result", subtype: "success", result: "There are 3 entries.", is_error: false },
  ]);
  expect(out).toEqual(["Running ls.", "There are 3 entries."]);
});

test("maps file tools to spoken labels and flags failed tool results", async () => {
  const out = await narrate([
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/src/auth.ts" } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/repo/README.md" } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "TODO" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] } },
  ]);
  expect(out).toEqual(["Editing auth.ts.", "Reading README.md.", "Searching the codebase.", "That command failed."]);
});

test("handles an assistant message with both text and a tool call in order", async () => {
  const out = await narrate([
    { type: "assistant", message: { content: [{ type: "text", text: "I'll check the tests." }, { type: "tool_use", name: "Bash", input: { command: "bun test" } }] } },
  ]);
  expect(out).toEqual(["I'll check the tests.", "Running bun test."]);
});
