import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { RuntimeConfig } from "../config";
import { RuntimeConfig as RuntimeConfigValue } from "../config";
import type { DaemonPidInspection } from "../daemon-pid";
import { inspectDaemonPidFile } from "../daemon-pid";
import { ciceroPath } from "../platform/paths";
import { httpBase, isKeylessHost } from "../backends/net";
import { responseIsOk } from "../backends/http-transfer";
import {
  OPENAI_COMPATIBLE_BACKENDS,
  resolveOpenAiTarget,
} from "../backends/llm/openai";
import type { LLMProviderConfig } from "../backends/llm/provider";
import type { STTProviderConfig } from "../backends/stt/provider";
import { sttDefaultPort } from "../backends/stt/provider";
import { ttsDefaultPort, type TTSProviderConfig } from "../backends/tts/provider";
import { ELEVENLABS_API_BASE } from "../backends/tts/elevenlabs";
import {
  SUPPORTED_STT_BACKENDS,
  SUPPORTED_TTS_BACKENDS,
} from "../backends/supported-backends";
import type { CiceroConfig, TerminalAdapter } from "../types";
import { detectTerminal } from "../terminal/detect";
import { createTerminalAdapter } from "../terminal";
import type {
  TerminalCommandExecutor,
  TerminalCommandOptions,
} from "../terminal/command";
import { runBoundedCommand } from "../process/bounded-command";
import { readPairingState, type PairingState } from "../web-voice/pairing-state";

const DEFAULT_STATUS_TIMEOUT_MS = 2_000;
const STATUS_STDOUT_LIMIT_BYTES = 64 * 1024;
const STATUS_STDERR_LIMIT_BYTES = 4 * 1024;
const STATUS_DETAIL_LIMIT = 240;

export type StatusLevel = "ok" | "fail" | "warn" | "info";

export interface StatusLine {
  name: string;
  level: StatusLevel;
  detail: string;
}

export interface StatusProbeRequest {
  url: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
}

type ConcreteTerminal = Exclude<CiceroConfig["terminal"], "auto">;

export interface StatusDependencies {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  platform?: typeof process.platform;
  pidFile?: string;
  hotkeyPath?: string;
  inspectDaemon?: (path: string) => Promise<DaemonPidInspection>;
  probe?: (request: StatusProbeRequest) => Promise<boolean>;
  which?: (binary: string) => string | null;
  isExecutable?: (path: string) => Promise<boolean>;
  createTerminal?: (
    config: RuntimeConfig,
    execute: TerminalCommandExecutor,
  ) => TerminalAdapter;
  pairingStateFile?: string;
  readPairingState?: (path: string) => PairingState | null;
}

interface EndpointPlan {
  summary: string;
  request?: Omit<StatusProbeRequest, "signal">;
  /** A configuration error that remains fatal even when that component is disabled. */
  fatalProblem?: string;
  problem?: string;
  unprobedReason?: string;
  unprobedLevel?: Extract<StatusLevel, "info" | "warn">;
}

const SUPPORTED_STT = new Set<string>(SUPPORTED_STT_BACKENDS);
const SUPPORTED_TTS = new Set<string>(SUPPORTED_TTS_BACKENDS);
const SUPPORTED_LLM = new Set<string>([
  "mlx-lm",
  "ollama",
  "llama-cpp",
  ...OPENAI_COMPATIBLE_BACKENDS,
]);
const SUBPROCESS_BRAINS = new Set(["acp", "claude-code", "codex", "gemini", "qwen"]);
const DEFAULT_HELPER_HOTKEY = "ctrl+shift+space";

function concise(value: string, limit = STATUS_DETAIL_LIMIT): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function modelDetail(model: string | undefined): string {
  return model ? ` · model ${concise(model, 120)}` : "";
}

function endpointForDisplay(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // An invalid URL cannot be selectively redacted. Never echo the raw value:
    // it may still contain userinfo or a query credential around an ordinary
    // typo that made parsing fail.
    return "<unparseable endpoint>";
  }
}

