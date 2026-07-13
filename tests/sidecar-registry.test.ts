import { test, expect } from "bun:test";
import { createSpeakAdapter } from "../src/sidecar/registry";
import type { TerminalAdapter } from "../src/types";

test("registry returns ClaudeCodeHookAdapter for 'claude-code-hook'", () => {
  const adapter = createSpeakAdapter(
    { backend: "claude-code-hook", port: 8084 },
    {} as TerminalAdapter,
    "test-hook-token-that-is-at-least-32-bytes",
  );
  expect(adapter.name).toBe("claude-code-hook");
});

test("registry refuses to expose an unauthenticated Claude Code hook", () => {
  expect(() => createSpeakAdapter(
    { backend: "claude-code-hook", port: 8084 },
    {} as TerminalAdapter,
  )).toThrow("hook token is required");
});

test("registry returns TerminalScrapeAdapter for 'terminal-scrape'", () => {
  const terminal = { getText: async () => "" } as unknown as TerminalAdapter;
  const adapter = createSpeakAdapter(
    { backend: "terminal-scrape", targetTab: "1", pollIntervalMs: 500, quietWindowMs: 1500 },
    terminal,
  );
  expect(adapter.name).toBe("terminal-scrape");
});

test("registry throws on unknown backend", () => {
  expect(() => createSpeakAdapter(
    { backend: "nonsense" } as never,
    {} as TerminalAdapter,
  )).toThrow();
});
