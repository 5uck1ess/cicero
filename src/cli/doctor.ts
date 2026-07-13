import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadConfig, type RuntimeConfig } from "../config";
import { ciceroHome } from "../platform/paths";
import {
  findVenvPython,
  MLX_MIN_MACOS_MAJOR,
  supportsCurrentMlx,
} from "../platform/python";
import {
  resolveSmartTurnRuntime,
  SMART_TURN_MIGRATION_COMMAND,
} from "../backends/turn/smart-turn";
import type { BackendConfig } from "../types";
import { parseManifest } from "../voice/manifest";
import {
  voiceProviderContract,
  voiceProviderContractForBackend,
} from "../voice/provider-contract";
import { ElevenLabsProvider } from "../backends/tts/elevenlabs";
import { audioCppLocalRuntimePaths } from "../backends/tts/audiocpp";
import { ttsDefaultPort, type TTSProviderConfig } from "../backends/tts/provider";
import { sttDefaultPort } from "../backends/stt/provider";
import { LLM_DEFAULT_MODEL, normalizedLlmModel } from "../backends/llm/provider";
import type { LLMProviderConfig } from "../backends/llm/provider";
import {
  OPENAI_COMPATIBLE_BACKENDS,
  openAiBaseUrlForDisplay,
  resolveOpenAiTarget,
} from "../backends/llm/openai";
import { httpBase, isKeylessHost, isLocalHost } from "../backends/net";
import {
  providerSignal,
  readBoundedJson,
  responseIsOk,
} from "../backends/http-transfer";
import {
  runBoundedCommand,
  type BoundedCommandOptions,
  type BoundedCommandResult,
} from "../process/bounded-command";
import {
  backendConfigKey,
  supportedBackendHint,
  supportedBackendsForRole,
} from "../backends/supported-backends";
import { createBrain } from "../brain";
import { detectTerminal } from "../terminal/detect";
import {
  WEB_VOICE_TOKEN_GENERATION_HINT,
  webVoiceTokenProblem,
} from "../web-voice/startup-policy";

/**
 * `cicero doctor` — first-run and it-broke triage. Walks the CONFIGURED setup
 * (not every possible backend): config file, engine venvs, server health,
 * brain binaries, web-voice basics, system tools. Every failure comes with
 * the command that fixes it, so "it doesn't work" issues become self-service.
 */

export type Level = "ok" | "warn" | "fail";
export interface Check {
  name: string;
  level: Level;
  detail: string;
  hint?: string;
}

export interface DoctorCheckOptions {
  /** Overrides for deterministic platform-capability tests. */
  platform?: string;
  osRelease?: string;
  /** Binary resolver override for deterministic prerequisite tests. */
  which?: (binary: string) => string | null;
  /** Cicero state directory override for generated-material tests. */
  ciceroHome?: string;
  projectRoot?: string;
  cloudProbeTimeoutMs?: number;
  /** Resolved `terminal: auto` override for deterministic brain-mode tests. */
  detectedTerminal?: "kitty" | "wezterm" | "tmux" | "none";
  /** Environment override for deterministic API credential checks. */
  env?: Record<string, string | undefined>;
  /** Injectable bounded runner for deterministic subprocess diagnostics. */
  runCommand?: DoctorCommandRunner;
}

export type DoctorCommandRunner = (
  command: readonly string[],
  options?: BoundedCommandOptions,
) => Promise<BoundedCommandResult>;

const DOCTOR_IMPORT_TIMEOUT_MS = 10_000;
const DOCTOR_GPU_TIMEOUT_MS = 3_000;
const DOCTOR_HTTP_TIMEOUT_MS = 1_500;
const DOCTOR_HTTP_JSON_LIMIT_BYTES = 256 * 1024;

const projectRoot = dirname(dirname(import.meta.dir));

/** Quote an absolute path for the user's native shell. */
export function quoteDoctorPath(path: string, platform: string = process.platform): string {
  // Windows forbids quotes in path components; double quotes work in both cmd
  // and PowerShell. POSIX single quotes also protect $, backticks, and spaces.
  return platform === "win32"
    ? `"${path}"`
    : `'${path.replaceAll("'", "'\\''")}'`;
}

/** Build a setup command that remains valid when doctor runs outside the repo. */
export function buildVenvHint(
  venv: string,
  pythonVersion: string,
  requirementsFile: string,
  root: string = projectRoot,
  installArgs: string[] = [],
): string {
  const venvPath = join(root, venv);
  const manifestPath = join(root, "requirements", requirementsFile);
  return `uv venv ${quoteDoctorPath(venvPath)} --python ${pythonVersion} && uv pip install --python ${quoteDoctorPath(venvPath)} -r ${quoteDoctorPath(manifestPath)}${installArgs.length > 0 ? ` ${installArgs.join(" ")}` : ""}`;
}

/** Shell-independent guidance with an absolute checked-in config template. */
export function buildConfigCopyHint(configPath: string, root: string = projectRoot): string {
  return `copy ${quoteDoctorPath(join(root, "config.yaml.example"))} to ${quoteDoctorPath(configPath)}, then edit it`;
}

/** Native OpenSSL install guidance for automatic web-voice TLS generation. */
export function opensslInstallHint(platform: string = process.platform): string {
  if (platform === "win32") return "scoop install openssl";
  if (platform === "darwin") return "brew install openssl";
  return "sudo apt install openssl   # Debian/Ubuntu; use your distro package manager elsewhere";
}

