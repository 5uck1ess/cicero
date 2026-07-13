import { test, expect } from "bun:test";
import { ClaudeCodeBrain } from "../src/brain/claude-code";

test("ClaudeCodeBrain uses 'claude' binary with --print arg", async () => {
  const brain = new ClaudeCodeBrain();
  await brain.start();
  const cfg = (brain as unknown as { config: { binary: string; args: string[] } }).config;
  expect(cfg.binary).toBe("claude");
  expect(cfg.args).toEqual(["--print"]);
});

test("ClaudeCodeBrain health returns a boolean", async () => {
  const brain = new ClaudeCodeBrain();
  const ok = await brain.health();
  expect(typeof ok).toBe("boolean");
});
