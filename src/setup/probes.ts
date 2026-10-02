import { cloudSpeechBackend } from "../backends/cloud-speech";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSTTProvider } from "../backends/registry";
import { resolveOpenAiTarget, OPENAI_COMPATIBLE_BACKENDS } from "../backends/llm/openai";
import { readBoundedJson } from "../backends/http-transfer";
import { sttDefaultPort, type STTProvider, type STTProviderConfig } from "../backends/stt/provider";
import { ttsDefaultPort } from "../backends/tts/provider";
import { probeNvidiaGpu, type GpuCommandRunner } from "../platform/gpu";
import { runBoundedCommand } from "../process/bounded-command";
import { detectAccounts } from "./accounts";
import { acpProviderOf } from "./acp-agents";
import { runtimeStartCommand } from "./runtimes";
import { defaultPortProbe, type PickerDeps } from "./pickers";
import { engineStartCommand } from "./sample";

/**
 * Test-step probes against engines that are already running. They never call
 * start(), never run an agent, and bound every call by time and size.
 */
export type ProbeId = "hear" | "frontdesk" | "helper" | "memory";
export type ProbeState = "ok" | "failed" | "not running" | "skipped" | "timeout" | "cancelled" | "installed; tested on first call";
export interface ProbeResult { id: ProbeId | "speak"; state: ProbeState; message: string; startCommand?: string; data?: unknown }
export interface ProbeDeps extends PickerDeps {
  gpuRunner?: GpuCommandRunner;
  /** Test seam for the STT client; defaults to the runtime registry. */
  buildStt?: (config: STTProviderConfig) => STTProvider;
  /** Root holding assets/setup; defaults to the checkout. */
  assetsRoot?: string;
}
export interface ProbeOptions { signal: AbortSignal; timeoutMs?: number; deps?: ProbeDeps }
type Config = Record<string, unknown>;

export const PROBE_TIMEOUT_MS = 20_000;
export const PROBE_IDS: readonly ProbeId[] = ["hear", "frontdesk", "helper", "memory"];
const JSON_LIMIT = 64 * 1024;
const MESSAGE_LIMIT = 200;
const STATUS_TIMEOUT_MS = 1500;
const AGENT_BACKENDS = new Set(["claude-code", "codex", "gemini", "qwen", "acp"]);
const PROVIDER_OF_BACKEND: Record<string, "claude" | "codex" | "grok"> = { "claude-code": "claude", codex: "codex" };
const defaultAssets = join(import.meta.dir, "..", "..", "assets", "setup");

const clip = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, MESSAGE_LIMIT);
const record = (value: unknown): Config => value && typeof value === "object" && !Array.isArray(value) ? value as Config : {};
const str = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

class ProbeAbort extends Error {}

/** Run one probe under its deadline and the caller's cancel signal; the deadline holds even if a client ignores the signal. */
async function bounded(id: ProbeId, o: ProbeOptions, work: (signal: AbortSignal) => Promise<ProbeResult>): Promise<ProbeResult> {
  if (o.signal.aborted) return { id, state: "cancelled", message: "Cancelled" };
  const timeoutMs = o.timeoutMs ?? PROBE_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([o.signal, timeout]);
  let detach = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new ProbeAbort());
    signal.addEventListener("abort", fail, { once: true });
    detach = () => signal.removeEventListener("abort", fail);
  });
  aborted.catch(() => {});
  try {
    return await Promise.race([work(signal), aborted]);
  } catch (error) {
    if (o.signal.aborted) return { id, state: "cancelled", message: "Cancelled" };
    if (timeout.aborted) return { id, state: "timeout", message: `No answer within ${Math.round(timeoutMs / 1000)} s` };
    return { id, state: "failed", message: clip(error instanceof Error ? error.message : String(error)) };
  } finally { detach(); }
}