/** Engine backend → the dedicated venv python it launches from (see src/backends). */
const VENV_BY_BACKEND: Record<string, string> = {
  "faster-whisper": ".venv-stt",
  "pocket-tts": ".venv-pocket",
  kokoro: ".venv-kokoro",
  vibevoice: ".venv-vibevoice",
  "mlx-whisper": ".venv",
  "mlx-audio": ".venv",
  "mlx-lm": ".venv",
};

const VENV_HINT_SPEC: Record<string, {
  pythonVersion: string;
  requirementsFile: string;
  installArgs?: string[];
}> = {
  ".venv-stt": { pythonVersion: "3.10", requirementsFile: "faster-whisper.txt" },
  ".venv-pocket": { pythonVersion: "3.11", requirementsFile: "pocket-tts.txt" },
  ".venv-kokoro": { pythonVersion: "3.11", requirementsFile: "kokoro.txt" },
  ".venv-vibevoice": { pythonVersion: "3.11", requirementsFile: "vibevoice.txt" },
  ".venv": { pythonVersion: "3.12", requirementsFile: "mlx.txt", installArgs: ["--prerelease=allow"] },
};

function backendVenvHint(venv: string, root: string): string | undefined {
  const spec = VENV_HINT_SPEC[venv];
  return spec
    ? buildVenvHint(venv, spec.pythonVersion, spec.requirementsFile, root, spec.installArgs ?? [])
    : undefined;
}

const HEALTH_PATH: Record<string, string> = {
  "faster-whisper": "/health",
  "pocket-tts": "/v1/models",
  kokoro: "/v1/models",
  vibevoice: "/v1/health",
  "mlx-audio": "/v1/models",
  "mlx-whisper": "/",
  "mlx-lm": "/v1/models",
};

const LLM_DEFAULT_PORT: Readonly<Record<string, number>> = {
  "mlx-lm": 8081,
  ollama: 11434,
  "llama-cpp": 8080,
};

/** Importable module that proves the managed backend package was installed. */
const MODULE_BY_BACKEND: Record<string, string> = {
  vibevoice: "vibevoice_api.server",
};

function isRemote(host?: string): boolean {
  return !isLocalHost(host);
}