function networkSummary(
  backend: string,
  endpoint: string,
  model?: string,
): string {
  return `${concise(backend, 60)} @ ${concise(endpointForDisplay(endpoint), 200)}${modelDetail(model)}`;
}

function unknownEndpointSummary(
  backend: string,
  host: string | undefined,
  port: number | undefined,
  model: string | undefined,
): string {
  const location = port === undefined ? "endpoint unspecified" : `${host ?? "localhost"}:${port}`;
  return `${concise(backend, 60)} @ ${concise(location, 160)}${modelDetail(model)}`;
}

function nativeEndpoint(
  backend: string,
  host: string | undefined,
  port: number,
  model?: string,
): EndpointPlan {
  const endpoint = httpBase(host, port).replace(/^http:/, "wyoming:");
  return {
    summary: networkSummary(backend, endpoint, model),
    unprobedReason: "native protocol; bounded health probe unavailable",
    unprobedLevel: "info",
  };
}

function httpEndpoint(
  backend: string,
  host: string | undefined,
  port: number,
  path: string,
  model?: string,
): EndpointPlan {
  const url = `${httpBase(host, port)}${path}`;
  return { summary: networkSummary(backend, url, model), request: { url } };
}

function sttPlan(config: STTProviderConfig): EndpointPlan {
  const backend = config.backend ?? "unknown";
  if (!SUPPORTED_STT.has(backend)) {
    return {
      summary: unknownEndpointSummary(backend, config.host, config.port, config.model),
      fatalProblem: `unsupported backend; valid STT backends: ${SUPPORTED_STT_BACKENDS.join(", ")}`,
    };
  }
  const port = config.port ?? sttDefaultPort(backend);
  if (backend === "wyoming") {
    return nativeEndpoint(backend, config.host, port ?? 10300, config.model);
  }
  if (port !== undefined) {
    if (backend === "mlx-whisper") return httpEndpoint(backend, config.host, port, "/", config.model);
    if (backend === "faster-whisper") return httpEndpoint(backend, config.host, port, "/health", config.model);
    if (backend === "audiocpp") return httpEndpoint(backend, config.host, port, "/v1/models", config.model);
  }
  return {
    summary: unknownEndpointSummary(backend, config.host, port, config.model),
    unprobedReason: "no status probe is defined for this backend",
  };
}

function ttsPlan(
  config: TTSProviderConfig,
  env: Record<string, string | undefined>,
): EndpointPlan {
  const backend = config.backend ?? "unknown";
  if (!SUPPORTED_TTS.has(backend)) {
    return {
      summary: unknownEndpointSummary(backend, config.host, config.port, config.model),
      fatalProblem: `unsupported backend; valid TTS backends: ${SUPPORTED_TTS_BACKENDS.join(", ")}`,
    };
  }
  if (backend === "elevenlabs") {
    const apiKey = config.apiKey ?? env.ELEVENLABS_API_KEY ?? "";
    const voice = config.voice;
    const endpoint = voice
      ? `${ELEVENLABS_API_BASE}/voices/${encodeURIComponent(voice)}`
      : `${ELEVENLABS_API_BASE}/voices/<voice-id>`;
    const summary = networkSummary(backend, endpoint, config.model);
    if (!apiKey) return { summary, problem: "ELEVENLABS_API_KEY is not set" };
    if (!voice) return { summary, problem: "voice ID is not configured" };
    return {
      summary,
      request: { url: endpoint, headers: { "xi-api-key": apiKey } },
    };
  }

  const port = config.port ?? ttsDefaultPort(backend);
  if (backend === "wyoming") {
    return nativeEndpoint(backend, config.host, port ?? 10200, config.model);
  }
  if (port !== undefined) {
    if (["mlx-audio", "kokoro", "pocket-tts", "audiocpp"].includes(backend)) {
      return httpEndpoint(backend, config.host, port, "/v1/models", config.model);
    }
    if (backend === "vibevoice") {
      return httpEndpoint(backend, config.host, port, "/v1/health", config.model);
    }
  }
  return {
    summary: unknownEndpointSummary(backend, config.host, port, config.model),
    unprobedReason: "no status probe is defined for this backend",
  };
}