function endpoint(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url);
    return { host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port || (u.protocol === "https:" ? 443 : 80)) };
  } catch { return null; }
}
const isLoopbackOrLan = (host: string) => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$)/.test(host);

/** One chat completion against an OpenAI-compatible endpoint, bounded to 64 KB. */
export async function chatOnce(base: string, model: string, prompt: string, maxTokens: number, signal: AbortSignal, deps: ProbeDeps, apiKey?: string): Promise<string> {
  const response = await (deps.fetcher ?? fetch)(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    signal,
  });
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`The model endpoint answered ${response.status}`); }
  const payload = await readBoundedJson<{ choices?: { message?: { content?: unknown } }[] }>(response, JSON_LIMIT, "model response");
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("The model returned no text");
  return content.trim();
}

/** Where a model front desk listens and which key variable it reads; null for an agent. */
function modelTarget(brain: Config, env: Record<string, string | undefined>): { base: string; model: string; apiKey?: string } | null {
  const backend = str(brain.backend) ?? "";
  if (backend === "ollama") return { base: `http://127.0.0.1:${Number(brain.ollama_port ?? 11434)}/v1`, model: str(brain.ollama_model) ?? "" };
  if (!OPENAI_COMPATIBLE_BACKENDS.includes(backend)) return null;
  const target = resolveOpenAiTarget({ backend, ...(str(brain.base_url) ? { baseUrl: str(brain.base_url) } : {}), ...(str(brain.api_key_env) ? { apiKeyEnv: str(brain.api_key_env) } : {}) });
  return { base: target.baseUrl, model: str(brain.model) ?? "", apiKey: str(brain.api_key) ?? env[target.apiKeyEnv] };
}

async function portOpen(url: string, deps: ProbeDeps): Promise<boolean> {
  const at = endpoint(url);
  if (!at || !isLoopbackOrLan(at.host)) return true; // cloud endpoints are not port-probed
  return (deps.probePort ?? defaultPortProbe)(at.host, at.port);
}

function words(text: string): string[] { return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean); }
export function wordOverlap(expected: string, heard: string): number {
  const want = words(expected);
  const got = new Set(words(heard));
  return want.length ? want.filter((w) => got.has(w)).length / want.length : 0;
}

export function probeHear(config: Config, o: ProbeOptions): Promise<ProbeResult> {
  return bounded("hear", o, async (signal) => {
    const deps = o.deps ?? {};
    const stt = record(config.stt) as STTProviderConfig & Config;
    const backend = str(stt.backend) ?? "";
    const host = str(stt.host) ?? (backend === "wyoming" ? "127.0.0.1" : "localhost");
    const port = typeof stt.port === "number" ? stt.port : sttDefaultPort(backend);
    // A cloud recognizer has no port; pressing Test sends the test clip to that provider.
    const cloud = cloudSpeechBackend("stt", backend) !== null;
    if (!port && !cloud) return { id: "hear", state: "failed", message: `No test for the ${backend || "unset"} speech engine` };
    if (!cloud && !(await (deps.probePort ?? defaultPortProbe)(host, port!))) {
      const startCommand = engineStartCommand(backend);
      return { id: "hear", state: "not running", message: `Nothing is listening on ${host}:${port}. Cicero starts this engine when it runs.`, ...(startCommand ? { startCommand } : {}) };
    }
    const root = deps.assetsRoot ?? defaultAssets;
    const expected = readFileSync(join(root, "hear-test.txt"), "utf8").trim();
    const client = (deps.buildStt ?? ((c) => buildSTTProvider(c, "stt.backend")))(stt);
    const file = join(root, "hear-test.wav");
    let heard: string;
    if (client.transcribeResult) {
      const result = await client.transcribeResult(file, signal);
      if (result.kind === "failure") return { id: "hear", state: "failed", message: clip(result.reason) };
      heard = result.kind === "transcript" ? result.text : "";
    } else heard = (await client.transcribe(file, signal)) ?? "";
    const score = wordOverlap(expected, heard);
    return score >= 0.6
      ? { id: "hear", state: "ok", message: `Heard: ${clip(heard)}`, data: { heard: clip(heard), score } }
      : { id: "hear", state: "failed", message: clip(`Heard: ${heard.trim() || "(nothing)"} (expected: ${expected})`), data: { heard: clip(heard), score } };
  });
}

