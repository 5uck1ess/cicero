import { existsSync } from "node:fs";
import { join } from "node:path";
import { connect, isIP } from "node:net";
import { TIER_PRESETS } from "../backends/tiers";
import { OPENAI_COMPATIBLE_BACKENDS, resolveOpenAiTarget } from "../backends/llm/openai";
import { isHuggingFaceGgufRepo, localGgufProblem } from "../cli/doctor";
import { BOARD_COMMANDS, normalizeBoardList, type BoardPreset } from "../notify/board-presets";
import { findVenvPython } from "../platform/python";
import { audioCppLocalRuntimePaths } from "../backends/tts/audiocpp";
import { runBoundedCommand } from "../process/bounded-command";
import { AUDIOCPP_MODELS, AUDIOCPP_PORT, audioCppModelPath } from "./audiocpp";
import type { StepContext } from "./steps";

export interface PickerDeps {
  fetcher?: typeof fetch;
  which?: (binary: string) => string | null;
  runCommand?: typeof runBoundedCommand;
  probePort?: (host: string, port: number) => Promise<boolean>;
  exists?: (path: string) => boolean;
  checkout?: string;
  env?: Record<string, string | undefined>;
  localTerminal?: boolean;
  allowedModels?: ProviderModelList | null;
}
export interface ProviderModelList { id: string; baseUrl: string; models: string[] }
const LIMIT = 160;
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Choose an option");
  return raw as Record<string, unknown>;
}
function field(value: unknown, name: string, max = LIMIT): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Enter a valid ${name}`);
  return value.trim();
}
function optional(value: unknown, name: string, max = 512): string | undefined {
  if (value === undefined || value === "") return undefined;
  return field(value, name, max);
}
function member(value: unknown, choices: readonly string[], name: string): string {
  if (typeof value !== "string" || !choices.includes(value)) throw new Error(`Choose a supported ${name}`);
  return value;
}
function url(value: unknown, name: string): string {
  const raw = field(value, name, 512);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`Enter a valid ${name}`); }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || raw.includes("?") || raw.includes("#")) throw new Error(`Enter a valid ${name} without credentials, query, or fragment`);
  return parsed.toString().replace(/\/$/, "");
}
function model(value: unknown): string { return field(value, "model", 200); }
function argv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error("Enter a command as an argv array");
  return value.map((part: unknown) => {
    const item = field(part, "command argument", 256);
    if (/[;&|`$<>{}\r\n]/.test(item)) throw new Error("Command arguments must not contain shell operators");
    return item;
  });
}
function token(value: unknown): string {
  const id = field(value, "company id", 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) throw new Error("Company id must be one token of letters, numbers, dot, underscore, or hyphen");
  return id;
}
function host(value: unknown): string {
  const h = field(value, "server host", 253);
  if (isIP(h)) return h;
  if (/^[0-9.]+$/.test(h) || !h.split(".").every((label) => label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)))
    throw new Error("Enter a valid server host");
  return h;
}
function port(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) throw new Error("Enter a port from 1 to 65535");
  return value as number;
}
function choice(raw: unknown): Record<string, unknown> { return object(raw); }
function mlx(ctx: StepContext): boolean { return ctx.system.platform === "darwin" && ctx.system.arch === "arm64" && ctx.system.mlxSupported; }
function cuda(ctx: StepContext): boolean { return ctx.system.platform === "linux" && ctx.system.gpu.status === "ok"; }
function hasLocalTerminal(deps: PickerDeps): boolean {
  if (deps.localTerminal !== undefined) return deps.localTerminal;
  return Boolean(process.stdout.isTTY && (process.env.KITTY_WINDOW_ID || process.env.WEZTERM_PANE || process.env.TMUX));
}

