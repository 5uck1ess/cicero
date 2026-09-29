import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { runSetup, SetupUsageError } from "../../src/cli/setup";
import { applySetup, planSetup, validateAnswers, type AnswersFile } from "../../src/setup/headless";
import { redactStateValue } from "../../src/setup/server";
import type { PickerDeps } from "../../src/setup/pickers";
import type { SystemDeps } from "../../src/setup/system";

const GIB = 1024 ** 3;
const out = (text: string) => ({ command: [], exitCode: 0, durationMs: 1, stdout: { text, receivedBytes: text.length, capturedBytes: text.length, limitBytes: 8192, truncated: false }, stderr: { text: "", receivedBytes: 0, capturedBytes: 0, limitBytes: 1024, truncated: false }, combined: { receivedBytes: text.length, capturedBytes: text.length, limitBytes: 9216, truncated: false } });
const systemDeps: SystemDeps = {
  platform: () => "linux", arch: () => "x64", release: () => "6.8", totalmem: () => 64 * GIB, freemem: () => 32 * GIB,
  homeDir: () => "/fixture/home", env: {}, exists: () => false, statfs: () => ({ bavail: 100 * GIB, bsize: 1 }) as never,
  which: (b) => b === "nvidia-smi" ? "/usr/bin/nvidia-smi" : null,
  runCommand: (async () => out("Fixture GPU, 24576 MiB, 24576 MiB")) as never,
};
function pickerDeps(models = ["gemma4:e4b-it-qat", "gemma4:26b-a4b-it-qat"]): PickerDeps {
  return {
    env: { ANTHROPIC_API_KEY: "synthetic-anthropic-marker" }, homeDir: () => "/fixture/home", readFile: () => null,
    which: (b) => b === "hermes" ? "/usr/bin/hermes" : null, exists: () => false, probePort: async () => false,
    runCommand: (async () => out("{}")) as never,
    fetcher: (async (input: RequestInfo | URL) => String(input).includes("11434/api/tags") ? Response.json({ models: models.map((name) => ({ name })) }) : new Response("down", { status: 503 })) as typeof fetch,
  };
}
const okCheck = async () => [{ name: "config", level: "ok" as const, detail: "fine" }];
function home(): string { return mkdtempSync(join(tmpdir(), "cicero-headless-")); }

test("plan: fit-sized front desk and helper from Ollama's listing; every choice step; no secret values", async () => {
  const plan = await planSetup({ privacy: "local", systemDeps, pickerDeps: pickerDeps() });
  expect(plan.blocked).toEqual([]);
  expect(Object.keys(plan.recommended.steps)).toEqual(["privacy", "system", "accounts", "frontdesk", "helper", "stt", "tts", "brain", "board"]);
  expect(plan.recommended.steps.frontdesk).toEqual({ kind: "model", runtime: "ollama", model: "gemma4:26b-a4b-it-qat" });
  expect(plan.recommended.steps.helper).toMatchObject({ id: "model", runtime: "ollama", model: "gemma4:e4b-it-qat" });
  expect(plan.recommended.steps.board).toEqual({ id: "none" });
  expect(plan.recommended.privacy).toEqual(plan.recommended.steps.privacy as AnswersFile["privacy"]);
  expect(JSON.stringify(plan)).not.toContain("synthetic-anthropic-marker");
});

test("plan in local mode on a 4 GB card blocks the front desk and helper with the fit reason, not a runtime hint", async () => {
  const small: SystemDeps = { ...systemDeps, runCommand: (async () => out("Fixture GPU, 4096 MiB, 4096 MiB")) as never };
  const plan = await planSetup({ privacy: "local", systemDeps: small, pickerDeps: pickerDeps() });
  for (const step of ["frontdesk", "helper"]) {
    const b = plan.blocked.find((x) => x.step === step)!;
    expect(b.reason).toContain("cannot hold even Gemma 4 E2B");
    expect(b.fix).toEqual([expect.stringContaining("switch Privacy to cloud")]);
  }
  expect(plan.recommended.steps.helper).toBeUndefined();
});