/** An agent's install and likely credential, seen with the env the brain gives it (its unset_env removed). */
async function agentCredential(backend: string, command: Record<string, unknown>, deps: ProbeDeps, signal: AbortSignal): Promise<{ installed: boolean; credential: string }> {
  const which = deps.which ?? ((b: string) => Bun.which(b));
  const binary = str(command.binary);
  const name = binary ?? (backend === "claude-code" ? "claude" : backend === "acp" ? "hermes" : backend);
  const installed = Boolean(which(name));
  const args = Array.isArray(command.binary_args) ? command.binary_args.filter((a): a is string => typeof a === "string") : [];
  const provider = PROVIDER_OF_BACKEND[backend] ?? (backend === "acp" ? acpProviderOf(binary, args) : binary === "grok" ? "grok" : null);
  if (!installed || !provider) return { installed, credential: "unknown" };
  const env = { ...(deps.env ?? process.env) };
  for (const key of Array.isArray(command.unset_env) ? command.unset_env : []) if (typeof key === "string") delete env[key];
  const base: NonNullable<ProbeDeps["runCommand"]> = deps.runCommand ?? ((cmd, options) => runBoundedCommand(cmd, { ...options, timeoutMs: Math.min(options?.timeoutMs ?? STATUS_TIMEOUT_MS, STATUS_TIMEOUT_MS) }));
  // Every status command gets the probe's signal, and none starts after a cancel or timeout.
  const runCommand: NonNullable<ProbeDeps["runCommand"]> = (cmd, options) => signal.aborted ? Promise.reject(new ProbeAbort()) : base(cmd, { ...options, signal });
  const accounts = await detectAccounts({ ...deps, env, runCommand });
  const status = accounts.agents.find((a) => a.provider === provider);
  return { installed, credential: status?.likely ?? "unknown" };
}

/** A model runtime that is not listening, with its start command when the port is a known runtime's. */
function notRunning(id: "frontdesk" | "helper", base: string, note: string): ProbeResult {
  const startCommand = runtimeStartCommand(base);
  return { id, state: "not running", message: `Nothing is listening at ${base}. Start your model runtime.${note}`, ...(startCommand ? { startCommand } : {}) };
}

export function probeFrontDesk(config: Config, o: ProbeOptions): Promise<ProbeResult> {
  return bounded("frontdesk", o, async (signal) => {
    const deps = o.deps ?? {};
    const brain = record(config.brain);
    const backend = str(brain.backend) ?? "";
    const escalate = record(brain.escalate);
    const escalation = str(escalate.binary) ? await agentCredential("acp", { ...escalate, unset_env: escalate.unset_env ?? brain.unset_env }, deps, signal) : null;
    const escNote = escalation ? ` Think-hard agent ${str(escalate.binary)}: ${escalation.installed ? "installed" : "not found"}, credential ${escalation.credential}.` : "";
    if (AGENT_BACKENDS.has(backend) || str(brain.mode) === "tab-inject") {
      const agent = await agentCredential(backend, brain, deps, signal);
      if (!agent.installed) return { id: "frontdesk", state: "failed", message: `The ${backend} agent is not installed.${escNote}` };
      return { id: "frontdesk", state: "installed; tested on first call", message: `The ${backend} agent is installed; it will likely use: ${agent.credential}. It runs on your first call.${escNote}`, data: { credential: agent.credential } };
    }
    const target = modelTarget(brain, deps.env ?? process.env);
    if (!target || !target.model) return { id: "frontdesk", state: "failed", message: "No front desk model is configured" };
    if (!(await portOpen(target.base, deps))) return notRunning("frontdesk", target.base, escNote);
    const started = Date.now();
    const reply = await chatOnce(target.base, target.model, "Reply with one short sentence: are you ready?", 40, signal, deps, target.apiKey);
    return { id: "frontdesk", state: "ok", message: `${target.model} answered in ${((Date.now() - started) / 1000).toFixed(1)} s: ${clip(reply)}${escNote}` };
  });
}

