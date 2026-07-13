import { test, expect } from "bun:test";
import { createBrain } from "../src/brain";
import { RuntimeConfig } from "../src/config";
import type { CiceroConfig } from "../src/types";
import { ClaudeCodeBrain } from "../src/brain/claude-code";
import { CodexBrain } from "../src/brain/codex";
import { GeminiBrain } from "../src/brain/gemini";
import { QwenBrain } from "../src/brain/qwen";
import { OllamaBrain } from "../src/brain/ollama";
import { OpenAiCompatibleBrain } from "../src/brain/openai-compatible";
import { TabInjectBrain } from "../src/brain/tab-inject";
import { KittyAdapter } from "../src/terminal/kitty";
import { NullTerminalAdapter } from "../src/terminal/null";
import { SwitchboardBrain } from "../src/brain/switchboard";

function cfg(
  backend: CiceroConfig["brain"]["backend"],
  brainExtra: Partial<CiceroConfig["brain"]> = {},
): RuntimeConfig {
  return new RuntimeConfig({
    tts_enabled: true,
    wake_word_enabled: false,
    hotkey: "ctrl+shift+space",
    wispr_hotkey: "option+space",
    terminal: "auto",
    voice: "default",
    brain: { backend, mode: "subprocess", ...brainExtra },
    servers: { router: { port: 8081, model: "x" }, tts: { port: 8082, model: "y" }, stt: { port: 8083, model: "z" } },
    actions: {},
  });
}

test("factory returns ClaudeCodeBrain for claude-code", () => {
  expect(createBrain(cfg("claude-code"))).toBeInstanceOf(ClaudeCodeBrain);
});
test("factory returns CodexBrain for codex", () => {
  expect(createBrain(cfg("codex"))).toBeInstanceOf(CodexBrain);
});
test("factory returns GeminiBrain for gemini", () => {
  expect(createBrain(cfg("gemini"))).toBeInstanceOf(GeminiBrain);
});
test("factory returns QwenBrain for qwen", () => {
  expect(createBrain(cfg("qwen"))).toBeInstanceOf(QwenBrain);
});
test("factory returns OllamaBrain for ollama", () => {
  expect(createBrain(cfg("ollama"))).toBeInstanceOf(OllamaBrain);
});
test("factory returns OpenAiCompatibleBrain for openai-compatible (local / Hermes model)", () => {
  expect(
    createBrain(cfg("openai-compatible", { base_url: "http://192.168.1.50:8080/v1", model: "gemma4" })),
  ).toBeInstanceOf(OpenAiCompatibleBrain);
});
test("factory returns OpenAiCompatibleBrain for an OpenAI preset (openrouter)", () => {
  expect(createBrain(cfg("openrouter", { model: "z-ai/glm-4.6", api_key: "k" }))).toBeInstanceOf(OpenAiCompatibleBrain);
});
test("factory passes binary_args + unset_env to claude-code", () => {
  const brain = createBrain(cfg("claude-code", { binary_args: ["--dangerously-skip-permissions"], unset_env: ["ANTHROPIC_API_KEY"] }));
  expect(brain).toBeInstanceOf(ClaudeCodeBrain);
});

test("daemon dial-back control is available across every brain backend", async () => {
  const configs = [
    cfg("claude-code"),
    cfg("codex"),
    cfg("gemini"),
    cfg("qwen"),
    cfg("ollama"),
    cfg("acp"),
    cfg("openai-compatible", { base_url: "http://192.0.2.10:8080/v1", model: "local" }),
  ];

  for (const config of configs) {
    const brain = createBrain(config, undefined, { dialBackControl: true });
    const requested: Array<string | undefined> = [];
    brain.setCallMeHandler!(async (who) => { requested.push(who); return "Ringing you now."; });
    expect(await brain.send("call me")).toBe("Ringing you now.");
    expect(requested).toEqual([undefined]);
  }
});

test("daemon keeps the switchboard's native dial-back control instead of decorating it twice", () => {
  const brain = createBrain(cfg("acp", {
    lanes: { coder: { backend: "acp" } },
  }), undefined, { dialBackControl: true });

  expect(brain).toBeInstanceOf(SwitchboardBrain);
});

test("tab-inject requires a terminal that can own a real interactive tab", () => {
  const config = cfg("claude-code", { mode: "tab-inject" });
  expect(() => createBrain(config)).toThrow(/requires kitty, tmux, or WezTerm/);
  expect(() => createBrain(config, new NullTerminalAdapter())).toThrow(/brain\.mode: subprocess/);
  expect(createBrain(config, new KittyAdapter())).toBeInstanceOf(TabInjectBrain);
});
