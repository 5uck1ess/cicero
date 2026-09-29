import { expect, test } from "bun:test";
import { isCloudAcpCommand } from "../../src/setup/acp-agents";
import { privacyChecks } from "../../src/setup/privacy-checks";
import type { CiceroConfig } from "../../src/types";

const cfg = (extra: Record<string, unknown>) => ({ brain: { backend: "ollama", mode: "subprocess" }, ...extra }) as unknown as CiceroConfig;
const names = (config: CiceroConfig) => privacyChecks(config).map((c) => c.name);

test("no declared policy means no privacy checks", () => {
  expect(privacyChecks(cfg({ brain: { backend: "xai", mode: "subprocess" }, notify: { telegram: {} } }))).toEqual([]);
});

test("local mode: cloud model endpoints warn; loopback runtimes do not", () => {
  expect(names(cfg({ privacy: { mode: "local" }, brain: { backend: "xai", mode: "subprocess" } }))).toEqual(["privacy: brain endpoint"]);
  expect(names(cfg({ privacy: { mode: "local" }, brain: { backend: "ollama", mode: "subprocess" }, llm: { backend: "openai", baseUrl: "http://127.0.0.1:11434/v1" }, web_voice: { tldr: { summarizer_url: "http://localhost:8080/v1" } } }))).toEqual([]);
  expect(names(cfg({ privacy: { mode: "local" }, llm: { backend: "openai", baseUrl: "https://api.x.ai/v1" } }))).toEqual(["privacy: llm endpoint"]);
  expect(names(cfg({ privacy: { mode: "local" }, llm: { backend: "groq" } }))).toEqual(["privacy: llm endpoint"]);
  expect(names(cfg({ privacy: { mode: "local" }, web_voice: { tldr: { summarizer_url: "http://192.168.1.9:8080/v1" } } }))).toEqual(["privacy: helper endpoint"]);
});

test("local mode: a cloud agent needs allow: [agent]; cloud mode does not", () => {
  const checks = privacyChecks(cfg({ privacy: { mode: "local" }, brain: { backend: "claude-code", mode: "subprocess" } }));
  expect(checks.map((c) => c.name)).toEqual(["privacy: agent"]);
  expect(checks[0]!.detail).toContain("declared policy; doctor cannot see what a CLI agent does on the network");
  expect(names(cfg({ privacy: { mode: "local", allow: ["agent"] }, brain: { backend: "claude-code", mode: "subprocess" } }))).toEqual([]);
  expect(names(cfg({ privacy: { mode: "cloud" }, brain: { backend: "claude-code", mode: "subprocess" } }))).toEqual([]);
  expect(names(cfg({ privacy: { mode: "local" }, brain: { backend: "ollama", mode: "subprocess", escalate: { binary: "bunx", binary_args: ["@agentclientprotocol/codex-acp@2.0.0"] } } }))).toEqual(["privacy: escalation agent"]);
  expect(names(cfg({ privacy: { mode: "local" }, brain: { backend: "acp", mode: "subprocess", binary: "hermes", binary_args: ["acp"] } }))).toEqual([]);
});

test("endpoint warnings never print URL credentials", () => {
  const checks = privacyChecks(cfg({ privacy: { mode: "local" },
    brain: { backend: "openai-compatible", mode: "subprocess", base_url: "https://user:synthetic-password-marker@example.test/v1" },
    llm: { backend: "openai", baseUrl: "https://u:synthetic-llm-marker@example.test/v1" },
    web_voice: { tldr: { summarizer_url: "https://u:synthetic-helper-marker@example.test/v1" } } }));
  expect(checks.map((c) => c.name)).toEqual(["privacy: brain endpoint", "privacy: llm endpoint", "privacy: helper endpoint"]);
  expect(JSON.stringify(checks)).not.toMatch(/synthetic-(password|llm|helper)-marker/);
});

test("local mode: a remote model host warns like a remote URL", () => {
  expect(names(cfg({ privacy: { mode: "local" }, llm: { backend: "ollama", host: "192.168.1.50" } }))).toEqual(["privacy: llm endpoint"]);
  expect(names(cfg({ privacy: { mode: "local" }, llm: { backend: "ollama", host: "127.0.0.1" } }))).toEqual([]);});

test("both modes: speech must stay on this machine", () => {
  for (const mode of ["local", "cloud"]) {
    expect(names(cfg({ privacy: { mode }, tts: { backend: "elevenlabs" } }))).toEqual(["privacy: speech"]);
    expect(names(cfg({ privacy: { mode }, stt: { backend: "wyoming", host: "203.0.113.2", port: 10300 } }))).toEqual(["privacy: speech"]);
    expect(names(cfg({ privacy: { mode }, stt: { backend: "wyoming", host: "127.example.com", port: 10300 } }))).toEqual(["privacy: speech"]);
    expect(names(cfg({ privacy: { mode }, stt: { backend: "wyoming", host: "127.0.0.2", port: 10300 } }))).toEqual([]);
    expect(names(cfg({ privacy: { mode }, stt: { backend: "faster-whisper" }, tts: { backend: "wyoming", host: "localhost", port: 10200 } }))).toEqual([]);
  }
});

test("both modes: Telegram and board need their allowances", () => {
  expect(names(cfg({ privacy: { mode: "cloud" }, notify: { telegram: { bot_token: "x" } } }))).toEqual(["privacy: telegram"]);
  for (const mode of ["local", "cloud"]) {
    expect(names(cfg({ privacy: { mode }, notify: { kanban: { enabled: true } } }))).toEqual(["privacy: board"]);
    expect(names(cfg({ privacy: { mode, allow: ["board"] }, notify: { kanban: { enabled: true } } }))).toEqual([]);
  }
});

test("cloud ACP adapters are recognized with or without a version pin", () => {
  expect(isCloudAcpCommand("bunx", ["@agentclientprotocol/codex-acp@2.0.0"])).toBe(true);
  expect(isCloudAcpCommand("bun", ["x", "@zed-industries/claude-code-acp@0.16.2"])).toBe(true);
  expect(isCloudAcpCommand("npx", ["@agentclientprotocol/claude-agent-acp"])).toBe(true);
  expect(isCloudAcpCommand("grok", ["agent", "stdio"])).toBe(true);
  expect(isCloudAcpCommand("hermes", ["-p", "coder", "acp"])).toBe(false);
  // Cloud CLIs with their own ACP mode (docs/brains.md): always cloud, by binary name or path.
  expect(isCloudAcpCommand("gemini", ["--acp"])).toBe(true);
  expect(isCloudAcpCommand("/usr/local/bin/gemini", ["--experimental-acp"])).toBe(true);
  expect(isCloudAcpCommand("qwen", ["--acp"])).toBe(true);
  expect(isCloudAcpCommand("openclaw", ["acp"])).toBe(false);
});
