import { test, expect } from "bun:test";
import { brainExecutesTools } from "../../src/brain/capabilities";
import { OPENAI_COMPATIBLE_BACKENDS } from "../../src/backends/llm/openai";

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
