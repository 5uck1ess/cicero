import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { createDraft, renderDraft, type SetupDraft } from "../../src/setup/draft";
import { chosenFitWarnings, contributeHelper, detectHelper, gemmaOf, parseHelper, probeHelper, type HelperDetected } from "../../src/setup/helper";
import { detectFrontDesk, parseFrontDesk } from "../../src/setup/frontdesk";
import type { RuntimeId, RuntimeListing } from "../../src/setup/runtimes";
import { SetupSession } from "../../src/setup/session";
import type { StepContext } from "../../src/setup/steps";
import { fixtureSystem } from "./fixtures";

const listing = (id: RuntimeId, models: string[], running = true): RuntimeListing => ({ id, running, baseUrl: "", models, singleModel: running && models.length === 1, installed: running });
const runtimes = (over: Partial<Record<RuntimeId, RuntimeListing>> = {}) => ({ "llama-cpp": listing("llama-cpp", [], false), ollama: listing("ollama", [], false), "lm-studio": listing("lm-studio", [], false), ...over });
const ctx = (mode: "local" | "cloud", choices: [string, unknown][] = [], detected?: unknown, system = fixtureSystem("cuda24")): StepContext => ({
  system, draft: { ...createDraft("local-cuda", "x".repeat(64)), privacy: { mode } },
  choices: new Map<string, unknown>([["privacy", { mode }], ...choices]), ...(detected ? { detected } : {}),
});
const cloudFront: [string, unknown] = ["frontdesk", { kind: "model", runtime: "cloud", preset: "xai", model: "grok-fast" }];
const ollamaFetcher = (models: string[]) => (async (input: RequestInfo | URL) => String(input).includes("11434") ? Response.json({ models: models.map((name) => ({ name })) }) : new Response("down", { status: 503 })) as typeof fetch;