function openAiPlan(
  config: LLMProviderConfig,
  env: Record<string, string | undefined>,
): EndpointPlan {
  const backend = config.backend ?? "openai";
  const target = resolveOpenAiTarget(config);
  let parsed: URL;
  try {
    parsed = new URL(target.baseUrl);
  } catch {
    return {
      summary: networkSummary(backend, target.baseUrl, config.model),
      problem: "base URL is invalid",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      summary: networkSummary(backend, target.baseUrl, config.model),
      problem: `unsupported URL scheme ${parsed.protocol}`,
    };
  }
  const apiKey = config.apiKey ?? env[target.apiKeyEnv] ?? "";
  const summary = networkSummary(backend, `${target.baseUrl}/models`, config.model);
  if (!apiKey && !isKeylessHost(parsed.hostname)) {
    return { summary, problem: `${target.apiKeyEnv} is not set` };
  }
  // Match OpenAiProvider.health() exactly: some gateways require the content
  // type and agent/session headers even for their GET /models route.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(config.extraHeaders ?? {}),
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return { summary, request: { url: `${target.baseUrl}/models`, headers } };
}

function llmPlan(
  config: LLMProviderConfig,
  env: Record<string, string | undefined>,
): EndpointPlan {
  const backend = config.backend ?? "unknown";
  if (!SUPPORTED_LLM.has(backend)) {
    return {
      summary: unknownEndpointSummary(backend, config.host, config.port, config.model),
      fatalProblem: "unsupported by the Cicero LLM factory",
    };
  }
  if (OPENAI_COMPATIBLE_BACKENDS.includes(backend)) return openAiPlan(config, env);
  if (backend === "mlx-lm") return httpEndpoint(backend, config.host, config.port ?? 8081, "/v1/models", config.model);
  if (backend === "ollama") return httpEndpoint(backend, config.host, config.port ?? 11434, "/api/tags", config.model);
  if (backend === "llama-cpp") return httpEndpoint(backend, config.host, config.port ?? 8080, "/health", config.model);
  return {
    summary: unknownEndpointSummary(backend, config.host, config.port, config.model),
    unprobedReason: "no status probe is defined for this backend",
  };
}

/** A fetch health check that never reads an unbounded response body. */
export async function httpStatusProbe(request: StatusProbeRequest): Promise<boolean> {
  try {
    const response = await fetch(request.url, {
      headers: request.headers,
      signal: request.signal,
    });
    return await responseIsOk(response);
  } catch {
    return false;
  }
}