async function doctorRequest<T>(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> | undefined,
  consume: (response: Response) => Promise<T>,
): Promise<T | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = (async (): Promise<T | undefined> => {
      try {
        const response = await fetch(url, {
          headers,
          signal: providerSignal(timeoutMs, controller.signal),
        });
        return await consume(response);
      } catch {
        return undefined;
      }
    })();
    const deadline = new Promise<undefined>((resolveDeadline) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`doctor HTTP probe timed out after ${timeoutMs}ms`));
        resolveDeadline(undefined);
      }, timeoutMs);
    });
    return await Promise.race([request, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function probe(
  url: string,
  timeoutMs = DOCTOR_HTTP_TIMEOUT_MS,
  headers?: Record<string, string>,
): Promise<boolean> {
  return (await doctorRequest(url, timeoutMs, headers, responseIsOk)) ?? false;
}

async function pythonImportsModules(
  python: string,
  modules: string[],
  runCommand: DoctorCommandRunner,
): Promise<boolean> {
  try {
    const code = "import importlib,sys; [importlib.import_module(m) for m in sys.argv[1:]]";
    const result = await runCommand([python, "-c", code, ...modules], {
      timeoutMs: DOCTOR_IMPORT_TIMEOUT_MS,
      stdoutLimitBytes: 0,
      stderrLimitBytes: 0,
      totalLimitBytes: 0,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function checkEngine(
  role: string,
  cfg: (BackendConfig & Pick<TTSProviderConfig, "voice" | "apiKey">) | undefined,
  checks: Check[],
  options: DoctorCheckOptions = {},
  implicitDefault = false,
): Promise<void> {
  if (!cfg?.backend) return;
  const root = options.projectRoot ?? projectRoot;
  const runCommand = options.runCommand ?? runBoundedCommand;
  const label = `${role} (${cfg.backend})`;
  const configKey = backendConfigKey(role);
  const validValues = supportedBackendsForRole(role);
  const record = (check: Omit<Check, "name">): void => {
    if (check.level === "ok" || !configKey || !validValues) {
      checks.push({ name: label, ...check });
      return;
    }
    const prefix = implicitDefault ? "implicit " : "";
    checks.push({
      name: label,
      ...check,
      detail: `${prefix}${configKey}='${cfg.backend}': ${check.detail}`,
      hint: `${check.hint ? `${check.hint}; ` : ""}${supportedBackendHint(configKey, validValues)}`,
    });
  };
  if (validValues && !validValues.includes(cfg.backend)) {
    record({
      level: "fail",
      detail: "the configured backend is unsupported by the built-in provider registry",
      hint: "choose an implemented backend, then rerun cicero doctor",
    });
    return;
  }
  const sttRole = role.startsWith("stt");
  const ttsRole = role.startsWith("tts");
  const llmRole = role === "llm";
  const voiceContract = role.startsWith("tts")
    ? voiceProviderContractForBackend(cfg.backend)
    : null;
  const sttRuntimeContract = sttRole && cfg.backend === "audiocpp"
    ? voiceProviderContractForBackend(cfg.backend)
    : null;
  const runtimeContract = voiceContract ?? sttRuntimeContract;
  const port = cfg.port
    ?? (sttRole ? sttDefaultPort(cfg.backend) : undefined)
    ?? (ttsRole ? ttsDefaultPort(cfg.backend) : undefined)
    ?? (llmRole ? LLM_DEFAULT_PORT[cfg.backend] : undefined)
    ?? runtimeContract?.defaultPort
    ?? undefined;

  if ((sttRole || ttsRole) && cfg.backend === "wyoming") {
    const endpoint = httpBase(isRemote(cfg.host) ? cfg.host : "127.0.0.1", port ?? 10_300)
      .replace(/^http:\/\//, "");
    record({
      level: "warn",
      detail: `external Wyoming endpoint ${endpoint} is configured but is not HTTP-probed by doctor`,
      hint: "verify the Wyoming service with its native client and confirm host/port in config",
    });
    return;
  }

  if (runtimeContract?.runtime === "cloud") {
    const inlineApiKey = typeof cfg.apiKey === "string" ? cfg.apiKey.trim() : "";
    const apiKey = inlineApiKey || process.env.ELEVENLABS_API_KEY?.trim();
    if (!apiKey) {
      record({
        level: "fail",
        detail: "ELEVENLABS_API_KEY is not set — cloud TTS cannot authenticate",
        hint: "export ELEVENLABS_API_KEY=<your-key>, then rerun cicero doctor",
      });
      return;
    }
    if (!cfg.voice?.trim()) {
      record({
        level: "fail",
        detail: "no ElevenLabs voice ID is configured",
        hint: "cicero voice add <name> <clip> --provider elevenlabs && cicero voice use <name>",
      });
      return;
    }
    const up = await new ElevenLabsProvider({ ...cfg, apiKey }).health(
      options.cloudProbeTimeoutMs ?? 1_500,
    );
    record(up
      ? { level: "ok", detail: `cloud voice '${cfg.voice}' is reachable` }
      : {
          level: "fail",
          detail: `ElevenLabs voice '${cfg.voice}' could not be verified`,
          hint: "check ELEVENLABS_API_KEY, the configured voice ID, and network access",
        });
    return;
  }

  if (cfg.backend.startsWith("mlx-") && !isRemote(cfg.host)
    && !supportsCurrentMlx(options.platform, options.osRelease)) {
    record({
      level: implicitDefault ? "warn" : "fail",
      detail: implicitDefault
        ? `implicit ${cfg.backend} default is unavailable here; the checked-in MLX versions require macOS ${MLX_MIN_MACOS_MAJOR} or newer`
        : `the checked-in MLX versions require macOS ${MLX_MIN_MACOS_MAJOR} or newer`,
      hint: implicitDefault
        ? `configure an explicit non-MLX/remote ${role} backend if the local router is needed`
        : `upgrade macOS or configure a non-MLX/remote ${role} backend`,
    });
    return;
  }
  const host = isRemote(cfg.host) ? cfg.host! : "127.0.0.1";
  const health = runtimeContract?.healthPath ?? HEALTH_PATH[cfg.backend];
  const up = port && health ? await probe(`${httpBase(host, port)}${health}`) : false;

  if (isRemote(cfg.host)) {
    record(up
      ? { level: "ok", detail: `remote ${cfg.host}:${port} is healthy` }
      : { level: "fail", detail: `remote ${cfg.host}:${port} not responding`, hint: `start the ${cfg.backend} server on ${cfg.host} or fix host/port in config` });
    return;
  }

  if (runtimeContract?.runtime === "local-binary") {
    const runtime = audioCppLocalRuntimePaths(root);
    const missing = [
      !existsSync(runtime.binary) ? `binary ${runtime.binary}` : null,
      !existsSync(runtime.serverConfig) ? `config ${runtime.serverConfig}` : null,
    ].filter((item): item is string => item !== null);
    if (missing.length > 0) {
      record({
        level: up ? "warn" : "fail",
        detail: up
          ? `server is up on :${port}, but the daemon cannot relaunch it (${missing.join("; ")})`
          : `local audio.cpp runtime is incomplete: ${missing.join("; ")}`,
        hint: "build vendor/audio.cpp with the linux-cuda-release preset and create servers/audiocpp_server.local.json",
      });
    } else {
      record(up
        ? { level: "ok", detail: `running on :${port}` }
        : { level: "ok", detail: `local binary/config present; daemon will launch it on :${port} at start` });
    }
    return;
  }

  const venv = VENV_BY_BACKEND[cfg.backend];
  const python = venv ? findVenvPython(join(root, venv)) : undefined;
  if (venv && !python) {
    record({
      level: up ? "warn" : "fail",
      detail: up ? `server is up on :${port} but ${venv} has no interpreter (daemon can't relaunch it)` : `${venv} has no Python interpreter — the daemon cannot launch this engine`,
      hint: backendVenvHint(venv, root),
    });
    return;
  }
  const requiredModule = MODULE_BY_BACKEND[cfg.backend];
  if (python && requiredModule && !(await pythonImportsModules(python, [requiredModule], runCommand))) {
    record({
      level: up ? "warn" : "fail",
      detail: up
        ? `server is up on :${port} but ${requiredModule} cannot import (daemon can't relaunch it)`
        : `${requiredModule} or one of its runtime dependencies cannot import in ${venv}`,
      hint: backendVenvHint(venv!, root),
    });
    return;
  }
  record(up
    ? { level: "ok", detail: `running on :${port}` }
    : { level: "ok", detail: `venv present; daemon will launch it on :${port} at start` });
}

async function ollamaModels(
  url: string,
  timeoutMs: number,
): Promise<string[] | undefined> {
  return await doctorRequest(url, timeoutMs, undefined, async (response) => {
    if (!response.ok) {
      await responseIsOk(response);
      throw new Error(`Ollama tags endpoint returned ${response.status}`);
    }
    const data = await readBoundedJson<{ models?: unknown }>(
      response,
      DOCTOR_HTTP_JSON_LIMIT_BYTES,
      "Ollama tags response",
    );
    if (!Array.isArray(data.models)) throw new Error("Ollama tags response has no models array");
    const names: string[] = [];
    for (const item of data.models) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const model = item as Record<string, unknown>;
      for (const key of ["name", "model"] as const) {
        if (typeof model[key] === "string" && model[key].trim()) names.push(model[key].trim());
      }
    }
    return [...new Set(names)];
  });
}

function hasOllamaModel(models: readonly string[], configured: string): boolean {
  const expected = configured.trim();
  return models.some((candidate) => (
    candidate === expected
    || (!expected.includes(":") && candidate === `${expected}:latest`)
  ));
}

function localGgufProblem(path: string): string | undefined {
  if (!existsSync(path)) return `GGUF model file does not exist: ${path}`;
  try {
    if (!statSync(path).isFile()) return `GGUF model path is not a regular file: ${path}`;
    accessSync(path, constants.R_OK);
  } catch {
    return `GGUF model file is not readable: ${path}`;
  }
  return undefined;
}

function isHuggingFaceGgufRepo(model: string): boolean {
  // llama-server's -hf contract is owner/repo with an optional quant suffix.
  // Reject obvious local-path/config typos before startup reports a false green.
  const [repoId, quant, ...extra] = model.split(":");
  if (!repoId || extra.length > 0 || repoId.length > 96) return false;
  const segments = repoId.split("/");
  if (segments.length !== 2) return false;
  const validSegment = (segment: string): boolean => (
    segment.length > 0
    && segment.length <= 96
    && /^[a-z0-9_](?:[a-z0-9._-]*[a-z0-9_])?$/i.test(segment)
    && !segment.includes("..")
    && !segment.includes("--")
    && !segment.toLowerCase().endsWith(".git")
  );
  if (!segments.every(validSegment)) return false;
  return quant === undefined || (
    quant.length > 0
    && quant.length <= 64
    && /^[a-z0-9_](?:[a-z0-9._-]*[a-z0-9_])?$/i.test(quant)
    && !quant.includes("..")
    && !quant.includes("--")
  );
}

async function checkLlm(
  cfg: LLMProviderConfig,
  checks: Check[],
  options: DoctorCheckOptions,
  implicitDefault: boolean,
): Promise<void> {
  const backend = cfg.backend ?? "unknown";
  const validValues = supportedBackendsForRole("llm") ?? [];
  if (backend === "mlx-lm" || !validValues.includes(backend)) {
    await checkEngine("llm", cfg, checks, options, implicitDefault);
    return;
  }

  const label = `llm (${backend})`;
  const record = (check: Omit<Check, "name">): void => {
    if (check.level === "ok") {
      checks.push({ name: label, ...check });
      return;
    }
    checks.push({
      name: label,
      ...check,
      detail: `${implicitDefault ? "implicit " : ""}llm.backend='${backend}': ${check.detail}`,
      hint: `${check.hint ? `${check.hint}; ` : ""}${supportedBackendHint("llm.backend", validValues)}`,
    });
  };
  const timeoutMs = options.cloudProbeTimeoutMs ?? DOCTOR_HTTP_TIMEOUT_MS;

  if (backend === "ollama") {
    const port = cfg.port ?? LLM_DEFAULT_PORT.ollama!;
    const model = normalizedLlmModel(cfg.model, LLM_DEFAULT_MODEL.ollama);
    const remote = isRemote(cfg.host);
    const host = remote ? cfg.host! : "127.0.0.1";
    const endpoint = `${httpBase(host, port)}/api/tags`;
    const models = await ollamaModels(endpoint, timeoutMs);

    if (remote) {
      if (models === undefined) {
        record({
          level: "fail",
          detail: `remote Ollama endpoint ${endpoint} is not responding with a valid model list`,
          hint: `start Ollama on ${cfg.host} or fix llm.host/llm.port`,
        });
      } else if (!hasOllamaModel(models, model)) {
        record({
          level: "fail",
          detail: `remote Ollama endpoint is reachable, but model '${model}' is not installed`,
          hint: `run 'ollama pull ${model}' on ${cfg.host}`,
        });
      } else {
        record({ level: "ok", detail: `remote ${cfg.host}:${port} is healthy; model '${model}' is installed` });
      }
      return;
    }

    const binary = (options.which ?? ((candidate: string) => Bun.which(candidate)))("ollama");
    const installHint = binary
      ? `run: ollama pull ${model}`
      : `install Ollama so 'ollama' is on PATH, then run: ollama pull ${model}`;
    if (models === undefined) {
      record({
        level: "fail",
        detail: binary
          ? `local endpoint ${endpoint} is not responding; '${binary}' exists, but model '${model}' cannot be verified`
          : `local endpoint ${endpoint} is not responding and 'ollama' is not on PATH`,
        hint: installHint,
      });
    } else if (!hasOllamaModel(models, model)) {
      record({
        level: "fail",
        detail: `local Ollama is reachable, but model '${model}' is not installed`,
        hint: installHint,
      });
    } else if (!binary) {
      record({
        level: "warn",
        detail: `local Ollama and model '${model}' are healthy, but 'ollama' is not on PATH so Cicero cannot relaunch it`,
        hint: "install Ollama or put its CLI on PATH",
      });
    } else {
      record({ level: "ok", detail: `local Ollama is healthy; model '${model}' is installed and CLI is at ${binary}` });
    }
    return;
  }

  if (backend === "llama-cpp") {
    const port = cfg.port ?? LLM_DEFAULT_PORT["llama-cpp"]!;
    const remote = isRemote(cfg.host);
    const host = remote ? cfg.host! : "127.0.0.1";
    const endpoint = `${httpBase(host, port)}/health`;
    const up = await probe(endpoint, timeoutMs);
    if (remote) {
      record(up
        ? { level: "ok", detail: `remote llama-server ${cfg.host}:${port} is healthy` }
        : {
            level: "fail",
            detail: `remote llama-server ${endpoint} is not responding`,
            hint: `start llama-server on ${cfg.host} or fix llm.host/llm.port`,
          });
      return;
    }

    const binary = (options.which ?? ((candidate: string) => Bun.which(candidate)))("llama-server");
    const model = normalizedLlmModel(cfg.model, LLM_DEFAULT_MODEL["llama-cpp"]);
    const missing: string[] = [];
    if (!binary) missing.push("'llama-server' is not on PATH");
    if (model === LLM_DEFAULT_MODEL["llama-cpp"]) {
      missing.push("llm.model must name a GGUF file or Hugging Face GGUF repo");
    } else if (model.toLowerCase().endsWith(".gguf")) {
      const problem = localGgufProblem(model);
      if (problem) missing.push(problem);
    } else if (!isHuggingFaceGgufRepo(model)) {
      missing.push(`llm.model is not a valid Hugging Face GGUF repo (expected owner/repo[:quant]): ${model}`);
    }
    if (missing.length > 0) {
      record({
        level: up ? "warn" : "fail",
        detail: up
          ? `local llama-server is healthy, but Cicero cannot relaunch it (${missing.join("; ")})`
          : `local llama.cpp launch prerequisites are incomplete (${missing.join("; ")})`,
        hint: "install llama.cpp's llama-server on PATH and set llm.model to a readable .gguf path or owner/repo[:quant]",
      });
    } else {
      record(up
        ? { level: "ok", detail: `local llama-server is healthy on :${port}; launch prerequisites are present` }
        : { level: "ok", detail: `llama-server and model '${model}' are configured; Cicero will launch it on :${port}` });
    }
    return;
  }

  if (OPENAI_COMPATIBLE_BACKENDS.includes(backend)) {
    const target = resolveOpenAiTarget(cfg);
    let parsed: URL;
    try {
      parsed = new URL(target.baseUrl);
    } catch {
      record({
        level: "fail",
        detail: "the configured OpenAI-compatible base URL is invalid",
        hint: "set llm.baseUrl to an http:// or https:// API base ending in /v1",
      });
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      record({
        level: "fail",
        detail: `unsupported OpenAI-compatible URL scheme '${parsed.protocol}'`,
        hint: "set llm.baseUrl to an http:// or https:// API base ending in /v1",
      });
      return;
    }
    const displayBase = openAiBaseUrlForDisplay(target.baseUrl);
    if (parsed.username || parsed.password) {
      record({
        level: "fail",
        detail: `OpenAI-compatible endpoint ${displayBase} embeds URL credentials, which the provider does not support`,
        hint: "remove URL userinfo and configure llm.apiKey or llm.apiKeyEnv instead",
      });
      return;
    }
    if (parsed.search || parsed.hash) {
      record({
        level: "fail",
        detail: `OpenAI-compatible endpoint ${displayBase} contains a query string or fragment, which cannot be used as an API base`,
        hint: "remove the query/fragment and set llm.baseUrl to the API base ending in /v1",
      });
      return;
    }

    const env = options.env ?? process.env;
    // Match OpenAiProvider's nullish precedence exactly: an explicit value must
    // not make doctor test a different environment credential than runtime.
    const apiKey = cfg.apiKey ?? env[target.apiKeyEnv] ?? "";
    if (!apiKey && !isKeylessHost(parsed.hostname)) {
      record({
        level: "fail",
        detail: `${target.apiKeyEnv} is not set, so ${displayBase} cannot authenticate`,
        hint: `export ${target.apiKeyEnv}=<your-key> or set llm.apiKeyEnv to the correct environment variable`,
      });
      return;
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(cfg.extraHeaders ?? {}),
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const endpoint = `${target.baseUrl}/models`;
    const displayEndpoint = `${displayBase}/models`;
    const up = await probe(endpoint, timeoutMs, headers);
    record(up
      ? { level: "ok", detail: `${backend} endpoint ${displayEndpoint} is reachable${cfg.model ? `; model '${cfg.model}' configured` : ""}` }
      : {
          level: "fail",
          detail: `${backend} endpoint ${displayEndpoint} is not responding`,
          hint: "check llm.baseUrl, network access, and the configured API credential",
        });
    return;
  }

  await checkEngine("llm", cfg, checks, options, implicitDefault);
}

function checkBinary(
  name: string,
  binary: string,
  checks: Check[],
  which: (candidate: string) => string | null,
  hint?: string,
): void {
  const path = which(binary);
  if (path) {
    checks.push({ name, level: "ok", detail: `'${binary}' found at ${path}` });
  } else {
    checks.push({ name, level: "fail", detail: `'${binary}' not on PATH`, hint: hint ?? `install ${binary} or fix the binary/binary_args in config` });
  }
}

function checkVoice(owner: string, voice: string | undefined, checks: Check[]): void {
  if (!voice) return;
  if (voice.includes("/")) {
    if (!existsSync(voice)) {
      checks.push({ name: `${owner} voice`, level: "fail", detail: `reference file ${voice} does not exist`, hint: "cicero voice add <name> <clip.wav>, then set the name (or fix the path)" });
    } else {
      checks.push({ name: `${owner} voice`, level: "ok", detail: voice });
    }
    return;
  }
  const manifestPath = join(ciceroHome(), "voices", voice, "voice.yaml");
  if (!existsSync(manifestPath)) {
    checks.push({ name: `${owner} voice`, level: "ok", detail: `'${voice}' — not in the clone library, treated as an engine preset` });
    return;
  }
  try {
    const manifest = parseManifest(readFileSync(manifestPath, "utf-8"));
    const contract = voiceProviderContract(manifest.provider);
    const ready = contract.activation === "voice-id"
      ? Boolean(manifest.voice_id?.trim())
      : existsSync(manifest.trimmed_clip ?? manifest.source_clip);
    checks.push(ready
      ? { name: `${owner} voice`, level: "ok", detail: `'${voice}' is a provisioned ${manifest.provider} clone` }
      : { name: `${owner} voice`, level: "fail", detail: `'${voice}' has an incomplete ${manifest.provider} manifest`, hint: `remove and re-add '${voice}'` });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({ name: `${owner} voice`, level: "fail", detail, hint: `remove and re-add '${voice}'` });
  }
}

export async function collectChecks(
  config: RuntimeConfig = loadConfig(),
  options: DoctorCheckOptions = {},
): Promise<Check[]> {
  const checks: Check[] = [];
  const which = options.which ?? ((binary: string) => Bun.which(binary));
  const stateHome = options.ciceroHome ?? ciceroHome();
  const root = options.projectRoot ?? projectRoot;
  const runCommand = options.runCommand ?? runBoundedCommand;

  // -- config file --------------------------------------------------------
  const configPath = join(stateHome, "config.yaml");
  if (existsSync(configPath)) {
    checks.push({ name: "config", level: "ok", detail: configPath });
  } else {
    checks.push({
      name: "config",
      level: "warn",
      detail: `${configPath} not found — running on built-in defaults (macOS/MLX-flavored)`,
      hint: buildConfigCopyHint(configPath, root),
    });
  }

  // -- engines -------------------------------------------------------------
  await checkEngine("stt", config.sttBackend, checks, options, config.raw.stt === undefined);
  await checkEngine("stt_fallback", config.sttFallbackBackend ?? undefined, checks, options);
  await checkEngine("tts", config.ttsBackend, checks, options, config.raw.tts === undefined);
  await checkEngine("tts_fallback", config.ttsFallbackBackend ?? undefined, checks, options);
  await checkLlm(config.llmBackend, checks, options, config.raw.llm === undefined);

  // -- semantic end-of-turn sidecar ---------------------------------------
  const turn = config.turn;
  if (turn.enabled) {
    const label = `turn (${turn.backend ?? "smart-turn"})`;
    const remote = isRemote(turn.host);
    const host = remote ? turn.host! : "127.0.0.1";
    const up = await probe(`http://${host}:${turn.port}/health`);
    const turnRuntime = remote ? undefined : resolveSmartTurnRuntime(root);
    const turnPython = turnRuntime?.found ? turnRuntime.python : undefined;
    if (remote) {
      checks.push(up
        ? { name: label, level: "ok", detail: `remote ${turn.host}:${turn.port} is healthy` }
        : { name: label, level: "fail", detail: `remote ${turn.host}:${turn.port} not responding`, hint: "start the Smart-Turn server there or fix turn.host/port" });
    } else if (!turnPython) {
      checks.push({
        name: label,
        level: up ? "warn" : "fail",
        detail: up
          ? `server is up on :${turn.port} but .venv-turn has no interpreter (daemon can't relaunch it)`
          : ".venv-turn has no Python interpreter — the daemon cannot launch Smart-Turn",
        hint: buildVenvHint(".venv-turn", "3.11", "turn.txt", root),
      });
    } else if (!(await pythonImportsModules(turnPython, ["onnxruntime", "transformers", "fastapi"], runCommand))) {
      checks.push({
        name: label,
        level: up ? "warn" : "fail",
        detail: up
          ? `server is up on :${turn.port} but .venv-turn is missing runtime modules (daemon can't relaunch it)`
          : ".venv-turn is missing Smart-Turn runtime modules",
        hint: buildVenvHint(".venv-turn", "3.11", "turn.txt", root),
      });
    } else if (turnRuntime?.legacy) {
      checks.push({
        name: label,
        level: "warn",
        detail: up
          ? `running on :${turn.port} via deprecated ${turnRuntime.venv} compatibility environment`
          : `deprecated ${turnRuntime.venv} compatibility environment is present; daemon can launch it on :${turn.port}`,
        hint: `run from ${quoteDoctorPath(root)}: ${SMART_TURN_MIGRATION_COMMAND}`,
      });
    } else {
      checks.push(up
        ? { name: label, level: "ok", detail: `running on :${turn.port}` }
        : { name: label, level: "ok", detail: `venv present; daemon will launch it on :${turn.port} at start` });
    }
  }

  // -- brain ---------------------------------------------------------------
  const brain = config.brain;
  const brainBinaries: Readonly<Record<string, string>> = Object.freeze({
    acp: "hermes",
    "claude-code": "claude",
    codex: "codex",
    gemini: "gemini",
    qwen: "qwen",
  });
  const brainBinary = brainBinaries[brain.backend];
  if (brainBinary) {
    checkBinary(`brain (${brain.backend})`, brain.binary ?? brainBinary, checks, which);
  } else if (brain.backend === "ollama" || OPENAI_COMPATIBLE_BACKENDS.includes(brain.backend)) {
    let healthy = false;
    let detail = "health probe returned false";
    try {
      healthy = await createBrain(config).health();
    } catch (error: unknown) {
      detail = error instanceof Error ? error.message : String(error);
    }
    checks.push(healthy
      ? { name: `brain (${brain.backend})`, level: "ok", detail: "configured endpoint is healthy" }
      : {
          name: `brain (${brain.backend})`,
          level: "fail",
          detail: `configured endpoint is not ready (${detail.slice(0, 160)})`,
          hint: brain.backend === "ollama"
            ? "start Ollama and confirm brain.ollama_port / brain.ollama_model"
            : "check brain.base_url, brain.model, and the configured API key or api_key_env",
        });
  } else {
    checks.push({
      name: `brain (${brain.backend})`,
      level: "fail",
      detail: "backend is not implemented by the brain factory",
      hint: "use acp, claude-code, codex, gemini, qwen, ollama, openai-compatible, or a documented OpenAI preset",
    });
  }
  if (brain.backend === "claude-code" && brain.mode === "tab-inject") {
    const terminal = config.terminal === "auto"
      ? (options.detectedTerminal ?? detectTerminal())
      : config.terminal;
    checks.push(terminal === "none"
      ? {
          name: "brain mode (tab-inject)",
          level: "fail",
          detail: "terminal auto-detection resolved to none, so no interactive Claude tab can be owned",
          hint: "set brain.mode: subprocess for headless use, or run under kitty, tmux, or WezTerm",
        }
      : {
          name: "brain mode (tab-inject)",
          level: "ok",
          detail: `${terminal} terminal integration is available`,
        });
  }
  for (const [lane, l] of Object.entries(brain.lanes ?? {})) {
    checkBinary(`lane '${lane}'`, l.backend === "codex" ? (l.binary ?? "codex") : (l.binary ?? brain.binary ?? "hermes"), checks, which);
    for (const f of l.fallbacks ?? []) {
      checkBinary(`lane '${lane}' fallback`, f.backend === "codex" ? (f.binary ?? "codex") : (f.binary ?? brain.binary ?? "hermes"), checks, which);
    }
    checkVoice(`lane '${lane}'`, l.voice, checks);
  }

  // -- voices --------------------------------------------------------------
  checkVoice("active", config.raw.voice, checks);
  const configuredVoice = config.raw.tts?.voice;
  if (configuredVoice && configuredVoice !== config.raw.voice) {
    checkVoice("tts", configuredVoice, checks);
  }

  // -- web voice -----------------------------------------------------------
  const wv = config.web_voice;
  if (wv?.enabled) {
    if (!wv.token) {
      checks.push({ name: "web_voice token", level: "warn", detail: "no fixed token — a random one prints per start (notify/Telegram surfaces need a stable token)", hint: WEB_VOICE_TOKEN_GENERATION_HINT });
    } else if (webVoiceTokenProblem(wv.token)) {
      checks.push({ name: "web_voice token", level: "fail", detail: "token is a placeholder or too short — this string is the only thing between the internet and your agent", hint: WEB_VOICE_TOKEN_GENERATION_HINT });
    } else {
      checks.push({ name: "web_voice token", level: "ok", detail: `set (${wv.token.length} chars)` });
    }
    const tls = wv.tls;
    if (tls?.enabled === false) {
      checks.push({
        name: "web_voice TLS",
        level: "warn",
        detail: "explicitly disabled — remote browser audio and credentials travel over HTTP",
        hint: "remove web_voice.tls.enabled: false and install OpenSSL, or configure cert_file and key_file",
      });
    } else if (tls?.cert_file !== undefined || tls?.key_file !== undefined) {
      const certExists = !!tls.cert_file && existsSync(tls.cert_file);
      const keyExists = !!tls.key_file && existsSync(tls.key_file);
      checks.push(certExists && keyExists
        ? { name: "web_voice TLS", level: "ok", detail: "explicit certificate pair found" }
        : {
          name: "web_voice TLS",
          level: "fail",
          detail: `explicit certificate pair is incomplete (cert: ${certExists ? "found" : "missing"}, key: ${keyExists ? "found" : "missing"})`,
          hint: "configure readable paths for both web_voice.tls.cert_file and web_voice.tls.key_file",
        });
    } else {
      const tlsDir = join(stateHome, "web-voice");
      const legacyCert = existsSync(join(tlsDir, "cert.pem"));
      const legacyKey = existsSync(join(tlsDir, "key.pem"));
      const atomicPair = existsSync(join(tlsDir, ".tls-pair.json"));
      if (legacyCert !== legacyKey) {
        checks.push({
          name: "web_voice TLS",
          level: "fail",
          detail: `generated certificate pair is incomplete under ${tlsDir}`,
          hint: "move the remaining cert.pem or key.pem aside, then restart Cicero",
        });
      } else if ((legacyCert && legacyKey) || atomicPair) {
        checks.push({ name: "web_voice TLS", level: "ok", detail: `generated certificate material found under ${tlsDir}` });
      } else {
        const openssl = which("openssl");
        checks.push(openssl
          ? { name: "web_voice TLS", level: "ok", detail: `'openssl' found at ${openssl}; first start will generate a self-signed pair` }
          : {
            name: "web_voice TLS",
            level: "fail",
            detail: "automatic HTTPS needs 'openssl', but it is not on PATH and no generated certificate exists",
            hint: opensslInstallHint(options.platform),
          });
      }
    }
    const sum = wv.tldr?.summarizer_url;
    if (sum) {
      checks.push((await probe(`${sum.replace(/\/$/, "")}/models`))
        ? { name: "tldr summarizer", level: "ok", detail: sum }
        : { name: "tldr summarizer", level: "warn", detail: `${sum} not responding — TLDR codas fall back to a generic line`, hint: "start the summarizer endpoint or remove web_voice.tldr" });
    }
  }

  // -- input-side tone (speech emotion) -------------------------------------
  const tone = config.tone;
  if (tone.enabled) {
    if (isRemote(tone.host)) {
      checks.push((await probe(`http://${tone.host}:${tone.port}/health`))
        ? { name: "tone (emotion2vec)", level: "ok", detail: `remote ${tone.host}:${tone.port} is healthy` }
        : { name: "tone (emotion2vec)", level: "warn", detail: `remote ${tone.host}:${tone.port} not responding — turns proceed untagged`, hint: "start the SER server there or fix tone.host/port" });
    } else if (!findVenvPython(join(root, ".venv-ser"))) {
      checks.push({
        name: "tone (emotion2vec)",
        level: "fail",
        detail: ".venv-ser has no Python interpreter — the daemon cannot launch the SER sidecar",
        hint: buildVenvHint(".venv-ser", "3.11", "ser.txt", root, ["--index-strategy", "unsafe-best-match"]),
      });
    } else {
      checks.push((await probe(`http://127.0.0.1:${tone.port}/health`))
        ? { name: "tone (emotion2vec)", level: "ok", detail: `running on :${tone.port}` }
        : { name: "tone (emotion2vec)", level: "ok", detail: `venv present; daemon will launch it on :${tone.port} at start` });
    }
  }

  // -- system tools --------------------------------------------------------
  if (!config.headless) {
    checkBinary("sox (local mic/speaker)", "sox", checks, which, "apt install sox   # or brew install sox");
  }
  const configuredVoiceProvisioning = [config.ttsBackend, config.ttsFallbackBackend]
    .some((backend) => backend && voiceProviderContractForBackend(backend.backend));
  if (configuredVoiceProvisioning || config.notify?.telegram) {
    const purpose = configuredVoiceProvisioning && config.notify?.telegram
      ? "voice provisioning and Telegram voice notes"
      : configuredVoiceProvisioning
        ? "voice provisioning"
        : "Telegram voice notes";
    checkBinary(`ffmpeg (${purpose})`, "ffmpeg", checks, which, "apt install ffmpeg   # or brew install ffmpeg / scoop install ffmpeg");
  }
  const nvidiaSmi = which("nvidia-smi");
  if (nvidiaSmi) {
    try {
      const result = await runCommand([
        nvidiaSmi,
        "--query-gpu=name,memory.free",
        "--format=csv,noheader",
      ], {
        timeoutMs: DOCTOR_GPU_TIMEOUT_MS,
        stdoutLimitBytes: 8 * 1024,
        stderrLimitBytes: 1024,
        totalLimitBytes: 9 * 1024,
        outputLimitBehavior: "error",
      });
      const gpu = result.exitCode === 0 ? result.stdout.text.trim().split("\n")[0] : undefined;
      checks.push(gpu
        ? { name: "gpu", level: "ok", detail: gpu }
        : { name: "gpu", level: "warn", detail: "nvidia-smi did not return GPU status before exiting" });
    } catch {
      checks.push({ name: "gpu", level: "warn", detail: "nvidia-smi did not respond within its diagnostic deadline" });
    }
  } else {
    checks.push({ name: "gpu", level: "ok", detail: "no nvidia-smi — CPU/Metal mode (pocket-tts and remote engines still work)" });
  }

  return checks;
}

const ICON: Record<Level, string> = { ok: "✓", warn: "⚠", fail: "✗" };

export async function runDoctor(): Promise<number> {
  const checks = await collectChecks();
  for (const c of checks) {
    console.log(`  ${ICON[c.level]} ${c.name}: ${c.detail}`);
    if (c.hint && c.level !== "ok") console.log(`      fix: ${c.hint}`);
  }
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  console.log(fails ? `\n${fails} problem(s), ${warns} warning(s).` : warns ? `\nNo blockers — ${warns} warning(s).` : "\nAll clear.");
  return fails ? 1 : 0;
}