function loadDraft(draft: SetupDraft) {
  const home = mkdtempSync(join(tmpdir(), "cicero-helper-"));
  try { writeFileSync(join(home, "config.yaml"), renderDraft(draft)); return loadConfig({}, { home }); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

test("a helper writes the summarizer, an explicit llm and optional compaction; never switchboard", () => {
  const written = contributeHelper(ctx("local"), { id: "model", runtime: "ollama", model: "gemma4:e4b-it-qat", gemma: "e4b", compact: true });
  expect(written).toEqual({
    web_voice: { tldr: { summarizer_url: "http://127.0.0.1:11434/v1", summarizer_model: "gemma4:e4b-it-qat" } },
    llm: { backend: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e4b-it-qat" },
    brain: { history_compaction: { enabled: true } },
  });
  const plain = contributeHelper(ctx("local"), { id: "model", runtime: "llama-cpp", model: "gemma-4-e4b", gemma: "e4b", compact: false });
  expect(plain.brain).toBeUndefined();
  expect(JSON.stringify([written, plain])).not.toContain("switchboard");
});

test("no helper: only with a cloud model front desk in cloud mode; llm names the key variable, not the key", () => {
  expect(() => parseHelper({ id: "none" }, ctx("local", [cloudFront]))).toThrow("Local mode needs a local helper");
  expect(() => parseHelper({ id: "none" }, ctx("cloud", [["frontdesk", { kind: "agent" }]]))).toThrow("A no-helper setup needs a model front desk");
  expect(() => parseHelper({ id: "none" }, ctx("cloud", [["frontdesk", { kind: "model", runtime: "ollama", model: "m" }]]))).toThrow("A no-helper setup needs a model front desk");
  expect(parseHelper({ id: "none" }, ctx("cloud", [cloudFront]))).toEqual({ id: "none" });
  expect(contributeHelper(ctx("cloud", [cloudFront]), { id: "none" })).toEqual({ llm: { backend: "openai", baseUrl: "https://api.x.ai/v1", model: "grok-fast", apiKeyEnv: "XAI_API_KEY" } });
  expect(() => parseHelper({ id: "laya" }, ctx("cloud", [cloudFront]))).toThrow("Laya is not available");
});

test("parse: listed models only, bounded input, compact defaults on, single-model runtimes share one model", () => {
  const detected = { runtimes: runtimes({ "lm-studio": listing("lm-studio", ["gemma-4-26b-a4b"]), ollama: listing("ollama", ["gemma4:e4b-it-qat", "gemma4:26b-a4b-it-qat"]) }) } as unknown as HelperDetected;
  expect(parseHelper({ id: "model", runtime: "ollama", model: "gemma4:e4b-it-qat" }, ctx("local", [], detected))).toEqual({ id: "model", runtime: "ollama", model: "gemma4:e4b-it-qat", gemma: "e4b", compact: true });
  expect(parseHelper({ id: "model", runtime: "ollama", model: "gemma4:e4b-it-qat", compact: false }, ctx("local", [], detected)).compact).toBe(false);
  expect(() => parseHelper({ id: "model", runtime: "ollama", model: "gone" }, ctx("local", [], detected))).toThrow("Start the runtime, load a model, and Re-check before choosing it");
  expect(() => parseHelper({ id: "model", runtime: "ollama", model: "gemma4:e4b-it-qat", compact: "yes" }, ctx("local", [], detected))).toThrow();
  for (const bad of [null, [], { id: "x" }, { id: "model", runtime: "mlx-lm", model: "m" }, { id: "model", runtime: "ollama", model: "a\nb" }]) expect(() => parseHelper(bad, ctx("local", [], detected))).toThrow();
  const single = { runtimes: runtimes({ "llama-cpp": listing("llama-cpp", ["only.gguf"]) }) } as unknown as HelperDetected;
  const front: [string, unknown] = ["frontdesk", { kind: "model", runtime: "llama-cpp", model: "other.gguf" }];
  expect(() => parseHelper({ id: "model", runtime: "llama-cpp", model: "only.gguf" }, ctx("local", [front], single))).toThrow(/serves one model here.*llama-swap or Ollama/);
  expect(parseHelper({ id: "model", runtime: "llama-cpp", model: "only.gguf" }, ctx("local", [["frontdesk", { kind: "model", runtime: "llama-cpp", model: "only.gguf" }]], single)).model).toBe("only.gguf");
  expect(gemmaOf("gemma4:26b-a4b-it-qat")).toBe("26b-a4b");
  expect(gemmaOf("qwen3.5:0.8b")).toBeNull();
});

test("probe fails when the model disappeared from the listing (Review Focus 3)", async () => {
  const choice = { id: "model", runtime: "ollama", model: "gemma4:e4b-it-qat", gemma: "e4b", compact: true } as const;
  expect((await probeHelper(choice, { which: () => null, fetcher: ollamaFetcher(["gemma4:e4b-it-qat"]) })).ok).toBe(true);
  expect(await probeHelper(choice, { which: () => null, fetcher: ollamaFetcher(["other"]) })).toEqual({ ok: false, message: "Ollama does not list gemma4:e4b-it-qat; load it and try again" });
  expect((await probeHelper({ id: "none" })).message).toContain("say details");
});

test("recommend: fit helper when listed; none only for a cloud front desk that has no local option; CPU is not sized", async () => {
  const deps = { which: () => null, fetcher: ollamaFetcher(["gemma4:e4b-it-qat", "gemma4:26b-a4b-it-qat"]) };
  const local = await detectHelper(ctx("local"), deps, "audiocpp");
  expect(local.recommended).toEqual({ id: "model", runtime: "ollama", model: "gemma4:e4b-it-qat", gemma: "e4b", compact: true });
  expect(local.disabled.none).toBe("Local mode needs a local helper");
  expect(local.disabled.laya).toContain("brain.lanes");
  const downDeps = { which: () => null, fetcher: ollamaFetcher([]) };
  expect((await detectHelper(ctx("cloud", [cloudFront]), { ...downDeps, fetcher: (async () => new Response("down", { status: 503 })) as typeof fetch }, "audiocpp")).recommended).toEqual({ id: "none" });
  expect((await detectHelper(ctx("cloud", [cloudFront]), deps, "audiocpp")).recommended?.id).toBe("model");
  const cpu = await detectHelper(ctx("local", [], undefined, fixtureSystem("cpu")), { which: () => null, fetcher: (async () => new Response("down", { status: 503 })) as typeof fetch }, "python");
  expect(cpu.fit).toBeNull();
  expect(cpu.recommended).toBeNull();
  expect(cpu.reason).toContain("Not sized for this machine");
  expect(cpu.reason).toContain("ollama pull qwen3.5:0.8b");
  const cpuRunning = await detectHelper(ctx("local", [], undefined, fixtureSystem("cpu")), { which: () => null, fetcher: ollamaFetcher(["qwen3.5:0.8b"]) }, "python");
  expect(cpuRunning.recommended).toMatchObject({ runtime: "ollama", model: "qwen3.5:0.8b" });
  expect(cpuRunning.reason).toContain("Not sized for this machine");
});

test("fit warnings appear when the chosen models outgrow the budget for a heavier speech stack", () => {
  const helper = { id: "model", runtime: "ollama", model: "gemma4:e4b-it-qat", gemma: "e4b", compact: true };
  const front = { kind: "model", runtime: "ollama", model: "gemma4:26b-a4b-it-qat" };
  const fits = ctx("local", [["helper", helper], ["frontdesk", front]]);
  expect(chosenFitWarnings(fits, "python")).toEqual([]);
  const tight = ctx("local", [["helper", helper], ["frontdesk", front]], undefined, fixtureSystem("cuda16"));
  expect(chosenFitWarnings(tight, "audiocpp")[0]).toMatch(/no longer fit/);
});

test("an explicit llm stops the CUDA tier from adding llama-server on :8080, through the real session", async () => {
  const s = new SetupSession(fixtureSystem("cuda24"));
  const deps = { which: () => null, fetcher: ollamaFetcher(["gemma4:e4b-it-qat", "gemma4:26b-a4b-it-qat"]) };
  await s.choose("privacy", { mode: "local" }, { probe: false });
  const fd = await s.detect("frontdesk", deps);
  expect((await s.choose("frontdesk", { kind: "model", runtime: "ollama", model: "gemma4:26b-a4b-it-qat" }, { deps, detected: fd, probe: true })).accepted).toBe(true);
  const hd = await s.detect("helper", deps);
  expect((await s.choose("helper", { id: "model", runtime: "ollama", model: "gemma4:e4b-it-qat" }, { deps, detected: hd, probe: true })).accepted).toBe(true);
  const config = loadDraft(s.draft);
  expect(config.llmBackend).toEqual({ backend: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e4b-it-qat" });
  expect(config.brain).toMatchObject({ backend: "ollama", ollama_model: "gemma4:26b-a4b-it-qat", history_compaction: { enabled: true } });
  expect(config.web_voice.tldr).toMatchObject({ summarizer_url: "http://127.0.0.1:11434/v1", summarizer_model: "gemma4:e4b-it-qat" });
  expect(renderDraft(s.draft)).not.toContain("switchboard");
});

test("switching Privacy to local clears a no-helper choice and the cloud front desk", async () => {
  const s = new SetupSession(fixtureSystem("cuda24"), undefined, { env: { XAI_API_KEY: "synthetic-marker" }, which: () => null, readFile: () => null, homeDir: () => "/fixture/home" });
  await s.choose("privacy", { mode: "cloud" }, { probe: false });
  await s.choose("frontdesk", cloudFront[1], { probe: false });
  await s.choose("helper", { id: "none" }, { probe: false });
  expect(loadDraft(s.draft).llmBackend).toMatchObject({ backend: "openai", apiKeyEnv: "XAI_API_KEY" });
  const flipped = await s.choose("privacy", { mode: "local" }, { probe: false });
  expect(flipped.invalidated.map((i) => i.id)).toEqual(["frontdesk", "helper"]);
  expect(s.draft.llm).toBeUndefined();
});

test("choosing audio.cpp speech later shrinks the budget below E2B: the helper choice is invalidated", async () => {
  const s = new SetupSession(fixtureSystem("cuda6"));
  const deps = { which: () => null, fetcher: ollamaFetcher(["gemma4:e2b-it-qat"]) };
  await s.choose("privacy", { mode: "local" }, { probe: false });
  await s.choose("frontdesk", { kind: "agent" }, { probe: false });
  await s.choose("stt", { id: "faster-whisper" }, { probe: false });
  await s.choose("tts", { id: "kokoro" }, { probe: false });
  const hd = await s.detect("helper", deps);
  expect((await s.choose("helper", { id: "model", runtime: "ollama", model: "gemma4:e2b-it-qat" }, { deps, detected: hd, probe: false })).accepted).toBe(true);
  await s.choose("stt", { id: "audiocpp" }, { probe: false });
  const flipped = await s.choose("tts", { id: "audiocpp" }, { probe: false });
  expect(flipped.invalidated).toEqual([{ id: "helper", reason: expect.stringContaining("cannot hold even Gemma 4 E2B") }]);
  expect(s.draft.llm).toBeUndefined();
});

test("stored models that outgrow the budget after a speech change are warned about by Check, not only on the Helper step", async () => {
  const s = new SetupSession(fixtureSystem("cuda16"));
  const deps = { which: () => null, env: {}, readFile: () => null, homeDir: () => "/fixture/home", fetcher: ollamaFetcher(["gemma4:e4b-it-qat", "gemma4:12b-it-qat"]) };
  await s.choose("privacy", { mode: "local" }, { probe: false });
  await s.choose("stt", { id: "faster-whisper" }, { probe: false });
  await s.choose("tts", { id: "kokoro" }, { probe: false });
  const fd = await s.detect("frontdesk", deps);
  expect((await s.choose("frontdesk", { kind: "model", runtime: "ollama", model: "gemma4:12b-it-qat" }, { deps, detected: fd, probe: false })).accepted).toBe(true);
  const hd = await s.detect("helper", deps);
  expect((await s.choose("helper", { id: "model", runtime: "ollama", model: "gemma4:e4b-it-qat" }, { deps, detected: hd, probe: false })).accepted).toBe(true);
  const ok = async () => [{ name: "config", level: "ok" as const, detail: "fine" }];
  expect((await s.check(ok)).filter((c) => c.level === "warn")).toEqual([]);
  await s.choose("stt", { id: "audiocpp" }, { probe: false });
  await s.choose("tts", { id: "audiocpp" }, { probe: false });
  const warned = (await s.check(ok)).filter((c) => c.level === "warn");
  expect(warned).toEqual([{ name: "memory fit", level: "warn", detail: expect.stringContaining("no longer fit") }]);
});

test("local mode on a machine too small for E2B: no helper recommended, a listed model is refused with the fit reason", async () => {
  const detected = await detectHelper(ctx("local", [], undefined, fixtureSystem("cuda4")), { fetcher: ollamaFetcher(["gemma4:e4b-it-qat"]) }, "python");
  expect(detected.fit?.localHelperImpossible).toBe(true);
  expect(detected.recommended).toBeNull();
  expect(detected.reason).toContain("cannot hold even Gemma 4 E2B");
  expect(detected.disabled.model).toContain("switch Privacy to cloud");
  expect(() => parseHelper({ id: "model", runtime: "ollama", model: "gemma4:e4b-it-qat" }, ctx("local", [], detected, fixtureSystem("cuda4")))).toThrow("cannot hold even Gemma 4 E2B");
});

test("cloud mode on a sized machine where nothing fits: no listed model is recommended for the helper or front desk", async () => {
  const deps = { ...{ env: {}, which: () => null, readFile: () => null, homeDir: () => "/fixture/home" }, fetcher: ollamaFetcher(["gemma4:31b-it-qat"]) };
  const c = ctx("cloud", [], undefined, fixtureSystem("cuda4"));
  const helper = await detectHelper(c, deps, "python");
  expect(helper.recommended).toBeNull();
  expect(helper.reason).toContain("cannot hold a local helper");
  const front = await detectFrontDesk(c, deps, "python");
  expect(front.recommended).toBeNull();
  expect(front.reason).toContain("cannot hold a local helper");
});

test("a listed Gemma larger than the whole model budget is refused as front desk and helper, in both modes", async () => {
  const deps = { env: {}, which: () => null, readFile: () => null, homeDir: () => "/fixture/home", fetcher: ollamaFetcher(["gemma4:31b-it-qat"]) };
  for (const mode of ["local", "cloud"] as const) {
    const c = ctx(mode, [], undefined, fixtureSystem("cuda16"));
    const fd = await detectFrontDesk(c, deps, "python");
    expect(() => parseFrontDesk({ kind: "model", runtime: "ollama", model: "gemma4:31b-it-qat" }, { ...c, detected: fd })).toThrow("does not fit this machine");
    const hd = await detectHelper(c, deps, "python");
    expect(() => parseHelper({ id: "model", runtime: "ollama", model: "gemma4:31b-it-qat" }, { ...c, detected: hd })).toThrow("does not fit this machine");
  }
});

test("install hints name the fit helper for each runtime that does not list it", async () => {
  const detected = await detectHelper(ctx("local"), { which: () => null, fetcher: ollamaFetcher(["gemma4:26b-a4b-it-qat"]) }, "audiocpp");
  expect(detected.install.map((i) => i.runtime)).toEqual(["llama-cpp", "ollama", "lm-studio"]);
  expect(detected.install.find((i) => i.runtime === "ollama")?.hint).toBe("ollama pull gemma4:e4b-it-qat");
  expect(detected.install.find((i) => i.runtime === "llama-cpp")?.entry).toContain("gemma-4-E4B");
  const listed = await detectHelper(ctx("local"), { which: () => null, fetcher: ollamaFetcher(["gemma4:e4b-it-qat"]) }, "audiocpp");
  expect(listed.install.map((i) => i.runtime)).toEqual(["llama-cpp", "lm-studio"]);
});
