import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { BOARD_COMMANDS } from "../../src/notify/board-presets";
import type { BoundedCommandResult } from "../../src/process/bounded-command";
import { createDraft, renderDraft } from "../../src/setup/draft";
import { mergeDraft, startSetupServer } from "../../src/setup/server";
import { SETUP_STEPS, type StepContext } from "../../src/setup/steps";
import { detectProvider, detectBrain, detectBoard, detectSpeech, parseProvider, parseBrain, parseBoard, parseSpeech, contributeBoard, probeBoard, probeRemoteProviderModels } from "../../src/setup/pickers";
import type { SystemFacts } from "../../src/setup/system";

const facts = (platform = "linux", gpu = false): SystemFacts => ({ platform, arch: platform === "darwin" ? "arm64" : "x64", release: platform === "darwin" ? "23.0.0" : "6.8", appleSilicon: platform === "darwin", mlxSupported: platform === "darwin", ramTotalBytes: 32e9, ramFreeBytes: 16e9, disks: { checkout: { path: "/repo", freeBytes: 1e9 }, huggingface: { path: "/hf", freeBytes: 1e9 } }, gpu: gpu ? { status: "ok", name: "NVIDIA", freeMiB: 16000, totalMiB: 24000, doctorDetail: "NVIDIA" } : { status: "absent" }, recommendedTier: platform === "darwin" ? "local-mlx" : gpu ? "local-cuda" : "local-cpu", reason: "fixture" });
const ctx = (platform = "linux", gpu = false): StepContext => ({ system: facts(platform, gpu), draft: createDraft(platform === "darwin" ? "local-mlx" : gpu ? "local-cuda" : "local-cpu", "x".repeat(64)) });
const command = (stdout: string, exitCode = 0): BoundedCommandResult => { const out = { text: stdout, receivedBytes: stdout.length, capturedBytes: stdout.length, limitBytes: 262144, truncated: false }; return { command: [], exitCode, durationMs: 1, stdout: out, stderr: { ...out, text: "" }, combined: { receivedBytes: stdout.length, capturedBytes: stdout.length, limitBytes: 266240, truncated: false } }; };
const pick = (id: string) => SETUP_STEPS.find((s) => s.id === id)!;

