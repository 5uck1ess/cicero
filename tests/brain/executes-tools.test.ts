import { test, expect } from "bun:test";
import { brainExecutesTools, canSpeculateWithBrain } from "../../src/brain/capabilities";
import { OPENAI_COMPATIBLE_BACKENDS } from "../../src/backends/llm/openai";
import { AcpBrain } from "../../src/brain/acp";
import { DialBackBrain } from "../../src/brain/dial-back";
import { FallbackBrain } from "../../src/brain/fallback";
import { QuickIntentsBrain } from "../../src/brain/quick-intents";
import { RoutingBrain } from "../../src/brain/routing";
import { SwitchboardBrain } from "../../src/brain/switchboard";
import type { Brain } from "../../src/types";

/**
 * The gate that keeps speculative turns off brains that can change the world.
 * Speculation starts a turn on an utterance the user has not finished; a wrong
 * guess drops the tokens, but a tool call has already run by then.
 */

test("CLI agents and ACP run tools", () => {
  for (const backend of ["claude-code", "codex", "gemini", "qwen", "acp"]) {
    expect(brainExecutesTools({ backend, mode: "subprocess" })).toBe(true);
  }
});

test("ollama serves models, not agents", () => {
  expect(brainExecutesTools({ backend: "ollama", mode: "subprocess" })).toBe(false);
});

test("an OpenAI preset on its own public endpoint is model-only", () => {
  expect(OPENAI_COMPATIBLE_BACKENDS.length).toBeGreaterThan(0);
  for (const backend of OPENAI_COMPATIBLE_BACKENDS) {
    expect(brainExecutesTools({ backend, mode: "subprocess" })).toBe(false);
  }
});

test("an explicit base_url makes any OpenAI-family brain tool-capable", () => {
  // `base_url` overrides the preset for EVERY backend name (resolveOpenAiTarget),
  // and Cicero documents pointing it at Hermes' agent HTTP API — which runs
  // tools server-side. Config alone cannot tell a model server from an agent.
  expect(brainExecutesTools({
    backend: "openai-compatible", mode: "subprocess", base_url: "http://127.0.0.1:8642/v1",
  })).toBe(true);
  // ...including a named preset, which base_url silently redirects.
  expect(brainExecutesTools({
    backend: "groq", mode: "subprocess", base_url: "http://127.0.0.1:8642/v1",
  })).toBe(true);
});

test("a blank base_url is not an override", () => {
  for (const base_url of ["", "   ", undefined]) {
    expect(brainExecutesTools({ backend: "openai-compatible", mode: "subprocess", base_url })).toBe(false);
  }
});

test("tab-inject implies an agent only for claude-code, which is the only brain that honors it", () => {
  expect(brainExecutesTools({ backend: "claude-code", mode: "tab-inject" })).toBe(true);
  // The factory falls through to the ordinary backend for any other name, so
  // the mode alone must not cost a text-only brain its speculation.
  expect(brainExecutesTools({ backend: "ollama", mode: "tab-inject" })).toBe(false);
});

test("fails closed on an unrecognized backend", () => {
  // `backend` accepts arbitrary preset strings. Guessing "safe" on an unknown
  // agent is the mistake that cannot be undone, so unknown means tool-executing.
  expect(brainExecutesTools({ backend: "some-future-agent", mode: "subprocess" })).toBe(true);
  expect(brainExecutesTools({ backend: "", mode: "subprocess" })).toBe(true);
});

test("ACP hold enables speculation by default while non-deferrable tool brains still need opt-in", () => {
  const acp = { backend: "acp", mode: "subprocess" };
  const codex = { backend: "codex", mode: "subprocess" };
  const hold = { canDeferSpeculativePermissions: () => true };
  const noHold = { canDeferSpeculativePermissions: () => false };
  expect(canSpeculateWithBrain(acp, hold)).toBe(true);
  expect(canSpeculateWithBrain(acp, noHold)).toBe(false);
  expect(canSpeculateWithBrain(codex, noHold)).toBe(false);
  expect(canSpeculateWithBrain(codex, noHold, true)).toBe(true);
  expect(canSpeculateWithBrain({ backend: "ollama", mode: "subprocess" }, noHold)).toBe(true);
});

test("wrappers advertise the hold only when every reachable route supports it", () => {
  const acp = new AcpBrain({ binary: "unused" });
  const cli = {} as Brain;
  expect(new DialBackBrain(acp).canDeferSpeculativePermissions()).toBe(true);
  expect(new QuickIntentsBrain(acp, []).canDeferSpeculativePermissions()).toBe(true);
  expect(new RoutingBrain(acp, acp).canDeferSpeculativePermissions()).toBe(true);
  expect(new RoutingBrain(acp, cli).canDeferSpeculativePermissions()).toBe(false);
  expect(new FallbackBrain([acp, cli], "coder").canDeferSpeculativePermissions()).toBe(false);
  expect(new SwitchboardBrain(acp, { coder: { brain: acp } }).canDeferSpeculativePermissions()).toBe(true);
  expect(new SwitchboardBrain(acp, { coder: { brain: cli } }).canDeferSpeculativePermissions()).toBe(false);
});

test("intent overlap fails closed across mixed wrapper routes", async () => {
  const { canHoldIntentOutput } = await import("../../src/brain/capabilities");
  const text = { canHoldIntentOutput: () => true } as Brain;
  const acp = { canDeferSpeculativePermissions: () => true } as Brain;
  const unknown = {} as Brain;
  expect(canHoldIntentOutput(unknown)).toBe(false);
  expect(canHoldIntentOutput(new RoutingBrain(text, acp))).toBe(true);
  expect(canHoldIntentOutput(new RoutingBrain(text, unknown))).toBe(false);
  expect(canHoldIntentOutput(new FallbackBrain([text, acp], "safe"))).toBe(true);
  expect(canHoldIntentOutput(new FallbackBrain([text, unknown], "unsafe"))).toBe(false);
});

test("an explicit unsafe intent capability overrides ACP permission support", async () => {
  const { canHoldIntentOutput } = await import("../../src/brain/capabilities");
  const acp = { canDeferSpeculativePermissions: () => true } as Brain;
  const wrapper = new DialBackBrain(acp);
  expect(canHoldIntentOutput(wrapper)).toBe(true);
  wrapper.setCallMeHandler(async () => "dialed");
  expect(canHoldIntentOutput(wrapper)).toBe(false);
  expect(canHoldIntentOutput(new SwitchboardBrain(acp, {}))).toBe(false);
});

test("model adapters declare intent holding only for known model-only routes", async () => {
  const { canHoldIntentOutput } = await import("../../src/brain/capabilities");
  const { OllamaBrain } = await import("../../src/brain/ollama");
  const { OpenAiCompatibleBrain } = await import("../../src/brain/openai-compatible");
  expect(canHoldIntentOutput(new OllamaBrain())).toBe(true);
  expect(canHoldIntentOutput(new OpenAiCompatibleBrain({ backend: "openai" }))).toBe(true);
  expect(canHoldIntentOutput(new OpenAiCompatibleBrain({ backend: "openai", baseUrl: "http://synthetic.invalid/v1" }))).toBe(false);
});