export function probeHelper(config: Config, o: ProbeOptions): Promise<ProbeResult> {
  return bounded("helper", o, async (signal) => {
    const deps = o.deps ?? {};
    const tldr = record(record(config.web_voice).tldr);
    const base = str(tldr.summarizer_url);
    if (!base) return { id: "helper", state: "skipped", message: "No helper: long replies end with \"say details\"" };
    if (!(await portOpen(base, deps))) return notRunning("helper", base, "");
    const long = readFileSync(join(deps.assetsRoot ?? defaultAssets, "long-reply.txt"), "utf8");
    const started = Date.now();
    const summary = await chatOnce(base, str(tldr.summarizer_model) ?? "", `Summarize this reply in one short spoken sentence:\n\n${long}`, 60, signal, deps);
    return { id: "helper", state: "ok", message: `Summary in ${((Date.now() - started) / 1000).toFixed(1)} s: ${clip(summary)}` };
  });
}

/** Ports whose GPU use the Memory probe attributes by name. */
function enginePorts(config: Config): Map<number, string> {
  const ports = new Map<number, string>();
  for (const seat of ["stt", "tts"] as const) {
    const c = record(config[seat]);
    const backend = str(c.backend);
    const port = typeof c.port === "number" ? c.port : seat === "stt" ? sttDefaultPort(backend) : ttsDefaultPort(backend);
    const name = seat === "stt" ? "Hear" : "Speak";
    if (backend && port) ports.set(port, ports.has(port) ? ports.get(port)!.replace(/ \(/, ` + ${name} (`) : `${name} (${backend})`);
  }
  const brain = record(config.brain);
  const add = (url: string | undefined, label: string) => {
    const at = url ? endpoint(url) : null;
    if (at && isLoopbackOrLan(at.host) && !ports.has(at.port)) ports.set(at.port, label);
  };
  add(modelTarget(brain, {})?.base, "Front desk model");
  add(str(record(record(config.web_voice).tldr).summarizer_url), "Helper model");
  return ports;
}

/** `ss -ltnpH` → listening port → pid. */
export function parseListeners(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of text.split("\n")) {
    const port = line.match(/\S+:(\d+)\s+\S+:\*/)?.[1];
    const pid = line.match(/pid=(\d+)/)?.[1];
    if (port && pid && !out.has(Number(port))) out.set(Number(port), Number(pid));
  }
  return out;
}

/** `nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits` → pid → MiB. */
export function parseComputeApps(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s*,\s*(\d+)\s*$/);
    if (m) out.set(Number(m[1]), (out.get(Number(m[1])) ?? 0) + Number(m[2]));
  }
  return out;
}

function parentPid(pid: number, readFile: (path: string) => string | null): number | null {
  const stat = readFile(`/proc/${pid}/stat`);
  const after = stat?.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(after?.[1]);
  return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
}

export interface MemoryRow { label: string; port: number; gb: number }
/** Attribute GPU processes to engine ports: a process matches a listener directly or through its parent (llama-swap → llama-server). */
export function attributeMemory(apps: Map<number, number>, listeners: Map<number, number>, ports: Map<number, string>, readFile: (path: string) => string | null): { engines: MemoryRow[]; otherGb: number } {
  const pidToPort = new Map<number, number>();
  for (const [port, pid] of listeners) if (ports.has(port)) pidToPort.set(pid, port);
  const byPort = new Map<number, number>();
  let other = 0;
  for (const [pid, mib] of apps) {
    const parent = parentPid(pid, readFile);
    const port = pidToPort.get(pid) ?? (parent !== null ? pidToPort.get(parent) : undefined);
    if (port === undefined) other += mib;
    else byPort.set(port, (byPort.get(port) ?? 0) + mib);
  }
  const engines = [...byPort].map(([port, mib]) => ({ label: ports.get(port)!, port, gb: Math.round(mib / 102.4) / 10 }));
  return { engines, otherGb: Math.round(other / 102.4) / 10 };
}