test("each picker parses valid input and rejects malformed input", () => {
  const c = ctx();
  expect(pick("system").parseChoice("local-cpu", c)).toBe("local-cpu");
  expect(() => pick("system").parseChoice("bad", c)).toThrow();
  expect(parseProvider({ id: "llama-cpp", model: "owner/repo:Q4_K_M" }, c).model).toBe("owner/repo:Q4_K_M");
  expect(parseProvider({ id: "llama-cpp" }, c).model).toContain("GGUF");
  const fileHome = mkdtempSync(join(tmpdir(), "cicero-gguf-"));
  try { const path = join(fileHome, "local.gguf"); writeFileSync(path, "fixture"); expect(parseProvider({ id: "llama-cpp", model: path }, c).model).toBe(path); }
  finally { rmSync(fileHome, { recursive: true, force: true }); }
  for (const bad of ["repo", "owner/repo;rm", "owner/repo:bad:extra", "a/../b", "x".repeat(210)]) expect(() => parseProvider({ id: "llama-cpp", model: bad }, c)).toThrow();
  expect(parseProvider({ id: "openai-compatible", baseUrl: "https://example.test/v1", model: "m", apiKey: "synthetic-key" }, c).apiKey).toBe("synthetic-key");
  for (const bad of ["file:///tmp", "https://u:p@example.test/v1", "https://example.test/v1?key=secret", "x".repeat(513)]) expect(() => parseProvider({ id: "openai-compatible", baseUrl: bad, model: "m" }, c)).toThrow();
  expect(() => parseProvider({ id: "ollama", model: "not-pulled" }, { ...c, detected: { runtimes: { ollama: { running: true, models: ["pulled"] } } } })).toThrow();
  expect(parseBrain({ id: "acp", command: ["hermes", "-p", "voice", "acp"] }, c).binary).toBe("hermes");
  expect(() => parseBrain({ id: "acp", command: "hermes -p voice acp" }, c)).toThrow();
  expect(() => parseBrain({ id: "acp", command: ["hermes", "$(id)"] }, c)).toThrow();
  expect(() => parseBrain({ id: "openai-compatible", baseUrl: "https://example.test/?token=x", model: "m" }, c)).toThrow();
  expect(() => parseBrain({ id: "claude-code", mode: "tab-inject" }, c)).toThrow();
  expect(parseBrain({ id: "claude-code", mode: "tab-inject" }, c, { localTerminal: true }).mode).toBe("tab-inject");
  expect(parseBoard({ id: "paperclip", companyId: "company_1" }, c, { env: {} }).companyId).toBe("company_1");
  for (const bad of ["a b", "a;rm", "$(id)", "x".repeat(81)]) expect(() => parseBoard({ id: "paperclip", companyId: bad }, c, { env: {} })).toThrow();
  expect(() => parseBoard({ id: "paperclip" }, c, { env: {} })).toThrow();
  expect(parseSpeech("stt", { id: "wyoming", host: "192.168.1.2", port: 10300 }, c).host).toBe("192.168.1.2");
  for (const bad of ["http://localhost", "bad host", "999.999.999.999", "x".repeat(254)]) expect(() => parseSpeech("stt", { id: "wyoming", host: bad, port: 10300 }, c)).toThrow();
  expect(() => parseSpeech("stt", { id: "wyoming", host: "localhost", port: 70000 }, c)).toThrow();
  expect(() => parseSpeech("stt", { id: "audiocpp" }, c)).toThrow();
  expect(parseSpeech("tts", { id: "elevenlabs", apiKey: "synthetic-key" }, c).id).toBe("elevenlabs");
  expect(() => parseSpeech("tts", { id: "elevenlabs", apiKey: "" }, c)).toThrow();
  expect(() => parseSpeech("tts", { id: "elevenlabs", apiKey: "x".repeat(1025) }, c)).toThrow();
});

test("provider probes run in parallel, cap lists, and prefer the first running runtime", async () => {
  const seen: string[] = []; let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const pending = detectProvider(ctx(), { fetcher: (async (input: RequestInfo | URL) => { seen.push(String(input)); await gate; return new Response(JSON.stringify({ models: [{ name: "pulled" }], data: [{ id: "loaded" }] })); }) as typeof fetch });
  await Promise.resolve(); expect(seen).toHaveLength(3); release();
  const up = await pending; expect(up.recommended).toBe("llama-cpp"); expect(up.runtimes.ollama.models).toEqual(["pulled"]); expect(up.runtimes["lm-studio"].models).toEqual(["loaded"]);
  const down = await detectProvider(ctx(), { fetcher: (async () => new Response("down", { status: 503 })) as typeof fetch });
  expect(down.recommended).toBe("ollama");
  const ollamaOnly = await detectProvider(ctx(), { fetcher: (async (input: RequestInfo | URL) => String(input).includes("11434") ? Response.json({ models: [{ name: "pulled" }] }) : new Response("down", { status: 503 })) as typeof fetch });
  expect(ollamaOnly.recommended).toBe("ollama");
  const studioOnly = await detectProvider(ctx(), { fetcher: (async (input: RequestInfo | URL) => String(input).includes("1234") ? Response.json({ data: [{ id: "loaded" }] }) : new Response("down", { status: 503 })) as typeof fetch });
  expect(studioOnly.recommended).toBe("lm-studio");
  const malformed = await detectProvider(ctx(), { fetcher: (async () => new Response("{")) as typeof fetch });
  expect(malformed.runtimes.ollama.running).toBe(false);
  const oversized = await detectProvider(ctx(), { fetcher: (async () => new Response(JSON.stringify({ models: Array(201).fill({ name: "m" }), data: Array(201).fill({ id: "m" }) }))) as typeof fetch });
  expect(oversized.runtimes.ollama.models).toHaveLength(200);
  const huge = await detectProvider(ctx(), { fetcher: (async () => new Response("x".repeat(140000))) as typeof fetch });
  expect(huge.runtimes.ollama.running).toBe(false);
});

