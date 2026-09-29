import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { createDraft, renderDraft } from "../../src/setup/draft";
import { contributeFrontDesk, detectFrontDesk, parseFrontDesk, probeFrontDesk, recommendLocal, type FrontDeskDetected } from "../../src/setup/frontdesk";
import { GEMMA_MODELS } from "../../src/setup/fit";
import { installHint, listRuntimes, llamaSwapEntry, suggestListedModel, type RuntimeId, type RuntimeListing } from "../../src/setup/runtimes";
import { mergeDraft } from "../../src/setup/session";
import { startSetupServer } from "../../src/setup/server";
import { SETUP_STEPS, type StepContext } from "../../src/setup/steps";
import { fixtureSystem } from "./fixtures";

const byId = (id: string) => GEMMA_MODELS.find((m) => m.id === id)!;
const down = (async () => new Response("down", { status: 503 })) as typeof fetch;
const ctx = (mode: "local" | "cloud" = "local", extra: Partial<StepContext> = {}): StepContext => ({
  system: fixtureSystem("cuda24"), draft: { ...createDraft("local-cuda", "x".repeat(64)), privacy: { mode } },
  choices: new Map<string, unknown>([["privacy", { mode, allow: [] }]]), ...extra,
});
const listing = (id: RuntimeId, models: string[], running = true): RuntimeListing => ({ id, running, baseUrl: "", models, singleModel: running && models.length === 1, installed: running });
const runtimes = (over: Partial<Record<RuntimeId, RuntimeListing>> = {}) => ({ "llama-cpp": listing("llama-cpp", [], false), ollama: listing("ollama", [], false), "lm-studio": listing("lm-studio", [], false), ...over });
const noAccounts = { env: {}, which: () => null, readFile: () => null, homeDir: () => "/fixture/home" };

test("runtime listing: parallel probes, llama-swap vs bare llama-server, Ollama tags, bounded lists", async () => {
  const seen: string[] = []; let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const pending = listRuntimes({ which: () => null, fetcher: (async (input: RequestInfo | URL) => {
    seen.push(String(input)); await gate;
    if (String(input).includes("11434")) return Response.json({ models: [{ name: "gemma4:e4b-it-qat" }] });
    if (String(input).includes("8080")) return Response.json({ data: [{ id: "gemma-4-e4b" }, { id: "gemma-4-26b-a4b" }] });
    return Response.json({ data: [{ id: "loaded" }] });
  }) as typeof fetch });
  await Promise.resolve(); expect(seen).toHaveLength(3); release();
  const up = await pending;
  expect(up["llama-cpp"]).toMatchObject({ running: true, singleModel: false, baseUrl: "http://127.0.0.1:8080/v1" });
  expect(up.ollama).toMatchObject({ running: true, models: ["gemma4:e4b-it-qat"], singleModel: true, baseUrl: "http://127.0.0.1:11434/v1" });
  expect(up["lm-studio"].models).toEqual(["loaded"]);
  const bare = await listRuntimes({ which: () => null, fetcher: (async (input: RequestInfo | URL) => String(input).includes("8080") ? Response.json({ data: [{ id: "model.gguf" }] }) : new Response("down", { status: 503 })) as typeof fetch });
  expect(bare["llama-cpp"].singleModel).toBe(true);
  expect(bare.ollama).toMatchObject({ running: false, installed: false });
  expect((await listRuntimes({ which: (b) => b === "ollama" ? "/usr/bin/ollama" : null, fetcher: down })).ollama.installed).toBe(true);
  expect((await listRuntimes({ which: () => null, fetcher: (async () => new Response("{")) as typeof fetch })).ollama.running).toBe(false);
  expect((await listRuntimes({ which: () => null, fetcher: (async () => new Response(JSON.stringify({ models: Array(201).fill({ name: "m" }), data: Array(201).fill({ id: "m" }) }))) as typeof fetch })).ollama.models).toHaveLength(200);
  expect((await listRuntimes({ which: () => null, fetcher: (async () => new Response("x".repeat(140000))) as typeof fetch })).ollama.running).toBe(false);
});

