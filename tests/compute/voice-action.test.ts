import { test, expect } from "bun:test";
import { runVoiceAction } from "../../src/compute";
import { ToolRegistry } from "../../src/compute/registry";
import type { Tool } from "../../src/compute/tool";

function scriptedLLM(steps: string[]) {
  let i = 0;
  return { async chatCompletion() { return steps[Math.min(i++, steps.length - 1)]; } };
}

function registryWith(tool: Tool): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(tool);
  return reg;
}

test("speaks a confirm prompt, honors a spoken yes, runs the tool, returns the summary", async () => {
  const spoken: string[] = [];
  let ran = false;
  const openApp: Tool = {
    name: "open_app", description: "open an app",
    parameters: { type: "object", properties: { name: { type: "string" } } },
    async run() { ran = true; return { ok: true, output: "opened" }; },
  };
  const llm = scriptedLLM([
    '{"thought":"open it","action":{"tool":"open_app","args":{"name":"Notes"}}}',
    '{"thought":"done","action":{"tool":"finish","args":{"summary":"opened Notes"}}}',
  ]);

  const result = await runVoiceAction("open notes", {
    llm,
    speak: async (t) => { spoken.push(t); },
    listenOnce: async () => "yes",
    registry: registryWith(openApp),
  });

  expect(result.ok).toBe(true);
  expect(result.summary).toBe("opened Notes");
  expect(ran).toBe(true);
  expect(spoken.join(" ")).toContain("open_app");
});

test("a spoken no declines the action — the tool never runs", async () => {
  let ran = false;
  const shell: Tool = {
    name: "shell", description: "run shell",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    async run() { ran = true; return { ok: true, output: "" }; },
  };
  const llm = scriptedLLM([
    '{"thought":"run","action":{"tool":"shell","args":{"command":"echo hi"}}}',
    '{"thought":"ok","action":{"tool":"finish","args":{"summary":"skipped it"}}}',
  ]);

  const result = await runVoiceAction("do something", {
    llm,
    speak: async () => {},
    listenOnce: async () => "no, don't",
    registry: registryWith(shell),
  });

  expect(ran).toBe(false);
  expect(result.summary).toBe("skipped it");
});