async function boundedResponse(response: Response, max = 128 * 1024, signal?: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("unavailable");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.byteLength;
      if (size > max) throw new Error("response too large");
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { signal?.removeEventListener("abort", cancel); cancel(); }
}
async function fetchLimited(fetcher: typeof fetch, address: string, json = true, headers?: HeadersInit, timeoutMs = 1500): Promise<{ running: boolean; models: string[] }> {
  const controller = new AbortController();
  let expire!: () => void;
  const deadline = new Promise<never>((_, reject) => { expire = () => reject(new Error("probe deadline")); });
  const timer = setTimeout(() => { controller.abort(); expire(); }, timeoutMs);
  try {
    return await Promise.race([(async () => {
      const response = await fetcher(address, { signal: controller.signal, headers });
      if (!response.ok) return { running: false, models: [] };
      if (!json) { void response.body?.cancel().catch(() => {}); return { running: true, models: [] }; }
      const payload = await boundedResponse(response);
      const rows = address.includes("/api/tags") ? (payload as { models?: unknown }).models : (payload as { data?: unknown }).data;
      if (!Array.isArray(rows)) return { running: false, models: [] };
      const models = rows.slice(0, 200).map((row) => address.includes("/api/tags") ? row?.name : row?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200 && !/[\x00-\x1f]/.test(id));
      return { running: true, models };
    })(), deadline]);
  } catch { return { running: false, models: [] }; }
  finally { clearTimeout(timer); controller.abort(); }
}
export async function detectProvider(ctx: StepContext, deps: PickerDeps = {}) {
  const fetcher = deps.fetcher ?? fetch;
  const [llama, ollama, lmstudio] = await Promise.all([
    fetchLimited(fetcher, "http://127.0.0.1:8080/health", false),
    fetchLimited(fetcher, "http://127.0.0.1:11434/api/tags"),
    fetchLimited(fetcher, "http://127.0.0.1:1234/v1/models"),
  ]);
  const recommended = llama.running ? "llama-cpp" : ollama.running ? "ollama" : lmstudio.running ? "lm-studio" : mlx(ctx) ? "mlx-lm" : ctx.draft.deployment === "local-cpu" ? "ollama" : "llama-cpp";
  const which = deps.which ?? ((binary: string) => Bun.which(binary));
  return { recommended, defaultModel: TIER_PRESETS["local-cuda"]?.llm?.model, reason: `${ctx.draft.deployment} tier; llama.cpp ${llama.running ? "running" : "offline"}, Ollama ${ollama.running ? "running" : "offline"}, LM Studio ${lmstudio.running ? "running" : "offline"}.`, runtimes: { "llama-cpp": llama, ollama, "lm-studio": lmstudio }, installed: { "llama-cpp": Boolean(which("llama-server")), ollama: Boolean(which("ollama")) }, cloudPresets: OPENAI_COMPATIBLE_BACKENDS.filter((id) => id !== "openai-compatible"), mlxAvailable: mlx(ctx) };
}
export async function probeRemoteProviderModels(raw: unknown, deps: PickerDeps = {}): Promise<ProviderModelList> {
  const c = choice(raw);
  const id = member(c.id, ["openai-compatible", ...OPENAI_COMPATIBLE_BACKENDS], "LLM provider");
  const baseUrl = id === "openai-compatible" ? url(c.baseUrl, "API base URL") : resolveOpenAiTarget({ backend: id }).baseUrl;
  const apiKey = optional(c.apiKey, "API key", 1024);
  if (apiKey && baseUrl.includes(apiKey)) throw new Error("Keep the API key out of the endpoint URL");
  const result = await fetchLimited(deps.fetcher ?? fetch, `${baseUrl}/models`, true, apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined, 2500);
  const models = apiKey ? result.models.filter((listed) => !listed.includes(apiKey)) : result.models;
  if (!result.running || !models.length) throw new Error("Could not list models from that endpoint; check its URL, API key, and server status. Endpoints without /models need manual configuration");
  return { id, baseUrl, models };
}
export function parseProvider(raw: unknown, ctx: StepContext, deps: PickerDeps = {}) {
  const c = choice(raw); const id = member(c.id, ["llama-cpp", "ollama", "lm-studio", "mlx-lm", "openai-compatible", ...OPENAI_COMPATIBLE_BACKENDS], "LLM provider");
  if (id === "mlx-lm") { if (!mlx(ctx)) throw new Error("MLX requires Apple Silicon and macOS 14 or newer"); return { id }; }
  if (id === "llama-cpp") {
    const selected = model(c.model ?? TIER_PRESETS["local-cuda"]?.llm?.model);
    if (selected.toLowerCase().endsWith(".gguf")) {
      if (/[;&|`$<>]/.test(selected) || localGgufProblem(selected)) throw new Error("Choose an existing readable .gguf file");
    } else if (!isHuggingFaceGgufRepo(selected)) throw new Error("Model must be a readable .gguf path or owner/repo[:quant]");
    return { id, model: selected };
  }
  if (id === "ollama" || id === "lm-studio") {
    const selected = model(c.model);
    const detected = ctx.detected as { runtimes?: Record<string, { running: boolean; models: string[] }> } | undefined;
    const runtime = detected?.runtimes?.[id];
    if (runtime && (!runtime.running || !runtime.models.includes(selected))) throw new Error("Start the runtime, load a model, and Re-check before choosing it");
    return { id, model: selected };
  }
  const baseUrl = id === "openai-compatible" ? url(c.baseUrl, "API base URL") : resolveOpenAiTarget({ backend: id }).baseUrl;
  const selected = model(c.model);
  if (deps.allowedModels !== undefined && (deps.allowedModels?.id !== id || deps.allowedModels.baseUrl !== baseUrl || !deps.allowedModels.models.includes(selected)))
    throw new Error("List models from this endpoint and choose one of them");
  const apiKey = optional(c.apiKey, "API key", 1024);
  if (apiKey && baseUrl.includes(apiKey)) throw new Error("Keep the API key out of the endpoint URL");
  return { id, baseUrl, model: selected, apiKey };
}
export function contributeProvider(c: ReturnType<typeof parseProvider>) {
  if (c.id === "mlx-lm") return { llm: { backend: "mlx-lm" } };
  if (c.id === "llama-cpp" || c.id === "ollama") return { llm: { backend: c.id, model: c.model } };
  if (c.id === "lm-studio") return { llm: { backend: "openai", baseUrl: "http://127.0.0.1:1234/v1", model: c.model } };
  return { llm: { backend: c.id, baseUrl: c.baseUrl, model: c.model, ...(c.apiKey ? { apiKey: c.apiKey } : {}) } };
}
const ROUTER_URL = "http://127.0.0.1:8096";
export const LAYA_LANES_REQUIRED = "Needs office lanes (brain.lanes): Laya routes between employees. Add lanes, then set switchboard.intent_url — see docs/office.md.";
function hasOfficeLanes(ctx: StepContext): boolean {
  const lanes = ctx.draft.brain.lanes;
  return !!lanes && typeof lanes === "object" && !Array.isArray(lanes) && Object.keys(lanes).length > 0;
}
export async function detectRouter(ctx: StepContext) {
  const available = hasOfficeLanes(ctx);
  return { options: available ? ["llm", "laya"] : ["llm"],
    disabled: available ? {} : { laya: LAYA_LANES_REQUIRED }, recommended: "llm", defaultUrl: ROUTER_URL,
    reason: "The LLM prompt works without a separate fine-tuned switchboard checkpoint." };
}
export function parseRouter(raw: unknown, ctx: StepContext) {
  const c = choice(raw);
  const id = member(c.id, ["llm", "laya"], "intent router");
  if (id === "laya" && !hasOfficeLanes(ctx)) throw new Error(LAYA_LANES_REQUIRED);
  return id === "llm" ? { id } : { id, url: url(c.url ?? ROUTER_URL, "intent router URL") };
}
export function contributeRouter(c: ReturnType<typeof parseRouter>) {
  return c.id === "llm" ? {} : { switchboard: { intent_url: c.url } };
}
export async function probeRouter(c: ReturnType<typeof parseRouter>, deps: PickerDeps = {}) {
  if (c.id === "llm") return { ok: true, message: "Uses the LLM intent prompt" };
  const failure = { ok: false, message: "Laya sidecar is not reachable or not ready; see sidecars/laya-switchboard/README.md" };
  const controller = new AbortController();
  let expire!: () => void;
  const deadline = new Promise<never>((_, reject) => { expire = () => reject(new Error("probe deadline")); });
  const timer = setTimeout(() => { controller.abort(); expire(); }, 1500);
  try {
    return await Promise.race([(async () => {
      const response = await (deps.fetcher ?? fetch)(`${c.url}/health`, { method: "GET", signal: controller.signal });
      if (controller.signal.aborted || !response.ok) {
        void response.body?.cancel().catch(() => {});
        return failure;
      }
      const payload = await boundedResponse(response, 8192, controller.signal);
      if (!payload || typeof payload !== "object" || (payload as { ok?: unknown }).ok !== true) return failure;
      const device = (payload as { device?: unknown }).device;
      // Only display known device identifiers from the untrusted response.
      const label = typeof device === "string" && /^(?:cpu|cuda|mps)(?::[0-9]{1,2})?$/.test(device) ? device : "unknown device";
      return { ok: true, message: `Laya sidecar ready on ${label}` };
    })(), deadline]);
  } catch { return failure; }
  finally { clearTimeout(timer); controller.abort(); }
}
const BRAINS = ["acp", "claude-code", "codex", "gemini", "qwen", "ollama", "openai-compatible", ...OPENAI_COMPATIBLE_BACKENDS.filter((id) => id !== "openai-compatible")] as const;
const CLI_BINS: Record<string, string> = { "claude-code": "claude", codex: "codex", gemini: "gemini", qwen: "qwen" };
export async function detectBrain(_ctx: StepContext, deps: PickerDeps = {}) {
  const which = deps.which ?? ((binary: string) => Bun.which(binary));
  const runner = deps.runCommand ?? runBoundedCommand;
  const installed: Record<string, { found: boolean }> = {};
  await Promise.all(Object.entries(CLI_BINS).map(async ([id, binary]) => {
    const path = which(binary); if (!path) { installed[id] = { found: false }; return; }
    try { const result = await runner([path, "--version"], { timeoutMs: 1500, stdoutLimitBytes: 1024, stderrLimitBytes: 1024, totalLimitBytes: 2048, outputLimitBehavior: "error" }); installed[id] = { found: result.exitCode === 0 }; }
    catch { installed[id] = { found: false }; }
  }));
  return { recommended: Object.keys(CLI_BINS).find((id) => installed[id]?.found) ?? "claude-code", reason: "The suggested CLI is installed and responds to --version, or Claude Code is the documented default.", installed, localTerminal: hasLocalTerminal(deps), options: BRAINS };
}
export function parseBrain(raw: unknown, _ctx: StepContext, deps: PickerDeps = {}) {
  const c = choice(raw); const id = member(c.id, BRAINS, "brain");
  const tab = c.mode === "tab-inject";
  if (c.mode !== undefined && c.mode !== "subprocess" && !tab) throw new Error("Unsupported brain mode");
  if (tab && (id !== "claude-code" || !hasLocalTerminal(deps))) throw new Error("Tab inject requires Claude Code in a local terminal");
  if (id === "acp") { const command = argv(c.command); return { id, mode: "subprocess", binary: command[0], binary_args: command.slice(1) }; }
  if (id === "openai-compatible") {
    const base_url = url(c.baseUrl, "brain API base URL");
    const api_key = optional(c.apiKey, "API key", 1024);
    if (api_key && base_url.includes(api_key)) throw new Error("Keep the API key out of the endpoint URL");
    return { id, mode: "subprocess", base_url, model: model(c.model), api_key };
  }
  if (id === "ollama") return { id, mode: "subprocess", ollama_model: model(c.model) };
  if (id in CLI_BINS) return { id, mode: tab ? "tab-inject" : "subprocess" };
  return { id, mode: "subprocess", model: model(c.model), api_key: optional(c.apiKey, "API key", 1024) };
}
export function contributeBrain(c: ReturnType<typeof parseBrain>) {
  const { id, ...rest } = c;
  return { brain: { backend: id, ...rest } };
}
export async function detectBoard(_ctx: StepContext, deps: PickerDeps = {}) {
  const which = deps.which ?? ((binary: string) => Bun.which(binary));
  const installed = Object.fromEntries(Object.entries(BOARD_COMMANDS).map(([id, spec]) => [id, Boolean(which(spec.command[0]!))]));
  return { installed, recommended: Object.keys(installed).find((id) => installed[id]) ?? "none", reason: "A detected board CLI is suggested; no board is fine if you do not use one.", paperclipEnv: Boolean((deps.env ?? process.env).PAPERCLIP_COMPANY_ID), templates: BOARD_COMMANDS };
}
export function parseBoard(raw: unknown, _ctx: StepContext, deps: PickerDeps = {}) {
  const c = choice(raw); const id = member(c.id, ["none", "hermes", "multica", "paperclip"], "board");
  if (id !== "paperclip") return { id };
  const envId = (deps.env ?? process.env).PAPERCLIP_COMPANY_ID;
  if (c.companyId) return { id, companyId: token(c.companyId) };
  if (envId) token(envId);
  // No ID: PAPERCLIP_COMPANY_ID or a `paperclipai context set` profile supplies it; the probe verifies.
  return { id };
}
export function contributeBoard(c: ReturnType<typeof parseBoard>) {
  if (c.id === "none") return {};
  const template = BOARD_COMMANDS[c.id as BoardPreset];
  const command = [...template.command];
  if (c.id === "paperclip" && c.companyId) command.splice(command.length - 1, 0, "-C", c.companyId);
  const task_command = [...template.task_command];
  if (c.id === "paperclip" && c.companyId) task_command.push("-C", c.companyId);
  return { notify: { kanban: { enabled: true, preset: c.id, command, task_command } } };
}
export async function probeBoard(c: ReturnType<typeof parseBoard>, deps: PickerDeps = {}) {
  if (c.id === "none") return { ok: true, message: "No board selected" };
  try {
    const conf = contributeBoard(c).notify!.kanban;
    const result = await (deps.runCommand ?? runBoundedCommand)(conf.command, { timeoutMs: 3000, stdoutLimitBytes: 256 * 1024, stderrLimitBytes: 4096, totalLimitBytes: 260 * 1024, outputLimitBehavior: "error" });
    if (result.exitCode !== 0) return { ok: false, message: `Probe exited ${result.exitCode}` };
    const tasks = normalizeBoardList(JSON.parse(result.stdout.text), { preset: c.id as BoardPreset });
    return { ok: true, message: `Found ${tasks.length} tasks` };
  } catch { return { ok: false, message: "Board probe failed; check CLI setup and retry" }; }
}
export async function defaultPortProbe(hostname: string, number: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: number });
    let settled = false;
    const timer = setTimeout(() => done(false), 700);
    const done = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(ok); };
    socket.once("connect", () => done(true)); socket.once("error", () => done(false));
  });
}
const VENV: Record<string, string> = { "faster-whisper": ".venv-stt", "mlx-whisper": ".venv", kokoro: ".venv-kokoro", "pocket-tts": ".venv-pocket", "mlx-audio": ".venv" };
export async function detectSpeech(kind: "stt" | "tts", ctx: StepContext, deps: PickerDeps = {}) {
  const options = kind === "stt" ? ["faster-whisper", ...(mlx(ctx) ? ["mlx-whisper"] : []), "wyoming", ...(cuda(ctx) ? ["audiocpp"] : [])]
    : ["kokoro", "pocket-tts", ...(cuda(ctx) ? ["audiocpp"] : []), ...(mlx(ctx) ? ["mlx-audio"] : []), "elevenlabs", "wyoming"];
  const root = deps.checkout ?? join(import.meta.dir, "..", "..");
  const exists = deps.exists ?? existsSync;
  const portByBackend: Record<string, number> = { "faster-whisper": 8083, "mlx-whisper": 8083, audiocpp: AUDIOCPP_PORT, kokoro: 8082, "pocket-tts": 8082, "mlx-audio": 8082 };
  const status: Record<string, { installed: boolean; running: boolean; modelPresent?: boolean; modelLoaded?: boolean | null }> = {};
  await Promise.all(options.filter((id) => id in portByBackend).map(async (id) => {
    const running = await (deps.probePort ?? defaultPortProbe)("127.0.0.1", portByBackend[id]!).catch(() => false);
    if (id === "audiocpp") {
      const modelPresent = exists(audioCppModelPath(root, kind));
      const listed = running ? await fetchLimited(deps.fetcher ?? fetch, `http://127.0.0.1:${AUDIOCPP_PORT}/v1/models`, true, undefined, 700) : null;
      status[id] = { installed: exists(audioCppLocalRuntimePaths(root).binary), running,
        modelPresent, modelLoaded: listed?.running ? listed.models.includes(AUDIOCPP_MODELS[kind].id) : null };
    } else {
      status[id] = { installed: id in VENV ? Boolean(findVenvPython(join(root, VENV[id]!), { platform: ctx.system.platform, exists })) : false, running };
    }
  }));
  status.wyoming = { installed: false, running: await (deps.probePort ?? defaultPortProbe)("127.0.0.1", kind === "stt" ? 10300 : 10200).catch(() => false) };
  const audio = status.audiocpp;
  const ready = ctx.draft.deployment === "local-cuda" && audio?.installed && audio.modelPresent && (!audio.running || audio.modelLoaded === true);
  const recommended = ready ? "audiocpp" : kind === "stt" ? mlx(ctx) ? "mlx-whisper" : "faster-whisper" : mlx(ctx) ? "mlx-audio" : "kokoro";
  return { options, recommended, status, reason: ctx.draft.deployment + " tier" };
}
export function parseSpeech(kind: "stt" | "tts", raw: unknown, ctx: StepContext) {
  const c = choice(raw);
  const allowed = kind === "stt" ? ["faster-whisper", ...(mlx(ctx) ? ["mlx-whisper"] : []), "wyoming", ...(cuda(ctx) ? ["audiocpp"] : [])]
    : ["kokoro", "pocket-tts", ...(cuda(ctx) ? ["audiocpp"] : []), ...(mlx(ctx) ? ["mlx-audio"] : []), "elevenlabs", "wyoming"];
  const id = member(c.id, allowed, kind.toUpperCase());
  if (id === "wyoming") return { id, host: host(c.host), port: port(c.port) };
  if (id === "elevenlabs") return { id, apiKey: field(c.apiKey, "ElevenLabs API key", 1024) };
  if (kind === "stt" && id === "audiocpp") {
    if (c.streaming !== undefined && typeof c.streaming !== "boolean") throw new Error("Streaming must be a checkbox choice");
    return { id, streaming: c.streaming === true };
  }
  return { id };
}
export function contributeSpeech(kind: "stt" | "tts", c: ReturnType<typeof parseSpeech>) {
  if (c.id === "elevenlabs") return { tts: { backend: c.id, apiKey: c.apiKey } };
  if (c.id === "audiocpp") return { [kind]: { backend: c.id, port: AUDIOCPP_PORT, model: AUDIOCPP_MODELS[kind].id,
    ...(kind === "stt" && "streaming" in c && c.streaming === true ? { streaming: true } : {}) } };
  return { [kind]: { backend: c.id, ...(c.id === "wyoming" ? { host: c.host, port: c.port } : {}) } };
}