async function probePlan(
  name: string,
  plan: EndpointPlan,
  probe: (request: StatusProbeRequest) => Promise<boolean>,
  timeoutMs: number,
  skipReason?: string,
): Promise<StatusLine> {
  if (plan.fatalProblem) {
    return { name, level: "fail", detail: `${plan.summary} · ${plan.fatalProblem}` };
  }
  if (skipReason) return { name, level: "info", detail: `${plan.summary} · ${skipReason}` };
  if (plan.problem) return { name, level: "fail", detail: `${plan.summary} · ${plan.problem}` };
  if (!plan.request) {
    return {
      name,
      level: plan.unprobedLevel ?? "warn",
      detail: `${plan.summary} · ${plan.unprobedReason ?? "not probed"}`,
    };
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<boolean>((resolveDeadline) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`${name} status probe timed out after ${timeoutMs}ms`));
        resolveDeadline(false);
      }, timeoutMs);
    });
    const healthy = await Promise.race([
      probe({ ...plan.request!, signal: controller.signal }),
      deadline,
    ]).catch(() => false);
    return {
      name,
      level: healthy ? "ok" : "fail",
      detail: `${plan.summary} · ${healthy ? "reachable" : "unreachable"}`,
    };
  } catch {
    return { name, level: "fail", detail: `${plan.summary} · unreachable` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function withinDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error: unknown) {
    throw error instanceof Error ? error : new Error(`${label} failed: ${String(error)}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function daemonLine(inspection: DaemonPidInspection): StatusLine {
  switch (inspection.kind) {
    case "running":
      return { name: "Daemon", level: "ok", detail: `running (pid ${inspection.record.pid})` };
    case "stale":
      return { name: "Daemon", level: "fail", detail: `not running; stale marker (${concise(inspection.reason)})` };
    case "unsafe":
      return { name: "Daemon", level: "warn", detail: `marker could not be verified (${concise(inspection.reason)})` };
    case "absent":
      return { name: "Daemon", level: "fail", detail: "not running" };
  }
}

async function checkDaemon(
  inspect: (path: string) => Promise<DaemonPidInspection>,
  path: string,
  timeoutMs: number,
): Promise<StatusLine> {
  try {
    return daemonLine(await withinDeadline(inspect(path), timeoutMs, "daemon marker check"));
  } catch (error: unknown) {
    return {
      name: "Daemon",
      level: "warn",
      detail: `marker check failed (${concise(error instanceof Error ? error.message : String(error))})`,
    };
  }
}

function brainHttpPlan(
  config: RuntimeConfig,
  env: Record<string, string | undefined>,
): EndpointPlan | null {
  const brain = config.brain;
  if (brain.backend === "ollama") {
    return httpEndpoint(
      "ollama",
      undefined,
      brain.ollama_port ?? 11434,
      "/api/tags",
      brain.ollama_model ?? "qwen3.5:0.8b",
    );
  }
  if (!OPENAI_COMPATIBLE_BACKENDS.includes(brain.backend)) return null;
  const headers: Record<string, string> = { ...(brain.headers ?? {}) };
  if (brain.session_header) {
    // Runtime creates one UUID per brain session and sends it on every HTTP
    // request. A status probe must honor the same gateway/auth contract without
    // reusing or exposing the daemon's live conversation identity.
    headers[brain.session_header] = crypto.randomUUID();
  }
  return openAiPlan({
    backend: brain.backend,
    baseUrl: brain.base_url,
    model: brain.model,
    apiKey: brain.api_key,
    apiKeyEnv: brain.api_key_env,
    extraHeaders: headers,
  }, env);
}

function defaultBrainBinary(backend: string): string {
  return backend === "claude-code" ? "claude" : backend === "acp" ? "hermes" : backend;
}

async function binaryAvailable(
  binary: string,
  which: (value: string) => string | null,
  isExecutable: (path: string) => Promise<boolean>,
  timeoutMs: number,
): Promise<{ available: boolean; resolved: string }> {
  let onPath: string | null;
  try {
    onPath = which(binary);
  } catch {
    onPath = null;
  }
  if (onPath) return { available: true, resolved: onPath };
  // A bare command is resolved exclusively through PATH. Treating an
  // unrelated same-name file in cwd as runnable is a false positive because
  // Bun.spawn does not implicitly execute cwd entries.
  if (!isAbsolute(binary) && !binary.includes("/") && !binary.includes("\\")) {
    return { available: false, resolved: binary };
  }
  try {
    const executable = await withinDeadline(
      isExecutable(binary),
      timeoutMs,
      `${binary} executable check`,
    );
    return { available: executable, resolved: binary };
  } catch {
    return { available: false, resolved: binary };
  }
}

async function checkBrain(
  config: RuntimeConfig,
  env: Record<string, string | undefined>,
  probe: (request: StatusProbeRequest) => Promise<boolean>,
  which: (value: string) => string | null,
  isExecutable: (path: string) => Promise<boolean>,
  timeoutMs: number,
): Promise<StatusLine> {
  try {
    const brain = config.brain;
    if (brain.mode === "tab-inject" && brain.backend === "claude-code") {
      const target = brain.target_tab ?? "cicero-brain";
      return {
        name: "Brain",
        level: "info",
        detail: `claude-code tab-inject → ${JSON.stringify(concise(target, 120))}`,
      };
    }

    const httpPlan = brainHttpPlan(config, env);
    if (httpPlan) return await probePlan("Brain", httpPlan, probe, timeoutMs);

    if (SUBPROCESS_BRAINS.has(brain.backend)) {
      const binary = brain.binary ?? defaultBrainBinary(brain.backend);
      const availability = await binaryAvailable(binary, which, isExecutable, timeoutMs);
      const args = brain.binary_args?.length ?? (brain.backend === "acp" ? 1 : 0);
      const transport = brain.backend === "acp" ? "ACP stdio" : "subprocess";
      return {
        name: "Brain",
        level: availability.available ? "ok" : "fail",
        detail: `${brain.backend} ${transport} via ${concise(availability.resolved, 160)} · ${args} configured arg${args === 1 ? "" : "s"}${availability.available ? "" : " · binary not found or not executable"}`,
      };
    }

    return {
      name: "Brain",
      level: "fail",
      detail: `${concise(brain.backend, 100)} · unsupported by the Cicero brain factory`,
    };
  } catch (error: unknown) {
    return {
      name: "Brain",
      level: "fail",
      detail: `status check failed (${concise(error instanceof Error ? error.message : String(error))})`,
    };
  }
}

function statusTerminalExecutor(timeoutMs: number): TerminalCommandExecutor {
  return async (args: string[], options: TerminalCommandOptions = {}) => {
    const label = options.label ?? args.slice(0, 3).join(" ");
    try {
      const result = await runBoundedCommand(args, {
        timeoutMs: Math.min(options.timeoutMs ?? timeoutMs, timeoutMs),
        terminateGraceMs: 100,
        stdoutLimitBytes: options.captureStdout ? STATUS_STDOUT_LIMIT_BYTES : 1_024,
        stderrLimitBytes: STATUS_STDERR_LIMIT_BYTES,
        totalLimitBytes: (options.captureStdout ? STATUS_STDOUT_LIMIT_BYTES : 1_024)
          + STATUS_STDERR_LIMIT_BYTES,
        outputLimitBehavior: "error",
      });
      if (result.exitCode !== 0) {
        const detail = concise(result.stderr.text, 160);
        throw new Error(`${label} exited ${result.exitCode}${detail ? `: ${detail}` : ""}`);
      }
      return {
        stdout: options.captureStdout ? result.stdout.text : "",
        stderr: result.stderr.text,
        exitCode: result.exitCode,
      };
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(`${label} failed: ${String(error)}`);
    }
  };
}

async function checkTerminalAndTab(
  config: RuntimeConfig,
  terminalKind: ConcreteTerminal,
  createTerminal: NonNullable<StatusDependencies["createTerminal"]>,
  timeoutMs: number,
): Promise<StatusLine[]> {
  if (terminalKind === "none") {
    return [
      {
        name: "Terminal",
        level: "fail",
        detail: "tab-inject requires kitty, tmux, or wezterm; none detected/configured",
      },
      { name: "Brain tab", level: "fail", detail: "not checked because terminal integration is unavailable" },
    ];
  }

  const concreteConfig = new RuntimeConfigValue({ ...config.raw, terminal: terminalKind });
  let terminal: TerminalAdapter;
  try {
    terminal = createTerminal(concreteConfig, statusTerminalExecutor(timeoutMs));
  } catch (error: unknown) {
    return [{
      name: "Terminal",
      level: "fail",
      detail: concise(error instanceof Error ? error.message : String(error)),
    }];
  }

  try {
    const health = await withinDeadline(terminal.health(), timeoutMs, `${terminalKind} health check`);
    if (!health.ok) {
      return [
        { name: "Terminal", level: "fail", detail: `${terminalKind} unavailable (${concise(health.reason ?? "health check failed")})` },
        { name: "Brain tab", level: "fail", detail: "not checked because terminal integration is unavailable" },
      ];
    }
  } catch (error: unknown) {
    return [
      { name: "Terminal", level: "fail", detail: concise(error instanceof Error ? error.message : String(error)) },
      { name: "Brain tab", level: "fail", detail: "not checked because terminal integration is unavailable" },
    ];
  }

  const target = config.brain.target_tab ?? "cicero-brain";
  try {
    const tabs = await withinDeadline(terminal.listTabs(), timeoutMs, `${terminalKind} tab listing`);
    const found = tabs.some((tab) => tab.title.toLowerCase().includes(target.toLowerCase()));
    return [
      { name: "Terminal", level: "ok", detail: `${terminalKind} available` },
      {
        name: "Brain tab",
        level: found ? "ok" : "fail",
        detail: `${JSON.stringify(concise(target, 120))} ${found ? "found" : "not found"}`,
      },
    ];
  } catch (error: unknown) {
    return [
      { name: "Terminal", level: "ok", detail: `${terminalKind} available` },
      { name: "Brain tab", level: "fail", detail: concise(error instanceof Error ? error.message : String(error)) },
    ];
  }
}

/** Match Bun.spawn's direct-path requirement instead of accepting any file. */
async function executableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    if (process.platform === "win32") {
      const allowed = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (!allowed.includes(extname(path).toLowerCase())) return false;
      await access(path, fsConstants.F_OK);
    } else {
      await access(path, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function canonicalHotkey(value: string): string {
  const parts = value.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts.pop() ?? "";
  const aliases: Readonly<Record<string, string>> = {
    control: "ctrl",
    option: "alt",
    command: "cmd",
    meta: "cmd",
  };
  const modifiers = new Set(parts.map((part) => aliases[part] ?? part));
  const ordered = ["ctrl", "alt", "shift", "cmd"].filter((part) => modifiers.delete(part));
  ordered.push(...[...modifiers].sort());
  return [...ordered, aliases[key] ?? key].filter(Boolean).join("+");
}

async function checkHotkey(
  path: string,
  hotkey: string,
  isExecutable: (value: string) => Promise<boolean>,
  timeoutMs: number,
  platform: typeof process.platform,
): Promise<StatusLine> {
  if (platform !== "darwin") {
    return {
      name: "Hotkey",
      level: "warn",
      detail: `${concise(hotkey, 80)} · native helper is macOS-only; typed/web voice remains available`,
    };
  }
  try {
    const executable = await withinDeadline(
      isExecutable(path),
      timeoutMs,
      "hotkey helper executable check",
    );
    const configured = concise(hotkey, 80);
    if (!executable) {
      return {
        name: "Hotkey",
        level: "warn",
        detail: `${configured} · helper missing or not executable (run bun run build:hotkey); typed/web voice remains available`,
      };
    }
    if (canonicalHotkey(hotkey) !== DEFAULT_HELPER_HOTKEY) {
      return {
        name: "Hotkey",
        level: "warn",
        detail: `${configured} · helper is executable but currently listens for ${DEFAULT_HELPER_HOTKEY}; typed/web voice remains available`,
      };
    }
    return {
      name: "Hotkey",
      level: "ok",
      detail: `${configured} · helper executable`,
    };
  } catch (error: unknown) {
    return {
      name: "Hotkey",
      level: "warn",
      detail: `helper check failed (${concise(error instanceof Error ? error.message : String(error))})`,
    };
  }
}

/** Collect deterministic status rows for the configuration the daemon will actually use. */
export async function collectStatus(
  config: RuntimeConfig,
  dependencies: StatusDependencies = {},
): Promise<StatusLine[]> {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("status timeoutMs must be a positive safe integer");
  }
  const env = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const inspect = dependencies.inspectDaemon ?? inspectDaemonPidFile;
  const probe = dependencies.probe ?? httpStatusProbe;
  const which = dependencies.which ?? ((binary: string) => Bun.which(binary));
  const isExecutable = dependencies.isExecutable ?? executableFile;
  const createTerminal = dependencies.createTerminal ?? createTerminalAdapter;
  const pidFile = dependencies.pidFile ?? ciceroPath("cicero.pid");
  const hotkeyPath = dependencies.hotkeyPath
    ?? resolve(import.meta.dir, "../../helpers/cicero-hotkey");
  const pairingStateFile = dependencies.pairingStateFile
    ?? ciceroPath("web-voice", "pairing.json");
  let pairing: StatusLine | null = null;
  try {
    const state = (dependencies.readPairingState ?? readPairingState)(pairingStateFile);
    if (state) {
      pairing = {
        name: "Phone pairing",
        level: state.tunnelUrl ? "ok" : "info",
        detail: `${state.tunnelProvider ?? "no"} tunnel · URL ${state.tunnelUrl ? "published" : "not published"}`,
      };
    }
  } catch {
    // Pairing publication is best-effort; status remains useful if it is stale,
    // malformed, or temporarily being atomically replaced.
  }

  const daemon = checkDaemon(inspect, pidFile, timeoutMs);
  const stt = probePlan("STT", sttPlan(config.sttBackend), probe, timeoutMs);
  const sttFallback = config.sttFallbackBackend
    ? probePlan("STT fallback", sttPlan(config.sttFallbackBackend), probe, timeoutMs)
    : null;
  const ttsSkip = config.ttsEnabled ? undefined : "disabled; health probe skipped";
  const tts = probePlan("TTS", ttsPlan(config.ttsBackend, env), probe, timeoutMs, ttsSkip);
  const ttsFallback = config.ttsFallbackBackend
    ? probePlan("TTS fallback", ttsPlan(config.ttsFallbackBackend, env), probe, timeoutMs, ttsSkip)
    : null;
  const llm = probePlan("LLM", llmPlan(config.llmBackend, env), probe, timeoutMs);
  const brain = checkBrain(config, env, probe, which, isExecutable, timeoutMs);

  const usesTab = config.brain.mode === "tab-inject" && config.brain.backend === "claude-code";
  const terminalKind = config.terminal === "auto"
    ? detectTerminal(env)
    : config.terminal as ConcreteTerminal;
  const terminal = usesTab
    ? checkTerminalAndTab(config, terminalKind, createTerminal, timeoutMs)
    : null;
  const hotkey = config.headless
    ? null
    : checkHotkey(hotkeyPath, config.hotkey, isExecutable, timeoutMs, platform);

  const [daemonLineResult, sttLine, sttFallbackLine, ttsLine, ttsFallbackLine, llmLine, brainLine, terminalLines, hotkeyLine] = await Promise.all([
    daemon,
    stt,
    sttFallback,
    tts,
    ttsFallback,
    llm,
    brain,
    terminal,
    hotkey,
  ]).catch((error: unknown) => {
    throw error instanceof Error
      ? error
      : new Error(`status collection failed: ${String(error)}`);
  });

  return [
    daemonLineResult,
    ...(pairing ? [pairing] : []),
    sttLine,
    ...(sttFallbackLine ? [sttFallbackLine] : []),
    ttsLine,
    ...(ttsFallbackLine ? [ttsFallbackLine] : []),
    llmLine,
    brainLine,
    ...(terminalLines ?? []),
    ...(hotkeyLine ? [hotkeyLine] : []),
  ];
}

const STATUS_ICONS: Readonly<Record<StatusLevel, string>> = {
  ok: "✓",
  fail: "✗",
  warn: "!",
  info: "•",
};

export function renderStatus(lines: readonly StatusLine[]): string {
  const rows = lines.map((line) => (
    `  ${line.name.padEnd(22)} ${STATUS_ICONS[line.level]} ${line.detail}`
  ));
  return ["", "  Cicero Status", "  ─────────────", ...rows, ""].join("\n");
}