export function probeMemory(config: Config, o: ProbeOptions & { platform?: string }): Promise<ProbeResult> {
  return bounded("memory", o, async (signal) => {
    const deps = o.deps ?? {};
    const platform = o.platform ?? deps.platform ?? process.platform;
    if (platform === "darwin") return { id: "memory", state: "skipped", message: "Mac measurement is deferred; the fit shown is an estimate" };
    const which = deps.which ?? ((b: string) => Bun.which(b));
    const smi = which("nvidia-smi");
    if (platform !== "linux" || !smi) return { id: "memory", state: "skipped", message: "No NVIDIA GPU to measure" };
    const base = deps.gpuRunner ?? runBoundedCommand;
    // Every command gets the probe's signal, and none starts after a cancel or timeout.
    const run: GpuCommandRunner = (command, options) => {
      if (signal.aborted) return Promise.reject(new ProbeAbort());
      return base(command, { ...options, signal });
    };
    const limits = { timeoutMs: 3000, stdoutLimitBytes: 64 * 1024, stderrLimitBytes: 1024, totalLimitBytes: 65 * 1024, outputLimitBehavior: "error" as const };
    const readFile = deps.readFile ?? ((path: string) => { try { return readFileSync(path, "utf8"); } catch { return null; } });
    let apps: Map<number, number> | null = null;
    try {
      const r = await run([smi, "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"], limits);
      if (r.exitCode === 0) apps = parseComputeApps(r.stdout.text);
    } catch { apps = null; }
    const ss = which("ss");
    let listeners = new Map<number, number>();
    if (ss) { try { const r = await run([ss, "-ltnpH"], limits); if (r.exitCode === 0) listeners = parseListeners(r.stdout.text); } catch { /* no per-process view */ } }
    if (!apps || !listeners.size) {
      const whole = await probeNvidiaGpu({ which, runCommand: run });
      if (whole.status !== "ok") return { id: "memory", state: "failed", message: "nvidia-smi did not report memory" };
      const usedGb = Math.round((whole.totalMiB - whole.freeMiB) / 102.4) / 10;
      return { id: "memory", state: "ok", message: `Whole GPU: ${usedGb} GB in use of ${Math.round(whole.totalMiB / 102.4) / 10} GB`, data: { wholeGpu: { usedGb, totalGb: whole.totalMiB / 1024 } } };
    }
    const measured = attributeMemory(apps, listeners, enginePorts(config), readFile);
    const parts = measured.engines.map((e) => `${e.label} ${e.gb} GB`);
    return { id: "memory", state: "ok", message: `${parts.length ? parts.join(", ") : "No configured engine is on the GPU"}; other GPU use ${measured.otherGb} GB`, data: measured };
  });
}

/** All four probes plus the browser-only Speak row, for `cicero setup --test`. */
export async function runHeadlessProbes(config: Config, o: ProbeOptions): Promise<ProbeResult[]> {
  const results = await Promise.all([probeHear(config, o), probeFrontDesk(config, o), probeHelper(config, o), probeMemory(config, o)]);
  return [...results, { id: "speak", state: "skipped", message: "skipped (no browser)" }];
}

export const PROBES: Record<ProbeId, (config: Config, o: ProbeOptions) => Promise<ProbeResult>> = { hear: probeHear, frontdesk: probeFrontDesk, helper: probeHelper, memory: probeMemory };
