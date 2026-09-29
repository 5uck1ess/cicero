import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { ACP_AGENTS, contributeAgent, detectAgent, parseAgent } from "../../src/setup/agent";
import { createDraft, renderDraft, type SetupDraft } from "../../src/setup/draft";
import { SetupSession } from "../../src/setup/session";
import type { StepContext } from "../../src/setup/steps";
import { fixtureSystem } from "./fixtures";

const modelFront: [string, unknown] = ["frontdesk", { kind: "model", runtime: "ollama", model: "gemma4:26b-a4b-it-qat" }];
const agentFront: [string, unknown] = ["frontdesk", { kind: "agent" }];
const ctx = (mode: "local" | "cloud", choices: [string, unknown][] = []): StepContext => ({
  system: fixtureSystem("cuda24"), draft: { ...createDraft("local-cuda", "x".repeat(64)), privacy: { mode } },
  choices: new Map<string, unknown>([["privacy", { mode }], ...choices]),
});
function loadDraft(draft: SetupDraft) {
  const home = mkdtempSync(join(tmpdir(), "cicero-agent-"));
  try { writeFileSync(join(home, "config.yaml"), renderDraft(draft)); return loadConfig({}, { home }); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

test("a model front desk writes brain.escalate and never overwrites brain.backend", () => {
  const c = ctx("local", [modelFront]);
  const choice = parseAgent({ id: "hermes" }, c);
  const written = contributeAgent(c, choice) as { brain: Record<string, unknown> };
  expect(written).toEqual({ brain: { escalate: { binary: "hermes", binary_args: ["acp"] } } });
  expect(written.brain.backend).toBeUndefined();
  expect(() => parseAgent({ id: "codex" }, ctx("cloud", [modelFront]))).toThrow("must be an ACP agent");
  expect(() => parseAgent({ id: "ollama", model: "m" }, ctx("cloud", [modelFront]))).toThrow("must be an ACP agent");
  expect(contributeAgent(c, parseAgent({ id: "none" }, c))).toEqual({});
  expect(() => parseAgent({ id: "none" }, ctx("local", [agentFront]))).toThrow("An agent front desk needs an agent");
});

test("local privacy: a cloud agent needs allowCloud, which adds agent to privacy.allow", () => {
  expect(() => parseAgent({ id: "codex" }, ctx("local", [agentFront]))).toThrow("Allow this agent to use the cloud first");
  expect(() => parseAgent({ id: "codex-acp" }, ctx("local", [modelFront]))).toThrow("Allow this agent to use the cloud first");
  const c = ctx("local", [agentFront]);
  const written = contributeAgent(c, parseAgent({ id: "codex", allowCloud: true }, c));
  expect(written).toEqual({ privacy: { mode: "local", allow: ["agent"] }, brain: { backend: "codex", mode: "subprocess" } });
  expect(contributeAgent(ctx("cloud", [agentFront]), parseAgent({ id: "codex" }, ctx("cloud", [agentFront])))).toEqual({ brain: { backend: "codex", mode: "subprocess" } });
  expect(parseAgent({ id: "hermes" }, ctx("local", [agentFront]))).toMatchObject({ id: "acp", binary: "hermes", cloud: false });
  expect(parseAgent({ id: "openai-compatible", baseUrl: "http://192.168.1.5:8080/v1", model: "m" }, ctx("local", [agentFront])).cloud).toBe(false);
  expect(() => parseAgent({ id: "groq", model: "m" }, ctx("local", [agentFront]))).toThrow("Allow this agent");
  expect(() => parseAgent({ id: "codex", allowCloud: "yes" }, c)).toThrow();
});

test("a custom ACP command running a known cloud adapter is cloud, with its provider, like the named adapter", () => {
  const custom = { id: "acp", command: ["bunx", "@agentclientprotocol/codex-acp@2.0.0"] };
  expect(() => parseAgent(custom, ctx("local", [modelFront]))).toThrow("Allow this agent to use the cloud first");
  const allowed = parseAgent({ ...custom, allowCloud: true }, ctx("local", [modelFront]));
  expect(allowed).toMatchObject({ cloud: true, allowCloud: true, provider: "codex" });
  const withAccounts = ctx("local", [modelFront, ["accounts", { useSubscription: ["codex"] }]]);
  expect(contributeAgent(withAccounts, allowed)).toMatchObject({ brain: { escalate: { unset_env: ["OPENAI_API_KEY"] } } });
  expect(parseAgent({ id: "acp", command: ["hermes", "-p", "coder", "acp"] }, ctx("local", [modelFront]))).toMatchObject({ cloud: false, provider: null });
});

test("Accounts useSubscription writes unset_env on whichever key the agent lands in", () => {
  const accounts: [string, unknown] = ["accounts", { useSubscription: ["claude", "codex"] }];
  const brainCtx = ctx("cloud", [agentFront, accounts]);
  expect(contributeAgent(brainCtx, parseAgent({ id: "claude-code" }, brainCtx))).toEqual({ brain: { backend: "claude-code", mode: "subprocess", unset_env: ["ANTHROPIC_API_KEY"] } });
  const escCtx = ctx("cloud", [modelFront, accounts]);
  expect(contributeAgent(escCtx, parseAgent({ id: "codex-acp" }, escCtx))).toEqual({ brain: { escalate: { binary: "bunx", binary_args: ["@agentclientprotocol/codex-acp@2.0.0"], unset_env: ["OPENAI_API_KEY"] } } });
  expect(contributeAgent(escCtx, parseAgent({ id: "hermes" }, escCtx))).toEqual({ brain: { escalate: { binary: "hermes", binary_args: ["acp"] } } });
});

test("detection: target follows the front desk; ACP rows report found and stay unverified", async () => {
  const deps = { which: (b: string) => b === "hermes" ? "/usr/bin/hermes" : null, runCommand: async () => { throw new Error("not called"); } };
  const esc = await detectAgent(ctx("local", [modelFront]), deps);
  expect(esc.target).toBe("escalate");
  expect(esc.recommended).toBe("none");
  expect(esc.acp.find((a) => a.id === "hermes")).toMatchObject({ found: true, cloud: false, status: "unverified until first call" });
  expect(esc.acp.find((a) => a.id === "codex-acp")).toMatchObject({ found: false, cloud: true });
  const brain = await detectAgent(ctx("local", [agentFront]), deps);
  expect(brain.target).toBe("brain");
  expect(brain.recommended).toBe("hermes");
  expect(ACP_AGENTS.map((a) => a.id)).toEqual(["hermes", "codex-acp", "claude-acp", "grok-acp"]);
});

test("ollama front desk + codex-acp escalation validates through loadConfig", async () => {
  const s = new SetupSession(fixtureSystem("cuda24"), undefined, { env: {}, which: () => null, readFile: () => null, homeDir: () => "/fixture/home" });
  await s.choose("privacy", { mode: "cloud" }, { probe: false });
  await s.choose("frontdesk", modelFront[1], { probe: false });
  await s.choose("helper", { id: "model", runtime: "ollama", model: "gemma4:e4b-it-qat" }, { probe: false });
  await s.choose("brain", { id: "codex-acp" }, { probe: false });
  const config = loadDraft(s.draft);
  expect(config.brain).toMatchObject({ backend: "ollama", ollama_model: "gemma4:26b-a4b-it-qat", escalate: { binary: "bunx", binary_args: ["@agentclientprotocol/codex-acp@2.0.0"] } });
});