test("listed models are matched to a Gemma size without confusing sizes", () => {
  expect(suggestListedModel(["gemma4:e4b-it-qat", "qwen"], byId("e4b"))).toBe("gemma4:e4b-it-qat");
  expect(suggestListedModel(["gemma-4-26b-a4b"], byId("26b-a4b"))).toBe("gemma-4-26b-a4b");
  expect(suggestListedModel(["gemma-4-e4b"], byId("e2b"))).toBeNull();
  expect(suggestListedModel(["gemma-4-12b"], byId("e2b"))).toBeNull();
  expect(suggestListedModel(["gemma-3-e4b"], byId("e4b"))).toBeNull();
  expect(installHint("ollama", byId("e4b"))).toBe("ollama pull gemma4:e4b-it-qat");
  expect(llamaSwapEntry(byId("e4b"))).toContain("-hf google/gemma-4-E4B-it-qat-q4_0-gguf --host 127.0.0.1 -c 65536 -fa on -ctk q8_0 -ctv q8_0 -ngl 99");
});

test("contributions: each runtime writes brain; an agent front desk writes nothing; cloud writes no key", () => {
  expect(contributeFrontDesk({ kind: "model", runtime: "ollama", model: "gemma4:e4b-it-qat" })).toEqual({ brain: { backend: "ollama", mode: "subprocess", ollama_model: "gemma4:e4b-it-qat" } });
  expect(contributeFrontDesk({ kind: "model", runtime: "llama-cpp", model: "gemma-4-e4b" })).toEqual({ brain: { backend: "openai-compatible", mode: "subprocess", base_url: "http://127.0.0.1:8080/v1", model: "gemma-4-e4b" } });
  expect(contributeFrontDesk({ kind: "model", runtime: "lm-studio", model: "m" })).toEqual({ brain: { backend: "openai-compatible", mode: "subprocess", base_url: "http://127.0.0.1:1234/v1", model: "m" } });
  expect(contributeFrontDesk({ kind: "model", runtime: "cloud", preset: "xai", model: "grok-fast" })).toEqual({ brain: { backend: "xai", mode: "subprocess", model: "grok-fast" } });
  expect(contributeFrontDesk({ kind: "agent" })).toEqual({});
});

test("parse: local privacy rejects cloud, listings gate local models, keys gate cloud presets", () => {
  const detected = { runtimes: runtimes({ ollama: listing("ollama", ["pulled"]) }), cloudKeys: { xai: "found", groq: "not found" } } as unknown as FrontDeskDetected;
  expect(() => parseFrontDesk({ kind: "model", runtime: "cloud", preset: "xai", model: "g" }, ctx("local", { detected }))).toThrow("Privacy is local: the front desk must run on this machine");
  expect(parseFrontDesk({ kind: "model", runtime: "cloud", preset: "xai", model: "g" }, ctx("cloud", { detected }))).toEqual({ kind: "model", runtime: "cloud", preset: "xai", model: "g" });
  expect(() => parseFrontDesk({ kind: "model", runtime: "cloud", preset: "groq", model: "g" }, ctx("cloud", { detected }))).toThrow("GROQ_API_KEY");
  expect(() => parseFrontDesk({ kind: "model", runtime: "cloud", preset: "xai", model: "g" }, ctx("cloud", { detected }), { allowedModels: { id: "xai", baseUrl: "", models: ["other"] } })).toThrow("List models");
  expect(() => parseFrontDesk({ kind: "model", runtime: "cloud", preset: "openai-compatible", model: "g" }, ctx("cloud"))).toThrow();
  expect(() => parseFrontDesk({ kind: "model", runtime: "ollama", model: "not-pulled" }, ctx("local", { detected }))).toThrow("Start the runtime, load a model, and Re-check before choosing it");
  expect(parseFrontDesk({ kind: "model", runtime: "ollama", model: "pulled" }, ctx("local", { detected }))).toEqual({ kind: "model", runtime: "ollama", model: "pulled" });
  expect(() => parseFrontDesk({ kind: "model", runtime: "mlx-lm", model: "m" }, ctx())).toThrow("Choose a local model runtime");
  for (const bad of [null, [], "agent", { kind: "x" }, { kind: "model", runtime: "ollama", model: "a\nb" }, { kind: "model", runtime: "ollama", model: "x".repeat(201) }]) expect(() => parseFrontDesk(bad, ctx())).toThrow();
  expect(parseFrontDesk({ kind: "agent" }, ctx())).toEqual({ kind: "agent" });
  const noHelper = ctx("cloud"); (noHelper.choices as Map<string, unknown>).set("helper", { id: "none" });
  expect(() => parseFrontDesk({ kind: "agent" }, noHelper)).toThrow("A no-helper setup needs a model front desk");
});