test("plan redacts an exact key value even inside the recommended answers", async () => {
  const deps = pickerDeps(["gemma4:e4b-it-qat", "gemma4:26b-a4b-it-qat-synthetic-anthropic-marker"]);
  const plan = await planSetup({ privacy: "local", systemDeps, pickerDeps: deps });
  expect(JSON.stringify(plan)).not.toContain("synthetic-anthropic-marker");
  expect(redactStateValue({ id: "keep-synthetic-anthropic-marker", options: ["synthetic-anthropic-marker"] }, ["synthetic-anthropic-marker"]))
    .toEqual({ id: "keep-synthetic-anthropic-marker", options: ["synthetic-anthropic-marker"] });
});

test("apply redacts a key value echoed back by answers-file validation", async () => {
  const deps = { ...pickerDeps(), env: { OPENAI_API_KEY: "synthetic-openai-marker-1234" } };
  const plan = await planSetup({ privacy: "local", systemDeps, pickerDeps: pickerDeps() });
  const result = await applySetup({ home: "/nonexistent", answers: { ...plan.recommended, steps: { ...plan.recommended.steps, "synthetic-openai-marker-1234": {} } }, acknowledgeNotReady: false, backupInvalid: false, systemDeps, pickerDeps: deps, check: okCheck });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain("synthetic-openai-marker-1234");
});

test("plan with a CLI --agent makes that agent the front desk instead of blocking on escalation", async () => {
  const deps = { ...pickerDeps(), which: (b: string) => b === "claude" ? "/usr/bin/claude" : null };
  for (const privacy of ["cloud", "local"] as const) {
    const plan = await planSetup({ privacy, agent: "claude-code", systemDeps, pickerDeps: deps });
    expect(plan.blocked).toEqual([]);
    expect(plan.recommended.steps.frontdesk).toEqual({ kind: "agent" });
    expect(plan.recommended.steps.brain).toEqual(privacy === "local" ? { id: "claude-code", allowCloud: true } : { id: "claude-code" });
    expect(plan.reasons.frontdesk).toContain("claude-code");
  }
});

test("plan with --agent in local mode allows that agent; no runtime blocks with install steps", async () => {
  const plan = await planSetup({ privacy: "local", agent: "codex-acp", systemDeps, pickerDeps: pickerDeps() });
  expect(plan.recommended.steps.brain).toEqual({ id: "codex-acp", allowCloud: true });
  expect(plan.recommended.privacy).toEqual({ mode: "local", allow: ["agent"] });
  const empty = await planSetup({ privacy: "local", systemDeps, pickerDeps: pickerDeps([]) });
  const waiting = await planSetup({ privacy: "local", agent: "none", systemDeps, pickerDeps: pickerDeps([]) });
  const brain = waiting.blocked.find((b) => b.step === "brain")!;
  expect(brain.reason).toStartWith("Waits for the Front desk step");
  expect(brain.fix).toEqual(["Fix the frontdesk step first, then run --plan again."]);
  const front = empty.blocked.find((b) => b.step === "frontdesk")!;
  expect(front.reason).toContain("No local model runtime");
  expect(front.fix.join("\n")).toContain("ollama pull gemma4:26b-a4b-it-qat");
});

