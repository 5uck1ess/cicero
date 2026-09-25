import { expect, test } from "bun:test";
import { classifySetupChecks } from "../../src/setup/checks";
import type { Check } from "../../src/cli/doctor";

test("setup check policy blocks config faults and groups runtime readiness separately", () => {
  const checks: Check[] = [
    { name: "config", level: "fail", detail: "invalid config" },
    { name: "web_voice token", level: "fail", detail: "bad token" },
    { name: "web_voice TLS", level: "fail", detail: "missing TLS" },
    { name: "stt (faster-whisper)", level: "fail", detail: "venv missing", hint: "install it" },
    { name: "llm (ollama)", level: "fail", detail: "not running", hint: "start Ollama" },
    { name: "brain (claude-code)", level: "fail", detail: "binary missing" },
    { name: "brain mode (tab-inject)", level: "fail", detail: "no terminal" },
    { name: "gpu", level: "warn", detail: "busy" },
    { name: "web_voice token", level: "ok", detail: "set" },
  ];
  const groups = classifySetupChecks(checks);
  expect(groups.blocking.map((check) => check.name)).toEqual(["config", "web_voice token", "web_voice TLS"]);
  expect(groups.notReady.map((check) => check.name)).toEqual(["stt (faster-whisper)", "llm (ollama)", "brain (claude-code)", "brain mode (tab-inject)"]);
  expect(groups.notReady[0]?.hint).toBe("install it");
  expect(groups.warnings).toHaveLength(1);
  expect(groups.ok).toHaveLength(1);
});