test("remote model list never reflects the supplied API key", async () => {
  const listed = await probeRemoteProviderModels({ id: "openai-compatible", baseUrl: "https://example.test/v1", apiKey: "synthetic-secret" }, {
    fetcher: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-secret");
      return Response.json({ data: [{ id: "safe-model" }, { id: "synthetic-secret" }] });
    }) as typeof fetch,
  });
  expect(listed.models).toEqual(["safe-model"]);
});

test("brain and board detection use injected PATH and bounded runner", async () => {
  const calls: readonly string[][] = [];
  const detected = await detectBrain(ctx(), { which: (bin) => bin === "codex" ? "/usr/bin/codex" : null, runCommand: async (args, opts) => { (calls as string[][]).push([...args]); expect(opts?.timeoutMs).toBeLessThanOrEqual(1500); return command("codex 1.0"); } });
  expect(detected.installed.codex?.found).toBe(true); expect(detected.recommended).toBe("codex"); expect(calls[0]).toEqual(["/usr/bin/codex", "--version"]);
  const board = await detectBoard(ctx(), { which: (bin) => bin === "multica" ? "/bin/multica" : null, env: {} });
  expect(board.recommended).toBe("multica");
  expect(BOARD_COMMANDS.hermes.command).toEqual(["hermes", "kanban", "list", "--json"]);
  expect(contributeBoard(parseBoard({ id: "paperclip", companyId: "c1" }, ctx(), { env: {} })).notify?.kanban.command).toEqual(["paperclipai", "issue", "list", "-C", "c1", "--json"]);
  expect(contributeBoard(parseBoard({ id: "paperclip", companyId: "c1" }, ctx(), { env: {} })).notify?.kanban.task_command).toEqual(["paperclipai", "issue", "get", "-C", "c1"]);
  expect(contributeBoard(parseBoard({ id: "paperclip" }, ctx(), { env: { PAPERCLIP_COMPANY_ID: "c1" } })).notify?.kanban.command).toEqual(["paperclipai", "issue", "list", "--json"]);
  expect((await probeBoard({ id: "hermes" }, { runCommand: async () => command('[{"id":"1","status":"todo"}]') })).message).toBe("Found 1 tasks");
  expect((await probeBoard({ id: "hermes" }, { runCommand: async () => command("not-json") })).ok).toBe(false);
});

test("speech options follow platform and venv/port status is informational", async () => {
  const deps = { exists: () => true, probePort: async () => false, checkout: "/repo" };
  expect((await detectSpeech("stt", ctx("darwin"), deps)).options).toEqual(["faster-whisper", "mlx-whisper", "wyoming"]);
  expect((await detectSpeech("tts", ctx("darwin"), deps)).options).toContain("mlx-audio");
  expect((await detectSpeech("stt", ctx("linux", true), deps)).options).toContain("audiocpp");
  expect((await detectSpeech("stt", ctx("win32"), deps)).options).toEqual(["faster-whisper", "wyoming"]);
  expect((await detectSpeech("tts", ctx("win32"), deps)).status.kokoro).toEqual({ installed: true, running: false });
});