test("apply round-trips the plan into a config loadConfig accepts", async () => {
  const plan = await planSetup({ privacy: "local", systemDeps, pickerDeps: pickerDeps() });
  const dir = home();
  try {
    const result = await applySetup({ home: dir, answers: plan.recommended, acknowledgeNotReady: false, backupInvalid: false, systemDeps, pickerDeps: pickerDeps(), check: okCheck });
    expect(result).toMatchObject({ ok: true, written: join(dir, "config.yaml") });
    const config = loadConfig({}, { home: dir });
    expect(config.brain).toMatchObject({ backend: "ollama", ollama_model: "gemma4:26b-a4b-it-qat" });
    expect(config.llmBackend).toMatchObject({ backend: "openai", model: "gemma4:e4b-it-qat" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("answers validation: missing step, extra step, privacy mismatch", async () => {
  const plan = await planSetup({ privacy: "local", systemDeps, pickerDeps: pickerDeps() });
  const { helper: _helper, ...missing } = plan.recommended.steps;
  expect(() => validateAnswers({ ...plan.recommended, steps: missing })).toThrow("steps.helper is required");
  expect(() => validateAnswers({ ...plan.recommended, steps: { ...plan.recommended.steps, check: {} } })).toThrow("steps.check is not accepted");
  expect(() => validateAnswers({ ...plan.recommended, privacy: { mode: "cloud" } })).toThrow("privacy must equal steps.privacy");
  expect(() => validateAnswers({ ...plan.recommended, version: 2 })).toThrow("version must be 1");
});

test("a helper model no longer listed stops apply at the helper step and writes nothing", async () => {
  const plan = await planSetup({ privacy: "local", systemDeps, pickerDeps: pickerDeps() });
  const dir = home();
  try {
    const result = await applySetup({ home: dir, answers: plan.recommended, acknowledgeNotReady: false, backupInvalid: false, systemDeps, pickerDeps: pickerDeps(["gemma4:26b-a4b-it-qat"]), check: okCheck });
    expect(result).toMatchObject({ ok: false, step: "helper" });
    expect(existsSync(join(dir, "config.yaml"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("existing configs: a valid one is never replaced; an invalid one needs --backup-invalid", async () => {
  const plan = await planSetup({ privacy: "local", systemDeps, pickerDeps: pickerDeps() });
  const apply = (dir: string, backupInvalid: boolean) => applySetup({ home: dir, answers: plan.recommended, acknowledgeNotReady: false, backupInvalid, systemDeps, pickerDeps: pickerDeps(), check: okCheck, now: () => 1_700_000_000_000 });
  const valid = home();
  try {
    writeFileSync(join(valid, "config.yaml"), "tts_enabled: true\n");
    const before = readFileSync(join(valid, "config.yaml"));
    expect((await apply(valid, false)).error).toContain("already exists and is valid");
    expect(readFileSync(join(valid, "config.yaml"))).toEqual(before);
  } finally { rmSync(valid, { recursive: true, force: true }); }
  const invalid = home();
  try {
    writeFileSync(join(invalid, "config.yaml"), "brain: [not, valid\n");
    expect((await apply(invalid, false)).error).toContain("is invalid");
    const fixed = await apply(invalid, true);
    expect(fixed.ok).toBe(true);
    expect(fixed.backup).toBeString();
    expect(existsSync(fixed.backup!)).toBe(true);
  } finally { rmSync(invalid, { recursive: true, force: true }); }
});

test("not-ready engines need --acknowledge-not-ready", async () => {
  const plan = await planSetup({ privacy: "local", systemDeps, pickerDeps: pickerDeps() });
  const notReady = async () => [{ name: "stt (faster-whisper)", level: "fail" as const, detail: "venv missing", hint: "uv venv" }];
  const dir = home();
  try {
    const refused = await applySetup({ home: dir, answers: plan.recommended, acknowledgeNotReady: false, backupInvalid: false, systemDeps, pickerDeps: pickerDeps(), check: notReady });
    expect(refused).toMatchObject({ ok: false, error: "Acknowledge that runtime components are not ready yet before writing" });
    expect(existsSync(join(dir, "config.yaml"))).toBe(false);
    expect((await applySetup({ home: dir, answers: plan.recommended, acknowledgeNotReady: true, backupInvalid: false, systemDeps, pickerDeps: pickerDeps(), check: notReady })).ok).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI usage errors never start the server", async () => {
  await expect(runSetup({ plan: true, privacy: "local" })).rejects.toThrow(SetupUsageError);
  await expect(runSetup({ plan: true, json: true })).rejects.toThrow("--privacy");
  await expect(runSetup({ plan: true, test: true, json: true, privacy: "local" })).rejects.toThrow("mutually exclusive");
  await expect(runSetup({ test: true })).rejects.toThrow("--test requires --json");
  await expect(runSetup({ json: true })).rejects.toThrow("--json needs");
  await expect(runSetup({ apply: "/nonexistent/answers.json" })).rejects.toThrow("Cannot read");
});
