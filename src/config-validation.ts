import type { CiceroConfig } from "./types";
import { TIER_PRESETS } from "./backends/tiers";
import { MAX_PROVIDER_TIMEOUT_MS } from "./backends/http-transfer";
import {
  MAX_ACTION_OUTPUT_LIMIT_BYTES,
  MAX_ACTION_TIMEOUT_SECONDS,
} from "./action-command-limits";
import { MAX_ACP_PENDING_TURN_LIMIT, MAX_ACP_TEXT_LIMIT_BYTES } from "./brain/acp-limits";
import {
  sttEndpointKey,
  type STTProviderConfig,
} from "./backends/stt/provider";
import {
  WEB_VOICE_TOKEN_GENERATION_HINT,
  webVoiceTokenProblem,
} from "./web-voice/startup-policy";

export class ConfigValidationError extends Error {
  constructor(source: string, readonly issues: string[]) {
    super(`Invalid Cicero configuration in ${source}:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkRecord(value: unknown, path: string, issues: string[]): value is Record<string, unknown> {
  if (isRecord(value)) return true;
  issues.push(`${path} must be a mapping`);
  return false;
}

function normalizedKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]
        + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function suggestedKey(key: string, allowed: readonly string[]): string | undefined {
  const normalized = normalizedKey(key);
  let best: { key: string; distance: number } | undefined;
  for (const candidate of allowed) {
    const candidateNormalized = normalizedKey(candidate);
    const distance = editDistance(normalized, candidateNormalized);
    if (best === undefined || distance < best.distance) best = { key: candidate, distance };
  }
  if (best === undefined) return undefined;
  const threshold = Math.max(1, Math.floor(Math.max(normalized.length, normalizedKey(best.key).length) / 4));
  return best.distance <= threshold ? best.key : undefined;
}

function checkKnownKeys(
  owner: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
  issues: string[],
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(owner)) {
    if (known.has(key)) continue;
    const suggestion = suggestedKey(key, allowed);
    issues.push(
      `${path}.${key} is not supported${suggestion ? `; did you mean ${path}.${suggestion}?` : ""}`,
    );
  }
}

function checkString(value: unknown, path: string, issues: string[], allowEmpty = false): void {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    issues.push(`${path} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
}

function checkOptionalString(
  owner: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
  allowEmpty = false,
): void {
  if (owner[key] !== undefined) checkString(owner[key], `${path}.${key}`, issues, allowEmpty);
}

function checkBoolean(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "boolean") issues.push(`${path} must be a boolean`);
}

function checkOptionalBoolean(
  owner: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): void {
  if (owner[key] !== undefined) checkBoolean(owner[key], `${path}.${key}`, issues);
}

function checkInteger(
  value: unknown,
  path: string,
  issues: string[],
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): void {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    issues.push(`${path} must be an integer between ${min} and ${max}`);
  }
}

function checkNumber(
  value: unknown,
  path: string,
  issues: string[],
  {
    min = -Infinity,
    max = Infinity,
    minExclusive = false,
  }: { min?: number; max?: number; minExclusive?: boolean } = {},
): void {
  const belowMinimum = typeof value === "number" && (minExclusive ? value <= min : value < min);
  if (typeof value !== "number" || !Number.isFinite(value) || belowMinimum || value > max) {
    const lower = Number.isFinite(min) ? `${minExclusive ? "greater than" : "at least"} ${min}` : "finite";
    const upper = Number.isFinite(max) ? ` and at most ${max}` : "";
    issues.push(`${path} must be a finite number ${lower}${upper}`);
  }
}

function checkOptionalInteger(
  owner: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
  bounds: { min?: number; max?: number } = {},
): void {
  if (owner[key] !== undefined) checkInteger(owner[key], `${path}.${key}`, issues, bounds);
}

function checkOptionalNumber(
  owner: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
  bounds: { min?: number; max?: number; minExclusive?: boolean } = {},
): void {
  if (owner[key] !== undefined) checkNumber(owner[key], `${path}.${key}`, issues, bounds);
}

function checkedSttEndpoint(value: unknown): string | null {
  if (!isRecord(value) || typeof value.backend !== "string") return null;
  if (value.host !== undefined && typeof value.host !== "string") return null;
  if (value.port !== undefined && !Number.isInteger(value.port)) return null;
  return sttEndpointKey(value as STTProviderConfig);
}

function checkOptionalPort(owner: Record<string, unknown>, path: string, issues: string[]): void {
  if (owner.port !== undefined) checkInteger(owner.port, `${path}.port`, issues, { min: 1, max: 65_535 });
}

function checkStringArray(
  value: unknown,
  path: string,
  issues: string[],
  { requireEntries = false }: { requireEntries?: boolean } = {},
): void {
  if (
    !Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || (requireEntries && entry.trim().length === 0))
  ) {
    issues.push(`${path} must be an array of${requireEntries ? " non-empty" : ""} strings`);
  }
}