test("all picker contributions preserve defaults and round-trip through loadConfig", () => {
  const c = ctx(); let draft = c.draft;
  const choices: Record<string, unknown> = { provider: { id: "ollama", model: "qwen3.5:0.8b" }, brain: { id: "codex" }, board: { id: "hermes" }, stt: { id: "faster-whisper" }, tts: { id: "kokoro" } };
  for (const id of ["provider", "brain", "board", "stt", "tts"]) { const step = pick(id); const choice = step.parseChoice(choices[id], { ...c, draft }, { env: {} }); draft = mergeDraft(draft, step.contribute({ ...c, draft }, choice)); }
  expect(draft.brain.mode).toBe("subprocess");
  const home = mkdtempSync(join(tmpdir(), "cicero-pickers-"));
  try { writeFileSync(join(home, "config.yaml"), renderDraft(draft)); const loaded = loadConfig({}, { home }); expect(loaded.brain.backend).toBe("codex"); expect(loaded.llmBackend.backend).toBe("ollama"); expect(loaded.notify.kanban?.preset).toBe("hermes"); }
  finally { rmSync(home, { recursive: true, force: true }); }
});

test("API state masks stored API keys", async () => {
  let handler: (req: Request) => Response | Promise<Response> = () => new Response();
  const serve = ((options: { fetch: typeof handler }) => { handler = options.fetch; return { port: 9999, stop() {} }; }) as unknown as typeof Bun.serve;
  const home = mkdtempSync(join(tmpdir(), "cicero-picker-server-"));
  const server = await startSetupServer({ home, serve, output: () => {}, systemDeps: { platform: () => "linux", arch: () => "x64", release: () => "6.8", which: () => null, exists: () => true, statfs: () => ({ bavail: 1, bsize: 1 }) as ReturnType<typeof import("node:fs")["statfsSync"]> }, pickerDeps: { fetcher: (async (input: RequestInfo | URL) => String(input).includes("example.test") ? Response.json({ data: [{ id: "m" }, { id: "m2" }] }) : new Response("down", { status: 503 })) as typeof fetch, which: () => null, runCommand: async () => command("invalid-json") }, check: async () => [{ name: "config", level: "ok", detail: "synthetic-super-secret" }] });
  try {
    const send = (path: string, body?: object) => handler(new Request(`http://127.0.0.1:9999${path}`, { method: body ? "POST" : "GET", headers: { host: "127.0.0.1:9999", "x-cicero-setup-token": server.token, ...(body ? { "x-cicero-setup-csrf": "1" } : {}) }, body: body ? JSON.stringify(body) : undefined }));
    const listed = await (await send("/api/provider-models", { choice: { id: "openai-compatible", baseUrl: "https://example.test/v1", apiKey: "synthetic-super-secret" } })).json() as { models: string[] };
    expect(listed.models).toEqual(["m", "m2"]);
    expect((await send("/api/choice", { id: "provider", choice: { id: "openai-compatible", baseUrl: "https://example.test/v1", model: "unlisted", apiKey: "synthetic-super-secret" } })).status).toBe(400);
    const response = await send("/api/choice", { id: "provider", choice: { id: "openai-compatible", baseUrl: "https://example.test/v1", model: "m", apiKey: "synthetic-super-secret" } });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("synthetic-super-secret");
    expect(await (await send("/api/state")).text()).not.toContain("synthetic-super-secret");
    const retained = await (await send("/api/choice", { id: "provider", choice: { id: "openai-compatible", baseUrl: "https://example.test/v1", model: "m2", apiKey: "" } })).json() as { storedSecrets: { provider: boolean }; yaml: string };
    expect(retained.storedSecrets.provider).toBe(true);
    expect(retained.yaml).toContain("apiKey: set");
    expect(await (await send("/api/check", {})).text()).not.toContain("synthetic-super-secret");
    await send("/api/step", { id: "board" });
    const failedProbe = await (await send("/api/choice", { id: "board", choice: { id: "hermes" } })).json() as { detected: { probe: { ok: boolean } }; yaml: string };
    expect(failedProbe.detected.probe.ok).toBe(false);
    expect(failedProbe.yaml).not.toContain("kanban:");
  } finally { await server.stop(); rmSync(home, { recursive: true, force: true }); }
});