test("recommend: the fit plan's front desk when listed, else reuse the helper's model with the pull command", () => {
  const listedBoth = recommendLocal(runtimes({ ollama: listing("ollama", ["gemma4:e4b-it-qat", "gemma4:26b-a4b-it-qat"]) }), byId("26b-a4b"), byId("e4b"));
  expect(listedBoth.choice).toEqual({ runtime: "ollama", model: "gemma4:26b-a4b-it-qat" });
  const reuse = recommendLocal(runtimes({ ollama: listing("ollama", ["gemma4:e4b-it-qat"]) }), byId("26b-a4b"), byId("e4b"));
  expect(reuse.choice).toEqual({ runtime: "ollama", model: "gemma4:e4b-it-qat" });
  expect(reuse.reason).toContain("ollama pull gemma4:26b-a4b-it-qat");
  expect(recommendLocal(runtimes(), byId("26b-a4b"), byId("e4b"))).toEqual({ choice: null, reason: expect.stringContaining("No local model runtime") });
  const unsized = recommendLocal(runtimes({ "lm-studio": listing("lm-studio", ["qwen3.5:0.8b"]) }), null, null);
  expect(unsized.choice).toEqual({ runtime: "lm-studio", model: "qwen3.5:0.8b" });
  expect(unsized.reason).toContain("Not sized for this machine");
});

test("detection: local mode disables cloud and lists install steps; cloud mode prefers a found key", async () => {
  const fetcher = (async (input: RequestInfo | URL) => String(input).includes("11434") ? Response.json({ models: [{ name: "gemma4:e4b-it-qat" }] }) : new Response("down", { status: 503 })) as typeof fetch;
  const local = await detectFrontDesk(ctx("local"), { ...noAccounts, fetcher }, "audiocpp");
  expect(local.disabled.cloud).toContain("Privacy is local");
  expect(local.fit?.frontDesk?.id).toBe("26b-a4b");
  expect(local.recommended).toEqual({ kind: "model", runtime: "ollama", model: "gemma4:e4b-it-qat" });
  expect(local.install.find((i) => i.runtime === "llama-cpp")?.entry).toContain("gemma-4-26b-a4b");
  const cloud = await detectFrontDesk(ctx("cloud"), { ...noAccounts, env: { XAI_API_KEY: "synthetic-marker" }, fetcher }, "audiocpp");
  expect(cloud.disabled).toEqual({});
  expect(cloud.cloudKeys.xai).toBe("found");
  expect(cloud.cloudSuggestion).toBe("xai");
  expect(local.cloudSuggestion).toBeNull();
  expect(JSON.stringify(cloud)).not.toContain("synthetic-marker");
});