function checkStringRecord(value: unknown, path: string, issues: string[]): void {
  if (!checkRecord(value, path, issues)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim().length === 0 || typeof entry !== "string") {
      issues.push(`${path} must map non-empty string keys to strings`);
      return;
    }
  }
}

function checkHttpUrl(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${path} must be a non-empty HTTP(S) URL`);
    return;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      issues.push(`${path} must be a non-empty HTTP(S) URL`);
    }
  } catch {
    issues.push(`${path} must be a non-empty HTTP(S) URL`);
  }
}

function checkOptionalHttpUrl(owner: Record<string, unknown>, key: string, path: string, issues: string[]): void {
  if (owner[key] !== undefined) checkHttpUrl(owner[key], `${path}.${key}`, issues);
}

function checkClockTime(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    issues.push(`${path} must be a 24-hour time in HH:MM format`);
  }
}

function checkRegex(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${path} must be a non-empty regular expression`);
    return;
  }
  try {
    new RegExp(value);
  } catch {
    issues.push(`${path} must be a valid regular expression`);
  }
}

/**
 * Validate the operational parts of the merged runtime config before any
 * provider, subprocess, listener, or server is created.
 *
 * Built-in sections reject unknown keys instead of silently dropping a typo.
 * LLM request-body extensions belong under the explicit `llm.extra` mapping.
 */
export function validateRuntimeConfig(config: unknown, source = "merged configuration"): asserts config is CiceroConfig {
  const issues: string[] = [];
  if (!checkRecord(config, "config", issues)) throw new ConfigValidationError(source, issues);

  checkKnownKeys(config, "config", [
    "quick_intents", "filler_lines", "tts_enabled", "tts_summary_max_tokens", "tts_local_max_tokens",
    "wake_word_enabled", "hotkey", "wispr_hotkey", "terminal", "voice", "voice_ref_audio",
    "voice_ref_text", "barge_in_enabled", "full_duplex", "aec", "silence_duration",
    "silence_threshold", "phonetic_aliases", "brain", "servers", "actions", "deployment", "stt",
    "stt_fallback", "tts", "tts_fallback", "llm", "compute", "sidecar", "dashboard", "web_voice",
    "notify", "headless", "turn", "tone", "clap", "vad", "earcons",
  ], issues);

  checkBoolean(config.tts_enabled, "tts_enabled", issues);
  checkBoolean(config.wake_word_enabled, "wake_word_enabled", issues);
  // Cicero uses explicit feature switches rather than empty-string sentinels;
  // hotkey names and voice selections must therefore remain usable values.
  checkString(config.hotkey, "hotkey", issues);
  checkString(config.wispr_hotkey, "wispr_hotkey", issues);
  checkString(config.voice, "voice", issues);
  for (const key of ["voice_ref_audio", "voice_ref_text"] as const) {
    checkOptionalString(config, key, "config", issues);
  }
  for (const key of ["tts_summary_max_tokens", "tts_local_max_tokens"] as const) {
    checkOptionalInteger(config, key, "config", issues, { min: 1 });
  }
  if (config.silence_duration !== undefined) {
    const duration = typeof config.silence_duration === "string" ? Number(config.silence_duration) : NaN;
    if (!Number.isFinite(duration) || duration <= 0) issues.push("silence_duration must be a positive numeric string");
  }
  if (
    config.silence_threshold !== undefined
    && (typeof config.silence_threshold !== "string" || !/^(?:100|\d{1,2})(?:\.\d+)?%$/.test(config.silence_threshold))
  ) {
    issues.push("silence_threshold must be a percentage string between 0% and 100%");
  }

  if (config.phonetic_aliases !== undefined && checkRecord(config.phonetic_aliases, "phonetic_aliases", issues)) {
    for (const [canonical, aliases] of Object.entries(config.phonetic_aliases)) {
      if (canonical.trim().length === 0) issues.push("phonetic_aliases keys must be non-empty strings");
      checkStringArray(aliases, `phonetic_aliases.${canonical}`, issues, { requireEntries: true });
    }
  }

  if (config.filler_lines !== undefined && checkRecord(config.filler_lines, "filler_lines", issues)) {
    checkKnownKeys(config.filler_lines, "filler_lines", [
      "connect", "task", "lookup", "question", "default",
    ], issues);
    for (const [bucket, lines] of Object.entries(config.filler_lines)) {
      checkStringArray(lines, `filler_lines.${bucket}`, issues, { requireEntries: true });
    }
  }

  if (config.quick_intents !== undefined) {
    if (!Array.isArray(config.quick_intents)) {
      issues.push("quick_intents must be an array");
    } else {
      for (const [index, intent] of config.quick_intents.entries()) {
        const path = `quick_intents.${index}`;
        if (!checkRecord(intent, path, issues)) continue;
        checkKnownKeys(intent, path, ["phrases", "pattern", "reply"], issues);
        checkString(intent.reply, `${path}.reply`, issues);
        if (intent.phrases === undefined && intent.pattern === undefined) {
          issues.push(`${path} must define phrases or pattern`);
        }
        if (intent.phrases !== undefined) {
          checkStringArray(intent.phrases, `${path}.phrases`, issues, { requireEntries: true });
          if (Array.isArray(intent.phrases) && intent.phrases.length === 0) {
            issues.push(`${path}.phrases must not be empty`);
          }
        }
        if (intent.pattern !== undefined) checkRegex(intent.pattern, `${path}.pattern`, issues);
      }
    }
  }

  const terminals = new Set(["auto", "kitty", "wezterm", "tmux", "none"]);
  if (typeof config.terminal !== "string" || !terminals.has(config.terminal)) {
    issues.push(`terminal must be one of: ${[...terminals].join(", ")}`);
  }

  if (config.deployment !== undefined) {
    if (typeof config.deployment !== "string" || !(config.deployment in TIER_PRESETS)) {
      issues.push(`deployment must be one of: ${Object.keys(TIER_PRESETS).join(", ")}`);
    }
  }

  if (checkRecord(config.brain, "brain", issues)) {
    checkKnownKeys(config.brain, "brain", [
      "backend", "mode", "target_tab", "auto_approve_tools", "confirm_tools", "confirm_retry",
      "max_queue_bytes", "max_response_bytes", "max_pending_turns", "escalate", "lanes",
      "binary", "binary_args", "ollama_port", "ollama_model",
      "base_url", "model", "api_key", "api_key_env", "max_tokens", "timeout_ms", "turn_timeout_ms",
      "headers", "session_header", "narrate_progress", "unset_env", "agent_first", "thinking_filler",
    ], issues);
    checkString(config.brain.backend, "brain.backend", issues);
    if (config.brain.mode !== "subprocess" && config.brain.mode !== "tab-inject") {
      issues.push("brain.mode must be 'subprocess' or 'tab-inject'");
    }
    if (config.brain.binary_args !== undefined) checkStringArray(config.brain.binary_args, "brain.binary_args", issues);
    if (config.brain.unset_env !== undefined) checkStringArray(config.brain.unset_env, "brain.unset_env", issues);
    if (config.brain.confirm_tools !== undefined) checkStringArray(config.brain.confirm_tools, "brain.confirm_tools", issues);
    for (const key of ["max_queue_bytes", "max_response_bytes"] as const) {
      if (config.brain[key] !== undefined) {
        checkInteger(config.brain[key], `brain.${key}`, issues, { min: 1, max: MAX_ACP_TEXT_LIMIT_BYTES });
      }
    }
    if (config.brain.max_pending_turns !== undefined) {
      checkInteger(config.brain.max_pending_turns, "brain.max_pending_turns", issues, {
        min: 1,
        max: MAX_ACP_PENDING_TURN_LIMIT,
      });
    }
    for (const key of ["auto_approve_tools", "confirm_retry", "narrate_progress", "agent_first", "thinking_filler"]) {
      checkOptionalBoolean(config.brain, key, "brain", issues);
    }
    if (config.brain.ollama_port !== undefined) {
      checkInteger(config.brain.ollama_port, "brain.ollama_port", issues, { min: 1, max: 65_535 });
    }
    if (config.brain.turn_timeout_ms !== undefined) {
      issues.push("brain.turn_timeout_ms is not supported; use brain.timeout_ms for HTTP-backed brains");
    }
    if (config.brain.timeout_ms !== undefined) {
      checkInteger(config.brain.timeout_ms, "brain.timeout_ms", issues, {
        min: 1,
        max: MAX_PROVIDER_TIMEOUT_MS,
      });
    }
    for (const key of [
      "target_tab", "binary", "ollama_model", "model", "api_key", "api_key_env", "session_header",
    ] as const) {
      checkOptionalString(config.brain, key, "brain", issues);
    }
    if (config.brain.base_url !== undefined) checkHttpUrl(config.brain.base_url, "brain.base_url", issues);
    if (config.brain.backend === "openai-compatible" && config.brain.base_url === undefined) {
      issues.push("brain.base_url is required for the openai-compatible backend");
    }
    checkOptionalInteger(config.brain, "max_tokens", "brain", issues, { min: 1 });
    if (config.brain.headers !== undefined) checkStringRecord(config.brain.headers, "brain.headers", issues);

    const validateAgent = (value: unknown, path: string, allowMetadata: boolean): void => {
      if (!checkRecord(value, path, issues)) return;
      checkKnownKeys(value, path, allowMetadata
        ? [
            "backend", "binary", "binary_args", "unset_env", "env", "voice", "greeting", "persona",
            "aliases", "fallbacks",
          ]
        : ["backend", "binary", "binary_args", "unset_env", "env"], issues);
      if (value.backend !== undefined && value.backend !== "acp" && value.backend !== "codex") {
        issues.push(`${path}.backend must be 'acp' or 'codex'`);
      }
      checkOptionalString(value, "binary", path, issues);
      for (const key of ["binary_args", "unset_env"] as const) {
        if (value[key] !== undefined) checkStringArray(value[key], `${path}.${key}`, issues, { requireEntries: true });
      }
      if (value.env !== undefined) checkStringRecord(value.env, `${path}.env`, issues);
      if (!allowMetadata) return;
      for (const key of ["voice", "greeting", "persona"] as const) checkOptionalString(value, key, path, issues);
      if (value.aliases !== undefined) checkStringArray(value.aliases, `${path}.aliases`, issues, { requireEntries: true });
      if (value.fallbacks !== undefined) {
        if (!Array.isArray(value.fallbacks) || value.fallbacks.length === 0) {
          issues.push(`${path}.fallbacks must be a non-empty array`);
        } else {
          for (const [index, fallback] of value.fallbacks.entries()) {
            validateAgent(fallback, `${path}.fallbacks.${index}`, false);
          }
        }
      }
    };

    if (config.brain.escalate !== undefined) {
      if (checkRecord(config.brain.escalate, "brain.escalate", issues)) {
        checkKnownKeys(config.brain.escalate, "brain.escalate", [
          "binary", "binary_args", "triggers", "unset_env",
        ], issues);
        checkOptionalString(config.brain.escalate, "binary", "brain.escalate", issues);
        for (const key of ["binary_args", "triggers", "unset_env"] as const) {
          if (config.brain.escalate[key] !== undefined) {
            checkStringArray(config.brain.escalate[key], `brain.escalate.${key}`, issues, { requireEntries: true });
          }
        }
      }
    }
    if (config.brain.lanes !== undefined && checkRecord(config.brain.lanes, "brain.lanes", issues)) {
      for (const [name, lane] of Object.entries(config.brain.lanes)) {
        if (name.trim().length === 0) issues.push("brain.lanes keys must be non-empty strings");
        validateAgent(lane, `brain.lanes.${name}`, true);
      }
    }
  }

  if (checkRecord(config.servers, "servers", issues)) {
    checkKnownKeys(config.servers, "servers", ["router", "tts", "stt"], issues);
    for (const name of ["router", "tts", "stt"] as const) {
      const server = config.servers[name];
      if (!checkRecord(server, `servers.${name}`, issues)) continue;
      checkKnownKeys(server, `servers.${name}`, ["port", "model"], issues);
      checkInteger(server.port, `servers.${name}.port`, issues, { min: 1, max: 65_535 });
      checkString(server.model, `servers.${name}.model`, issues);
    }
  }

  for (const name of ["stt", "stt_fallback", "tts", "tts_fallback", "llm"] as const) {
    const provider = config[name];
    if (provider === undefined) continue;
    if (!checkRecord(provider, name, issues)) continue;
    const commonProviderKeys = ["backend", "host", "port", "model", "timeout_ms"] as const;
    const roleProviderKeys = name === "llm"
      ? ["apiKey", "apiKeyEnv", "baseUrl", "extraHeaders", "extra"] as const
      : name === "stt" || name === "stt_fallback"
        ? ["compute_type"] as const
        : ["apiKey", "voice", "device", "refAudio", "refText", "responseTimeoutMs", "maxAudioBytes"] as const;
    checkKnownKeys(provider, name, [...commonProviderKeys, ...roleProviderKeys], issues);
    checkString(provider.backend, `${name}.backend`, issues);
    checkOptionalPort(provider, name, issues);
    for (const key of ["host", "model", "compute_type", "voice", "device", "refAudio", "refText", "baseUrl", "apiKey", "apiKeyEnv"] as const) {
      checkOptionalString(provider, key, name, issues);
    }
    if (provider.baseUrl !== undefined) checkHttpUrl(provider.baseUrl, `${name}.baseUrl`, issues);
    if (provider.extraHeaders !== undefined) checkStringRecord(provider.extraHeaders, `${name}.extraHeaders`, issues);
    if (name === "llm" && provider.extra !== undefined) checkRecord(provider.extra, `${name}.extra`, issues);
    if (provider.responseTimeoutMs !== undefined) {
      checkInteger(provider.responseTimeoutMs, `${name}.responseTimeoutMs`, issues, {
        min: 1,
        max: MAX_PROVIDER_TIMEOUT_MS,
      });
    }
    if (provider.maxAudioBytes !== undefined) {
      checkInteger(provider.maxAudioBytes, `${name}.maxAudioBytes`, issues, { min: 1 });
    }
    if (provider.timeout_ms !== undefined) {
      checkInteger(provider.timeout_ms, `${name}.timeout_ms`, issues, {
        min: 1,
        max: MAX_PROVIDER_TIMEOUT_MS,
      });
    }
  }

  if (config.stt_fallback !== undefined) {
    const fallbackEndpoint = checkedSttEndpoint(config.stt_fallback);
    const explicitPrimaryEndpoint = checkedSttEndpoint(config.stt);
    const legacyStt = isRecord(config.servers) && isRecord(config.servers.stt)
      ? config.servers.stt
      : null;
    const legacyPrimaryEndpoint = legacyStt
      ? checkedSttEndpoint({
          backend: "mlx-whisper",
          port: legacyStt.port,
        })
      : null;
    const primaryEndpoint = explicitPrimaryEndpoint ?? legacyPrimaryEndpoint;
    if (fallbackEndpoint !== null && fallbackEndpoint === primaryEndpoint) {
      issues.push(
        `stt_fallback resolves to the primary STT endpoint (${fallbackEndpoint}); configure a distinct host or port`,
      );
    }
  }

  if (checkRecord(config.actions, "actions", issues)) {
    const categories = new Set(["terminal", "cli", "brain", "local", "local-llm"]);
    const ttsModes = new Set(["full", "summary", "silent"]);
    for (const [name, value] of Object.entries(config.actions)) {
      const path = `actions.${name}`;
      if (!checkRecord(value, path, issues)) continue;
      checkKnownKeys(value, path, [
        "category", "command", "tts_mode", "examples", "timeout_s", "output_limit",
      ], issues);
      if (typeof value.category !== "string" || !categories.has(value.category)) {
        issues.push(`${path}.category must be one of: ${[...categories].join(", ")}`);
      }
      checkString(value.command, `${path}.command`, issues, true);
      if (typeof value.tts_mode !== "string" || !ttsModes.has(value.tts_mode)) {
        issues.push(`${path}.tts_mode must be one of: ${[...ttsModes].join(", ")}`);
      }
      checkStringArray(value.examples, `${path}.examples`, issues);
      checkOptionalNumber(value, "timeout_s", path, issues, {
        min: 0,
        minExclusive: true,
        max: MAX_ACTION_TIMEOUT_SECONDS,
      });
      checkOptionalInteger(value, "output_limit", path, issues, {
        min: 1,
        max: MAX_ACTION_OUTPUT_LIMIT_BYTES,
      });
    }
  }

  for (const [name, value] of Object.entries(config)) {
    if (!name.endsWith("_enabled") || value === undefined) continue;
    checkBoolean(value, name, issues);
  }
  for (const key of ["full_duplex", "aec", "headless", "earcons"] as const) {
    if (config[key] !== undefined) checkBoolean(config[key], key, issues);
  }

  for (const name of ["dashboard", "web_voice", "turn", "tone", "clap", "vad"] as const) {
    const section = config[name];
    if (section === undefined) continue;
    if (!checkRecord(section, name, issues)) continue;
    checkOptionalPort(section, name, issues);
    if (section.enabled !== undefined) checkBoolean(section.enabled, `${name}.enabled`, issues);
    if (section.timeout_ms !== undefined) {
      checkInteger(section.timeout_ms, `${name}.timeout_ms`, issues, {
        min: 1,
        max: MAX_PROVIDER_TIMEOUT_MS,
      });
    }
  }

  if (isRecord(config.dashboard)) {
    checkKnownKeys(config.dashboard, "dashboard", ["enabled", "port"], issues);
  }
  if (isRecord(config.web_voice)) {
    checkKnownKeys(config.web_voice, "web_voice", [
      "enabled", "host", "port", "token", "tls", "tunnel", "resume_turns", "speech_gate", "tldr", "speculative", "long_turn",
    ], issues);
  }
  if (isRecord(config.turn)) {
    checkKnownKeys(config.turn, "turn", [
      "enabled", "backend", "host", "port", "model", "threshold", "grace_attempts",
      "grace_max_duration", "timeout_ms",
    ], issues);
  }
  if (isRecord(config.tone)) {
    checkKnownKeys(config.tone, "tone", [
      "enabled", "host", "port", "model", "min_score", "grace_ms", "min_ms", "timeout_ms",
    ], issues);
  }
  if (isRecord(config.clap)) {
    checkKnownKeys(config.clap, "clap", [
      "enabled", "threshold", "min_gap_ms", "max_gap_ms", "deactivate",
    ], issues);
  }
  if (isRecord(config.vad)) {
    checkKnownKeys(config.vad, "vad", [
      "enabled", "hangover_ms", "open_factor", "min_speech_ms", "calibration_ms", "preroll_ms",
    ], issues);
  }

  if (isRecord(config.web_voice)) {
    checkOptionalString(config.web_voice, "host", "web_voice", issues);
    checkOptionalInteger(config.web_voice, "resume_turns", "web_voice", issues, { min: 0 });
    checkOptionalBoolean(config.web_voice, "speech_gate", "web_voice", issues);
    if (config.web_voice.token !== undefined) {
      const problem = webVoiceTokenProblem(config.web_voice.token);
      if (problem) {
        issues.push(`web_voice.token ${problem}; ${WEB_VOICE_TOKEN_GENERATION_HINT}`);
      }
    }
    for (const name of ["tls", "tunnel", "tldr", "speculative", "long_turn"] as const) {
      const section = config.web_voice[name];
      if (section === undefined || !checkRecord(section, `web_voice.${name}`, issues)) continue;
      if (name !== "tunnel") checkOptionalBoolean(section, "enabled", `web_voice.${name}`, issues);
    }
    if (isRecord(config.web_voice.tls)) {
      checkKnownKeys(config.web_voice.tls, "web_voice.tls", [
        "enabled", "cert_file", "key_file",
      ], issues);
      checkOptionalString(config.web_voice.tls, "cert_file", "web_voice.tls", issues);
      checkOptionalString(config.web_voice.tls, "key_file", "web_voice.tls", issues);
      if ((config.web_voice.tls.cert_file === undefined) !== (config.web_voice.tls.key_file === undefined)) {
        issues.push("web_voice.tls.cert_file and web_voice.tls.key_file must be configured together");
      }
    }
    if (isRecord(config.web_voice.tunnel)) {
      checkKnownKeys(config.web_voice.tunnel, "web_voice.tunnel", ["provider"], issues);
      const provider = config.web_voice.tunnel.provider;
      if (provider !== "auto" && provider !== "tailscale" && provider !== "cloudflared") {
        issues.push("web_voice.tunnel.provider must be one of: auto, tailscale, cloudflared");
      }
    }
    if (isRecord(config.web_voice.tldr)) {
      checkKnownKeys(config.web_voice.tldr, "web_voice.tldr", [
        "enabled", "spoken_sentences", "summarizer_url", "summarizer_model",
      ], issues);
      checkOptionalInteger(config.web_voice.tldr, "spoken_sentences", "web_voice.tldr", issues, { min: 0 });
      checkOptionalHttpUrl(config.web_voice.tldr, "summarizer_url", "web_voice.tldr", issues);
      checkOptionalString(config.web_voice.tldr, "summarizer_model", "web_voice.tldr", issues);
    }
    if (isRecord(config.web_voice.speculative)) {
      checkKnownKeys(config.web_voice.speculative, "web_voice.speculative", [
        "enabled", "min_probability",
      ], issues);
      checkOptionalNumber(config.web_voice.speculative, "min_probability", "web_voice.speculative", issues, { min: 0, max: 1 });
    }
    if (isRecord(config.web_voice.long_turn)) {
      checkKnownKeys(config.web_voice.long_turn, "web_voice.long_turn", [
        "enabled", "park_after_s", "max_background_s", "line",
      ], issues);
      checkOptionalNumber(config.web_voice.long_turn, "park_after_s", "web_voice.long_turn", issues, { min: 0, minExclusive: true });
      checkOptionalNumber(config.web_voice.long_turn, "max_background_s", "web_voice.long_turn", issues, { min: 0, minExclusive: true });
      checkOptionalString(config.web_voice.long_turn, "line", "web_voice.long_turn", issues);
    }
  }
  if (isRecord(config.clap)) {
    checkOptionalBoolean(config.clap, "deactivate", "clap", issues);
    checkOptionalNumber(config.clap, "threshold", "clap", issues, { min: 0, max: 1 });
    checkOptionalInteger(config.clap, "min_gap_ms", "clap", issues, { min: 0 });
    checkOptionalInteger(config.clap, "max_gap_ms", "clap", issues, { min: 1 });
    if (
      typeof config.clap.min_gap_ms === "number"
      && typeof config.clap.max_gap_ms === "number"
      && config.clap.max_gap_ms <= config.clap.min_gap_ms
    ) {
      issues.push("clap.max_gap_ms must be greater than clap.min_gap_ms");
    }
  }
  if (isRecord(config.turn)) {
    if (config.turn.backend !== undefined && config.turn.backend !== "smart-turn") {
      issues.push("turn.backend must be 'smart-turn'");
    }
    for (const key of ["host", "model"] as const) checkOptionalString(config.turn, key, "turn", issues);
    checkOptionalNumber(config.turn, "threshold", "turn", issues, { min: 0, max: 1 });
    checkOptionalInteger(config.turn, "grace_attempts", "turn", issues, { min: 0 });
    checkOptionalNumber(config.turn, "grace_max_duration", "turn", issues, { min: 0, minExclusive: true });
  }
  if (isRecord(config.tone)) {
    for (const key of ["host", "model"] as const) checkOptionalString(config.tone, key, "tone", issues);
    checkOptionalNumber(config.tone, "min_score", "tone", issues, { min: 0, max: 1 });
    checkOptionalInteger(config.tone, "grace_ms", "tone", issues, { min: 0 });
    checkOptionalInteger(config.tone, "min_ms", "tone", issues, { min: 0 });
  }
  if (isRecord(config.vad)) {
    checkOptionalInteger(config.vad, "hangover_ms", "vad", issues, { min: 0 });
    checkOptionalNumber(config.vad, "open_factor", "vad", issues, { min: 0, minExclusive: true });
    checkOptionalInteger(config.vad, "min_speech_ms", "vad", issues, { min: 0 });
    checkOptionalInteger(config.vad, "calibration_ms", "vad", issues, { min: 0 });
    checkOptionalInteger(config.vad, "preroll_ms", "vad", issues, { min: 0 });
  }

  if (config.notify !== undefined && checkRecord(config.notify, "notify", issues)) {
    checkKnownKeys(config.notify, "notify", [
      "telegram", "timezone", "quiet_hours", "briefing", "call_minutes", "kanban", "schedules",
    ], issues);
    for (const [name, key] of [["telegram", "voice_note"], ["briefing", "call"], ["kanban", "call_back"]] as const) {
      const section = config.notify[name];
      if (section === undefined || !checkRecord(section, `notify.${name}`, issues)) continue;
      checkOptionalBoolean(section, key, `notify.${name}`, issues);
      if (name === "kanban") checkOptionalBoolean(section, "enabled", "notify.kanban", issues);
    }
    if (config.notify.timezone !== undefined) {
      if (typeof config.notify.timezone !== "string" || config.notify.timezone.trim().length === 0) {
        issues.push("notify.timezone must be a non-empty IANA timezone");
      } else {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: config.notify.timezone }).format();
        } catch {
          issues.push("notify.timezone must be a valid IANA timezone");
        }
      }
    }
    if (config.notify.quiet_hours !== undefined && checkRecord(config.notify.quiet_hours, "notify.quiet_hours", issues)) {
      checkKnownKeys(config.notify.quiet_hours, "notify.quiet_hours", ["from", "to"], issues);
      checkClockTime(config.notify.quiet_hours.from, "notify.quiet_hours.from", issues);
      checkClockTime(config.notify.quiet_hours.to, "notify.quiet_hours.to", issues);
    }
    if (isRecord(config.notify.briefing)) {
      checkKnownKeys(config.notify.briefing, "notify.briefing", ["at", "call", "catch_up_minutes"], issues);
      checkClockTime(config.notify.briefing.at, "notify.briefing.at", issues);
      checkOptionalInteger(config.notify.briefing, "catch_up_minutes", "notify.briefing", issues, { min: 0, max: 720 });
    }
    if (config.notify.schedules !== undefined) {
      if (!Array.isArray(config.notify.schedules)) {
        issues.push("notify.schedules must be a list");
      } else {
        config.notify.schedules.forEach((entry: unknown, i: number) => {
          const path = `notify.schedules[${i}]`;
          if (!checkRecord(entry, path, issues)) return;
          checkKnownKeys(entry, path, ["name", "at", "prompt", "lane"], issues);
          checkClockTime(entry.at, `${path}.at`, issues);
          if (typeof entry.prompt !== "string" || entry.prompt.trim().length === 0) {
            issues.push(`${path}.prompt must be a non-empty string`);
          } else if (entry.prompt.length > 8000) {
            issues.push(`${path}.prompt must be at most 8000 characters`);
          }
          checkOptionalString(entry, "name", path, issues);
          if (entry.lane !== undefined) {
            if (typeof entry.lane !== "string" || entry.lane.trim().length === 0) {
              issues.push(`${path}.lane must be a non-empty string`);
            } else {
              // A misspelled lane must fail at load, not silently answer from
              // the wrong brain at 9am.
              const lanes = isRecord(config.brain) && isRecord(config.brain.lanes) ? Object.keys(config.brain.lanes) : [];
              if (!lanes.includes(entry.lane)) {
                issues.push(`${path}.lane "${entry.lane}" is not a configured brain lane${lanes.length ? ` (have: ${lanes.join(", ")})` : ""}`);
              }
            }
          }
        });
      }
    }
    if (isRecord(config.notify.telegram)) {
      checkKnownKeys(config.notify.telegram, "notify.telegram", [
        "token", "token_env", "chat_id", "sender_user_id", "voice_note",
      ], issues);
      checkOptionalString(config.notify.telegram, "token", "notify.telegram", issues);
      checkOptionalString(config.notify.telegram, "token_env", "notify.telegram", issues);
      for (const key of ["chat_id", "sender_user_id"] as const) {
        if (
          config.notify.telegram[key] !== undefined
          && typeof config.notify.telegram[key] !== "string"
          && typeof config.notify.telegram[key] !== "number"
        ) {
          issues.push(`notify.telegram.${key} must be a string or number`);
        }
      }
    }
    if (isRecord(config.notify.kanban)) {
      checkKnownKeys(config.notify.kanban, "notify.kanban", [
        "enabled", "interval_seconds", "command", "task_command", "call_back", "nudge_after_minutes",
      ], issues);
      checkOptionalInteger(config.notify.kanban, "interval_seconds", "notify.kanban", issues, { min: 1 });
      checkOptionalInteger(config.notify.kanban, "nudge_after_minutes", "notify.kanban", issues, { min: 0 });
      for (const key of ["command", "task_command"] as const) {
        if (config.notify.kanban[key] !== undefined) {
          checkStringArray(config.notify.kanban[key], `notify.kanban.${key}`, issues, { requireEntries: true });
          if (Array.isArray(config.notify.kanban[key]) && (config.notify.kanban[key] as unknown[]).length === 0) {
            issues.push(`notify.kanban.${key} must not be empty`);
          }
        }
      }
      // No built-in board CLI: a watched board needs its command spelled out
      // (e.g. [hermes, kanban, list, --json]) — same explicit-opt-in rule as
      // every other adapter.
      if (config.notify.kanban.enabled !== false && config.notify.kanban.command === undefined) {
        issues.push("notify.kanban.command is required when the kanban watch is enabled — e.g. [hermes, kanban, list, --json], or set notify.kanban.enabled: false");
      }
    }
    if (config.notify.call_minutes !== undefined
      && typeof config.notify.call_minutes !== "boolean"
      && !isRecord(config.notify.call_minutes)) {
      issues.push("notify.call_minutes must be a boolean or mapping");
    }
    if (isRecord(config.notify.call_minutes)) {
      checkKnownKeys(config.notify.call_minutes, "notify.call_minutes", ["min_minutes"], issues);
      checkOptionalNumber(config.notify.call_minutes, "min_minutes", "notify.call_minutes", issues, { min: 0 });
    }
  }

  if (config.compute !== undefined && checkRecord(config.compute, "compute", issues)) {
    checkKnownKeys(config.compute, "compute", ["allow_cloud", "root", "max_read_bytes"], issues);
    checkOptionalBoolean(config.compute, "allow_cloud", "compute", issues);
    if (config.compute.root !== undefined) checkString(config.compute.root, "compute.root", issues);
    if (config.compute.max_read_bytes !== undefined) {
      checkInteger(config.compute.max_read_bytes, "compute.max_read_bytes", issues, { min: 1 });
    }
  }

  if (config.sidecar !== undefined) {
    if (checkRecord(config.sidecar, "sidecar", issues)) {
      checkKnownKeys(config.sidecar, "sidecar", [
        "backend", "port", "targetTab", "pollIntervalMs", "quietWindowMs", "promptMarker",
      ], issues);
      if (config.sidecar.backend !== "claude-code-hook" && config.sidecar.backend !== "terminal-scrape") {
        issues.push("sidecar.backend must be 'claude-code-hook' or 'terminal-scrape'");
      }
      checkOptionalPort(config.sidecar, "sidecar", issues);
      if (config.sidecar.backend === "claude-code-hook" && config.sidecar.port === undefined) {
        issues.push("sidecar.port is required for the claude-code-hook backend");
      }
      if (config.sidecar.backend === "terminal-scrape") {
        checkString(config.sidecar.targetTab, "sidecar.targetTab", issues);
        checkInteger(config.sidecar.pollIntervalMs, "sidecar.pollIntervalMs", issues, { min: 1 });
        checkInteger(config.sidecar.quietWindowMs, "sidecar.quietWindowMs", issues, { min: 0 });
        if (config.sidecar.promptMarker !== undefined) checkRegex(config.sidecar.promptMarker, "sidecar.promptMarker", issues);
      }
    }
  }

  if (issues.length > 0) throw new ConfigValidationError(source, issues);
}

/** Require a YAML document root to be a mapping before it reaches deepMerge. */
export function requireConfigMapping(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ConfigValidationError(source, ["document root must be a mapping"]);
  return value;
}