test("probe re-lists: a model that went away or a runtime that stopped is refused", async () => {
  const fetcher = (async (input: RequestInfo | URL) => String(input).includes("11434") ? Response.json({ models: [{ name: "pulled" }] }) : new Response("down", { status: 503 })) as typeof fetch;
  expect((await probeFrontDesk({ kind: "model", runtime: "ollama", model: "pulled" }, { which: () => null, fetcher })).ok).toBe(true);
  expect((await probeFrontDesk({ kind: "model", runtime: "ollama", model: "gone" }, { which: () => null, fetcher })).ok).toBe(false);
  expect((await probeFrontDesk({ kind: "model", runtime: "llama-cpp", model: "m" }, { which: () => null, fetcher })).message).toContain("not running");
  const cloud = await probeFrontDesk({ kind: "model", runtime: "cloud", preset: "xai", model: "grok-fast" }, { env: { XAI_API_KEY: "synthetic-marker" }, fetcher: (async (_i: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-marker");
    return Response.json({ data: [{ id: "grok-fast" }] });
  }) as typeof fetch });
  expect(cloud).toEqual({ ok: true, message: "xai serves grok-fast" });
  expect((await probeFrontDesk({ kind: "agent" })).ok).toBe(true);
});

test("cloud model listing uses the preset's env key only when Privacy is cloud, and never echoes it", async () => {
  let handler: (req: Request) => Response | Promise<Response> = () => new Response();
  const serve = ((opts: { fetch: typeof handler }) => { handler = opts.fetch; return { port: 9999, stop() {} }; }) as unknown as typeof Bun.serve;
  const auth: (string | null)[] = [];
  const home = mkdtempSync(join(tmpdir(), "cicero-frontdesk-server-"));
  const server = await startSetupServer({ home, serve, output: () => {},
    systemDeps: { platform: () => "linux", arch: () => "x64", release: () => "6.8", which: () => null, exists: () => true, statfs: () => ({ bavail: 1, bsize: 1 }) as ReturnType<typeof import("node:fs")["statfsSync"]> },
    pickerDeps: { ...noAccounts, env: { XAI_API_KEY: "synthetic-marker" }, fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("api.x.ai")) return new Response("down", { status: 503 });
      auth.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ data: [{ id: "grok-fast" }] });
    }) as typeof fetch } });
  try {
    const send = (path: string, body?: object) => handler(new Request(`http://127.0.0.1:9999${path}`, { method: body ? "POST" : "GET", headers: { host: "127.0.0.1:9999", "x-cicero-setup-token": server.token, ...(body ? { "x-cicero-setup-csrf": "1" } : {}) }, body: body ? JSON.stringify(body) : undefined }));
    await send("/api/step", { id: "privacy" });
    await send("/api/choice", { id: "privacy", choice: { mode: "local" } });
    await send("/api/provider-models", { choice: { id: "xai" } });
    expect(auth).toEqual([null]);
    await send("/api/choice", { id: "privacy", choice: { mode: "cloud" } });
    const listed = await send("/api/provider-models", { choice: { id: "xai" } });
    expect(await listed.text()).not.toContain("synthetic-marker");
    expect(auth.at(-1)).toBe("Bearer synthetic-marker");
    await send("/api/step", { id: "frontdesk" });
    const chosen = await send("/api/choice", { id: "frontdesk", choice: { kind: "model", runtime: "cloud", preset: "xai", model: "grok-fast" } });
    const body = await chosen.text();
    expect(chosen.status).toBe(200);
    expect(body).not.toContain("synthetic-marker");
    expect((JSON.parse(body) as { selectedChoices: Record<string, string> }).selectedChoices.frontdesk).toBe("xai: grok-fast");
  } finally { await server.stop(); rmSync(home, { recursive: true, force: true }); }
});

test("a model front desk round-trips through loadConfig", () => {
  const step = SETUP_STEPS.find((s) => s.id === "frontdesk")!;
  const c = ctx("local", { detected: { runtimes: runtimes({ ollama: listing("ollama", ["gemma4:e4b-it-qat"]) }) } });
  const draft = mergeDraft(c.draft, step.contribute(c, step.parseChoice({ kind: "model", runtime: "ollama", model: "gemma4:e4b-it-qat" }, c)));
  const home = mkdtempSync(join(tmpdir(), "cicero-frontdesk-"));
  try {
    writeFileSync(join(home, "config.yaml"), renderDraft(draft));
    const loaded = loadConfig({}, { home });
    expect(loaded.brain).toMatchObject({ backend: "ollama", ollama_model: "gemma4:e4b-it-qat" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
