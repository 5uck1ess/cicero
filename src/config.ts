import {
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "node:crypto";
import { basename, join, dirname } from "path";
import { parse as parseYaml, parseDocument as parseYamlDocument, stringify as stringifyYaml } from "yaml";
import type { CiceroConfig, ActionConfig, SidecarConfig, DictationConfig } from "./types";
import type { STTProviderConfig } from "./backends/stt/provider";
import type { TTSProviderConfig } from "./backends/tts/provider";
import type { LLMProviderConfig } from "./backends/llm/provider";
import { TIER_PRESETS } from "./backends/tiers";
import { DEFAULT_COALESCE_OPTIONS, type CoalesceOptions } from "./speaker/coalesce";
import { ciceroHome } from "./platform/paths";
import {
  ConfigValidationError,
  requireConfigMapping,
  validateRuntimeConfig,
} from "./config-validation";
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDirectorySync,
  ensurePrivateFileIfExistsSync,
  ensurePrivateFileSync,
} from "./platform/secure-storage";
import { voiceProviderContractForBackend } from "./voice/provider-contract";
import { webVoiceTokenProblem } from "./web-voice/startup-policy";

const CONFIG_FILE = "config.yaml";
const ACTIONS_FILE = "actions.yaml";
const CONFIG_UPDATE_LOCK_WAIT_MS = 50;
export const CONFIG_UPDATE_LOCK_TIMEOUT_MS = 35_000;

interface ConfigUpdateLockOwner {
  pid: number;
  token: string;
  acquiredAtMs: number;
  ticket: number;
}

interface ConfigUpdateLeaseState {
  token: string;
  usable: boolean;
  cleanupPaths: Set<string>;
}

interface ConfigLockCleanupObligation {
  path: string;
  owner?: ConfigUpdateLockOwner;
  lease?: ConfigUpdateLeaseState;
}

export interface ConfigUpdateLock {
  /** Fail closed unless this exact writer is still the elected lease owner. */
  assertOwned(): void;
  release(): void;
}

export interface ConfigUpdateLockOptions {
  /** Internal filesystem injection used by focused lease-cleanup regressions. */
  unlinkSync?: (path: string) => void;
}

const configLockWaiter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const CONFIG_LOCK_PARTICIPANT_PATTERN =
  /^(?<prefix>.+\.update-lock-)(?<pid>[1-9]\d*)-(?<token>[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(?<kind>choosing|owner\.json)$/i;
const liveConfigUpdateLeases = new Map<string, ConfigUpdateLeaseState>();
const pendingConfigLockCleanups = new Map<string, ConfigLockCleanupObligation>();
let configLockExitCleanupInstalled = false;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== "ESRCH";
  }
}

function updateConfigLockExitCleanup(): void {
  if (pendingConfigLockCleanups.size > 0 && !configLockExitCleanupInstalled) {
    configLockExitCleanupInstalled = true;
    process.once("exit", cleanupPendingConfigLocksAtExit);
  } else if (pendingConfigLockCleanups.size === 0 && configLockExitCleanupInstalled) {
    process.removeListener("exit", cleanupPendingConfigLocksAtExit);
    configLockExitCleanupInstalled = false;
  }
}

function settleConfigLockCleanup(obligation: ConfigLockCleanupObligation): void {
  pendingConfigLockCleanups.delete(obligation.path);
  if (obligation.lease) {
    obligation.lease.cleanupPaths.delete(obligation.path);
    if (obligation.lease.cleanupPaths.size === 0) {
      liveConfigUpdateLeases.delete(obligation.lease.token);
    }
  }
}

function tryConfigLockCleanup(
  obligation: ConfigLockCleanupObligation,
  unlinkPath: (path: string) => void,
): boolean {
  if (obligation.owner) {
    try {
      const current: unknown = JSON.parse(readFileSync(obligation.path, "utf8"));
      if (!validConfigLockOwner(current, obligation.owner)) return false;
    } catch (error: unknown) {
      return errorCode(error) === "ENOENT";
    }
  }
  try {
    unlinkPath(obligation.path);
    return true;
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT";
  }
}

function attemptConfigLockCleanups(
  obligations: readonly ConfigLockCleanupObligation[],
  unlinkPath: (path: string) => void,
): void {
  // Register the whole rollback before attempting any unlink. Otherwise the
  // first successful path could make a partly published lease look fully clean.
  for (const obligation of obligations) {
    pendingConfigLockCleanups.set(obligation.path, obligation);
    if (obligation.lease) obligation.lease.cleanupPaths.add(obligation.path);
  }
  for (const obligation of obligations) {
    if (tryConfigLockCleanup(obligation, unlinkPath)) {
      settleConfigLockCleanup(obligation);
    }
  }
  updateConfigLockExitCleanup();
}

function retryPendingConfigLockCleanups(): void {
  for (const obligation of [...pendingConfigLockCleanups.values()]) {
    if (tryConfigLockCleanup(obligation, unlinkSync)) {
      settleConfigLockCleanup(obligation);
    }
  }
  updateConfigLockExitCleanup();
}

function cleanupPendingConfigLocksAtExit(): void {
  configLockExitCleanupInstalled = false;
  for (const obligation of [...pendingConfigLockCleanups.values()]) {
    if (tryConfigLockCleanup(obligation, unlinkSync)) {
      settleConfigLockCleanup(obligation);
    }
  }
}

interface ConfigLockParticipant {
  pid: number;
  token: string;
  choosingPath?: string;
  ownerPath?: string;
}

interface ConfigLockScan {
  choosing: ConfigLockParticipant[];
  invalid: ConfigLockParticipant[];
  owners: Array<{ participant: ConfigLockParticipant; owner: ConfigUpdateLockOwner }>;
  legacyBlocked: boolean;
}

function configLockParticipant(path: string, configPath: string): {
  pid: number;
  token: string;
  kind: "choosing" | "owner.json";
} | null {
  const match = basename(path).match(CONFIG_LOCK_PARTICIPANT_PATTERN);
  const groups = match?.groups;
  if (!groups || groups.prefix !== `${basename(configPath)}.update-lock-`) return null;
  const pid = Number.parseInt(groups.pid!, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return {
    pid,
    token: groups.token!,
    kind: groups.kind as "choosing" | "owner.json",
  };
}

function validConfigLockOwner(
  value: unknown,
  participant: Pick<ConfigLockParticipant, "pid" | "token">,
): value is ConfigUpdateLockOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const owner = value as Partial<ConfigUpdateLockOwner>;
  return owner.pid === participant.pid
    && owner.token === participant.token
    && typeof owner.acquiredAtMs === "number"
    && Number.isFinite(owner.acquiredAtMs)
    && typeof owner.ticket === "number"
    && Number.isSafeInteger(owner.ticket)
    && owner.ticket > 0;
}

function reclaimableConfigLock(participant: ConfigLockParticipant): boolean {
  if (participant.pid !== process.pid) return !processIsAlive(participant.pid);
  /*
   * UUID participant paths are never reused. This process alone may reclaim
   * one of its paths when the ticket is absent from its live-lease map, because
   * it knows that ticket is not held. Other processes still require a dead PID,
   * and a cleanup failure stays in the map until unlink is confirmed, so neither
   * a live lease nor an unconfirmed release is ever displaced based on age.
   */
  return !liveConfigUpdateLeases.has(participant.token);
}

function removeStaleConfigLock(participant: ConfigLockParticipant): void {
  // Re-check immediately before removal so a live ticket cannot be displaced.
  if (!reclaimableConfigLock(participant)) return;
  for (const path of [participant.choosingPath, participant.ownerPath]) {
    if (!path) continue;
    try {
      unlinkSync(path);
      const pending = pendingConfigLockCleanups.get(path);
      if (pending) settleConfigLockCleanup(pending);
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
      const pending = pendingConfigLockCleanups.get(path);
      if (pending) settleConfigLockCleanup(pending);
    }
  }
  updateConfigLockExitCleanup();
}

function inspectLegacyConfigLock(configPath: string): "absent" | "blocked" | "removed" {
  const lockPath = `${configPath}.update-lock`;
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as
      Partial<ConfigUpdateLockOwner>;
    if (
      typeof owner.pid !== "number"
      || !Number.isSafeInteger(owner.pid)
      || owner.pid <= 0
    ) {
      return "blocked";
    }
    if (processIsAlive(owner.pid)) return "blocked";
    // New writers never reuse the legacy fixed path. Two recoverers may both
    // target this dead directory, but neither can target a fresh unique lease.
    rmSync(lockPath, { recursive: true, force: true });
    return "removed";
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return "absent";
    // A legacy creator may have died between mkdir and owner publication.
    // Its identity-free directory cannot be recovered without risking a live
    // old writer, so fail closed instead of stealing it.
    return "blocked";
  }
}

function scanConfigLocks(configPath: string): ConfigLockScan {
  const directory = dirname(configPath);
  const participants = new Map<string, ConfigLockParticipant>();
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return { choosing: [], invalid: [], owners: [], legacyBlocked: false };
    }
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    const parsed = configLockParticipant(path, configPath);
    if (!parsed) continue;
    const key = `${parsed.pid}:${parsed.token}`;
    const participant = participants.get(key) ?? { pid: parsed.pid, token: parsed.token };
    if (parsed.kind === "choosing") participant.choosingPath = path;
    else participant.ownerPath = path;
    participants.set(key, participant);
  }

  const choosing: ConfigLockParticipant[] = [];
  const invalid: ConfigLockParticipant[] = [];
  const owners: ConfigLockScan["owners"] = [];
  for (const participant of participants.values()) {
    if (reclaimableConfigLock(participant)) {
      removeStaleConfigLock(participant);
      continue;
    }
    if (participant.choosingPath) choosing.push(participant);
    if (!participant.ownerPath) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(participant.ownerPath, "utf8"));
      if (validConfigLockOwner(parsed, participant)) {
        owners.push({ participant, owner: parsed });
      } else {
        invalid.push(participant);
      }
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") invalid.push(participant);
    }
  }

  const legacy = inspectLegacyConfigLock(configPath);
  return {
    choosing,
    invalid,
    owners,
    legacyBlocked: legacy === "blocked",
  };
}

function compareConfigLockOwners(left: ConfigUpdateLockOwner, right: ConfigUpdateLockOwner): number {
  if (left.ticket !== right.ticket) return left.ticket - right.ticket;
  return left.token.localeCompare(right.token);
}

function configLockIsOwned(configPath: string, expected: ConfigUpdateLockOwner): boolean {
  const scan = scanConfigLocks(configPath);
  const own = scan.owners.find(({ owner }) =>
    owner.pid === expected.pid
    && owner.token === expected.token
    && owner.ticket === expected.ticket
  );
  if (!own || scan.legacyBlocked) return false;
  return !scan.owners.some(({ owner }) =>
    owner.token !== expected.token
    && compareConfigLockOwners(owner, expected) < 0
  );
}

function configLockOwnershipError(configPath: string): Error {
  return new Error(
    `Lost the config update lease before committing ${configPath}; retry the command.`,
  );
}

/**
 * Serialize whole-file config rewrites across Cicero processes. The lease
 * uses unique bakery tickets: concurrent recovery can only delete the
 * exact dead participant it inspected, never a replacement writer's lease.
 */
export function acquireConfigUpdateLock(
  configPath: string = join(ciceroHome(), CONFIG_FILE),
  options: ConfigUpdateLockOptions = {},
): ConfigUpdateLock {
  ensurePrivateDirectorySync(dirname(configPath));
  retryPendingConfigLockCleanups();
  const token = randomUUID();
  const participantBase = `${configPath}.update-lock-${process.pid}-${token}`;
  const choosingPath = `${participantBase}.choosing`;
  const ownerPath = `${participantBase}.owner.json`;
  const deadlineMs = Date.now() + CONFIG_UPDATE_LOCK_TIMEOUT_MS;
  let owner: ConfigUpdateLockOwner | undefined;
  const lease: ConfigUpdateLeaseState = {
    token,
    usable: true,
    cleanupPaths: new Set(),
  };
  const unlinkPath = options.unlinkSync ?? unlinkSync;

  liveConfigUpdateLeases.set(token, lease);
  try {
    writeFileSync(choosingPath, "", { flag: "wx", mode: PRIVATE_FILE_MODE });
    const initial = scanConfigLocks(configPath);
    const highestTicket = initial.owners.reduce(
      (highest, entry) => Math.max(highest, entry.owner.ticket),
      0,
    );
    if (highestTicket >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`Config update lease tickets are exhausted for ${configPath}`);
    }
    owner = {
      pid: process.pid,
      token,
      acquiredAtMs: Date.now(),
      ticket: highestTicket + 1,
    };
    writeFileSync(ownerPath, JSON.stringify(owner), {
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    unlinkPath(choosingPath);

    while (true) {
      const scan = scanConfigLocks(configPath);
      const own = scan.owners.find(({ owner: candidate }) =>
        candidate.pid === owner!.pid
        && candidate.token === owner!.token
        && candidate.ticket === owner!.ticket
      );
      const blockedByOwner = scan.owners.some(({ owner: candidate }) =>
        candidate.token !== owner!.token
        && compareConfigLockOwners(candidate, owner!) < 0
      );
      if (
        own
        && !scan.legacyBlocked
        && scan.choosing.length === 0
        && scan.invalid.length === 0
        && !blockedByOwner
      ) {
        return {
          assertOwned(): void {
            if (!lease.usable || !configLockIsOwned(configPath, owner!)) {
              throw configLockOwnershipError(configPath);
            }
          },
          release(): void {
            if (!liveConfigUpdateLeases.has(token)) return;
            lease.usable = false;
            attemptConfigLockCleanups(
              [{ path: ownerPath, owner: owner!, lease }],
              unlinkPath,
            );
          },
        };
      }

      const nowMs = Date.now();
      if (nowMs >= deadlineMs) {
        throw new Error(
          `Timed out waiting for another Cicero process to finish updating ${configPath}; retry the command.`,
        );
      }
      Atomics.wait(configLockWaiter, 0, 0, Math.min(CONFIG_UPDATE_LOCK_WAIT_MS, deadlineMs - nowMs));
    }
  } catch (error: unknown) {
    lease.usable = false;
    attemptConfigLockCleanups([
      { path: choosingPath, lease },
      { path: ownerPath, owner, lease },
    ], unlinkPath);
    throw error;
  }
}

export const DEFAULT_CONFIG: CiceroConfig = {
  tts_enabled: true,
  hotkey: "ctrl+shift+space",
  terminal: "auto",
  voice: "default",
  brain: {
    backend: "claude-code",
    mode: "tab-inject",
    target_tab: "cicero-brain",
    auto_approve_tools: false,
    confirm_retry: true,
  },
  servers: {
    router: {
      port: 8081,
      model: "mlx-community/Qwen3.5-0.8B-MLX-4bit",
    },
    tts: {
      port: 8082,
      model: "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16",
    },
    stt: {
      port: 8083,
      model: "mlx-community/whisper-large-v3-turbo",
    },
  },
  actions: {},
  phonetic_aliases: {
    tabs: ["tubs", "hubs", "taps", "tops"],
    tab: ["tub", "hub", "tap", "top", "tam"],
    switch: ["swish", "stitch"],
    list: ["least", "last"],
  },
  // Optional sidecar mode (instead of, or alongside, the daemon's voice loop):
  // sidecar: { backend: "claude-code-hook", port: 8084 }
  // sidecar: { backend: "terminal-scrape", targetTab: "1", pollIntervalMs: 500, quietWindowMs: 1500 }
  //
  // Optional Wyoming backends — point STT/TTS at a Home Assistant Wyoming server:
  // stt: { backend: "wyoming", host: "192.168.1.10", port: 10300 }  # wyoming-faster-whisper
  // tts: { backend: "wyoming", host: "192.168.1.10", port: 10200 }  # wyoming-piper
  //
  // STT on the audio.cpp native runtime — the whole voice stack (TTS + STT) on
  // one CUDA server, no Python venv. faster-whisper stays the default; this is
  // opt-in and shares the audio.cpp seat (add a task:"asr" model to
  // servers/audiocpp_server.local.json beside the TTS entry):
  // stt: { backend: "audiocpp", port: 8092, model: "qwen3-asr" }
  //
  // Any HTTP backend also takes `host` to target a remote model server — run the
  // heavy models on a GPU box and drive Cicero from a laptop. When host is set to
  // a non-local address Cicero connects directly (it won't launch a local server):
  // stt: { backend: "faster-whisper", host: "192.168.1.50", port: 8083 }
  // llm: { backend: "ollama", host: "192.168.1.50", port: 11434 }
  //
  // Cloud / paid brain — any OpenAI-compatible API (key via env, set at setup):
  // llm: { backend: "openai", model: "gpt-4o-mini" }                 # OPENAI_API_KEY
  // llm: { backend: "openrouter", model: "..." }                     # OPENROUTER_API_KEY
  // Chinese providers (all OpenAI-compatible):
  // llm: { backend: "deepseek", model: "deepseek-chat" }             # DEEPSEEK_API_KEY
  // llm: { backend: "dashscope", model: "qwen-max" }                 # DASHSCOPE_API_KEY (Qwen/Alibaba)
  // llm: { backend: "moonshot", model: "kimi-k2" }                   # MOONSHOT_API_KEY (Kimi)
  // llm: { backend: "zhipu", model: "glm-4" }                        # ZHIPUAI_API_KEY (GLM)
  // Anything else OpenAI-compatible (other clouds, local vLLM, …):
  // llm: { backend: "openai-compatible", baseUrl: "https://host/v1", model: "...", apiKeyEnv: "MY_KEY" }
  //
  // Agent brain that can DO STUFF (tools + memory), harness-independent via ACP.
  // Hot-swap the agent by changing binary/binary_args — the voice layer is identical:
  // brain: { backend: "acp", binary: "ssh", binary_args: ["gpu-box", "hermes", "acp"], auto_approve_tools: true }   # remote ACP agent over LAN
  // brain: { backend: "acp", binary: "bun", binary_args: ["x", "@zed-industries/claude-code-acp@0.16.2"], unset_env: ["ANTHROPIC_API_KEY"], auto_approve_tools: true }  # local Claude Code agent (unset key → subscription login)
  // brain: { backend: "acp", binary: "gemini", binary_args: ["--acp"], auto_approve_tools: true }                    # local Gemini CLI agent
  // Add `agent_first: true` to route EVERY conversational turn to the agent (not just
  // "ask claude…"); `thinking_filler: true` (default) speaks a varied "let me think…"
  // line to cover the agent's latency. CLI A/B: `--agent-first` / `--no-agent-first`.
};

const DEFAULT_ACTIONS: Record<string, ActionConfig> = {
  tab_switch: {
    category: "terminal",
    // Handled by ActionExecutor via the terminal adapter, not a shell command.
    command: "",
    tts_mode: "silent",
    examples: ["switch to {tab}", "go to {tab}", "open {tab} tab"],
  },
  tab_list: {
    category: "terminal",
    // Handled by ActionExecutor via the terminal adapter, not a shell command.
    command: "",
    tts_mode: "summary",
    examples: ["show my tabs", "list tabs", "what tabs are open", "how many tabs", "list out my tabs"],
  },
  slack_check: {
    category: "cli",
    command: "slack-cli.ts search --recent",
    tts_mode: "summary",
    examples: ["check slack", "any slack messages", "what's on slack"],
  },
  calendar_today: {
    category: "cli",
    command: "calendar-cli.ts today",
    tts_mode: "summary",
    examples: ["what's on my calendar", "any meetings today", "calendar"],
  },
  email_check: {
    category: "cli",
    command: "gmail-cli.ts inbox --unread",
    tts_mode: "summary",
    examples: ["check my email", "any new emails", "inbox"],
  },
  morning_checkin: {
    category: "brain",
    command: "/pm-checkin",
    tts_mode: "summary",
    examples: ["morning checkin", "run my checkin", "what's my day look like"],
  },
  sales_pipeline: {
    category: "brain",
    command: "/pm-pipeline",
    tts_mode: "silent",
    examples: ["check the pipeline", "show me open opps", "sales pipeline"],
  },
  // Local actions — answered instantly without brain
  time_check: {
    category: "local",
    command: "date '+%I:%M %p %Z'",
    tts_mode: "full",
    examples: ["what time is it", "time", "what's the time", "current time"],
  },
  date_check: {
    category: "local",
    command: "date '+%A, %B %d, %Y'",
    tts_mode: "full",
    examples: ["what's the date", "what day is it", "today's date"],
  },
  greeting: {
    category: "local",
    command: "",
    tts_mode: "full",
    examples: ["hello", "hey", "hi", "good morning", "good afternoon"],
  },
  help: {
    category: "local",
    command: "",
    tts_mode: "full",
    examples: ["what can you do", "help", "what do you do", "what are you", "who are you", "what is cicero", "what's cicero"],
  },
  disk_space: {
    category: "local",
    command: "df -h / | tail -1 | awk '{print $4\" available out of \"$2}'",
    tts_mode: "full",
    examples: ["disk space", "how much space", "storage"],
  },
  battery: {
    category: "local",
    command: "pmset -g batt | grep -o '[0-9]*%'",
    tts_mode: "full",
    examples: ["battery", "battery level", "how much battery"],
  },
  uptime: {
    category: "local",
    command: "uptime | sed 's/.*up /Up /' | sed 's/,.*//'",
    tts_mode: "full",
    examples: ["uptime", "how long has this been running"],
  },
  // --- LLM-routable intents (previously regex-only in daemon.ts) ---
  text_inject: {
    category: "brain",
    command: "",  // handled by daemon, not shell
    tts_mode: "summary",
    examples: [
      "type {payload}",
      "type in {payload}",
      "enter {payload}",
      "type {payload} into the prompt",
      "send {payload} to the brain",
      "tell the brain {payload}",
      "tell claude {payload}",
      "ask claude to {payload}",
      "write {payload} in the terminal",
    ],
  },
  runtime_mute: {
    category: "local",
    command: "",
    tts_mode: "silent",
    examples: ["mute", "turn off tts", "tts off", "stop talking", "be quiet", "silence", "shut up"],
  },
  runtime_unmute: {
    category: "local",
    command: "",
    tts_mode: "silent",
    examples: ["unmute", "turn on tts", "tts on", "start talking", "speak again"],
  },
  runtime_restart_brain: {
    category: "local",
    command: "",
    tts_mode: "full",
    examples: ["restart brain", "restart claude", "reboot the brain", "reset the brain"],
  },
  runtime_voice_toggle: {
    category: "local",
    command: "",
    tts_mode: "silent",
    examples: ["voice", "voice mode", "start listening", "listen", "activate voice", "turn on voice"],
  },
  tab_command: {
    category: "terminal",
    command: "",
    tts_mode: "full",
    examples: [
      "switch to {tab}",
      "go to {tab} tab",
      "use {tab} tab",
      "switch brain to {tab}",
      "in {tab} tab run {command}",
      "on {tab} tab do {command}",
      "switch to {tab} and {command}",
    ],
  },
};

export interface ActionSnapshot {
  actions: Record<string, ActionConfig>;
  customCount: number;
}

/**
 * Read one complete actions snapshot. An absent file means built-in actions only;
 * an existing file must contain an `actions` mapping.
 */
export function loadActionSnapshot(actionsPath: string): ActionSnapshot {
  if (!ensurePrivateFileIfExistsSync(actionsPath)) {
    return { actions: structuredClone(DEFAULT_ACTIONS), customCount: 0 };
  }

  const parsed = requireConfigMapping(parseYaml(readFileSync(actionsPath, "utf-8")) ?? {}, actionsPath);
  if (Object.keys(parsed).length === 0) {
    return { actions: structuredClone(DEFAULT_ACTIONS), customCount: 0 };
  }
  const unknownRootKeys = Object.keys(parsed).filter((key) => key !== "actions");
  if (unknownRootKeys.length > 0) {
    throw new ConfigValidationError(
      actionsPath,
      unknownRootKeys.map((key) => `${key} is not supported; actions.yaml must contain only an actions mapping`),
    );
  }
  const custom = requireConfigMapping(parsed.actions, `${actionsPath}#actions`);
  return {
    actions: {
      ...structuredClone(DEFAULT_ACTIONS),
      ...(custom as Record<string, ActionConfig>),
    },
    customCount: Object.keys(custom).length,
  };
}

export interface CLIFlags {
  tts?: boolean;
  brain?: string;
  brainMode?: "subprocess" | "tab-inject";
  brainTab?: string;
  turn?: boolean;
  agentFirst?: boolean;
}

// Runtime state that can be toggled
export class RuntimeConfig {
  private config: CiceroConfig;

  constructor(config: CiceroConfig) {
    this.config = { ...config };
  }

  get ttsEnabled(): boolean { return this.config.tts_enabled; }
  set ttsEnabled(v: boolean) { this.config.tts_enabled = v; }

  get hotkey(): string { return this.config.hotkey; }
  get dictation(): DictationConfig { return this.config.dictation ?? {}; }
  get terminal(): string { return this.config.terminal; }
  get voice(): string { return this.config.voice; }
  get voiceRefAudio(): string | undefined { return this.config.voice_ref_audio; }
  get voiceRefText(): string | undefined { return this.config.voice_ref_text; }
  get bargeInEnabled(): boolean { return this.config.barge_in_enabled ?? false; }
  get fullDuplex(): boolean { return this.config.full_duplex ?? false; }
  get aec(): boolean { return this.config.aec ?? false; }
  get ttsSummaryMaxTokens(): number { return this.config.tts_summary_max_tokens ?? 100; }
  get ttsLocalMaxTokens(): number { return this.config.tts_local_max_tokens ?? 150; }
  get silenceDuration(): string { return this.config.silence_duration ?? "1.0"; }
  get silenceThreshold(): string { return this.config.silence_threshold ?? "3%"; }
  get brain(): CiceroConfig["brain"] { return this.config.brain; }
  get servers(): CiceroConfig["servers"] { return this.config.servers; }
  get actions(): Record<string, ActionConfig> { return this.config.actions; }
  get phoneticAliases(): Record<string, string[]> { return this.config.phonetic_aliases ?? {}; }
  get sidecar(): SidecarConfig | undefined { return this.config.sidecar; }
  get dashboard(): { enabled?: boolean; port?: number } | undefined { return this.config.dashboard; }
  get web_voice(): CiceroConfig["web_voice"] { return this.config.web_voice; }
  get notify(): CiceroConfig["notify"] { return this.config.notify; }
  get compute(): { allowCloud: boolean; root: string | undefined; maxReadBytes: number } {
    return {
      allowCloud: this.config.compute?.allow_cloud ?? false,
      root: this.config.compute?.root,
      maxReadBytes: this.config.compute?.max_read_bytes ?? 256 * 1024,
    };
  }
  get headless(): boolean { return this.config.headless ?? false; }
  get earcons(): boolean { return this.config.earcons ?? true; }

  /** Resolved semantic end-of-turn settings with defaults applied. */
  get turn(): {
    enabled: boolean;
    backend?: "smart-turn";
    host?: string;
    port: number;
    model?: string;
    threshold: number;
    graceAttempts: number;
    graceMaxDuration: number;
    timeoutMs?: number;
  } {
    const t = this.config.turn ?? {};
    return {
      enabled: t.enabled ?? false,
      backend: t.backend,
      host: t.host,
      port: t.port ?? 8087,
      model: t.model,
      threshold: t.threshold ?? 0.6,
      graceAttempts: t.grace_attempts ?? 2,
      graceMaxDuration: t.grace_max_duration ?? 3,
      timeoutMs: t.timeout_ms,
    };
  }

  /** Resolved input-side tone (speech-emotion) settings with defaults applied. */
  get tone(): {
    enabled: boolean;
    host?: string;
    port: number;
    model?: string;
    minScore: number;
    graceMs: number;
    minMs: number;
    timeoutMs?: number;
  } {
    const t = this.config.tone ?? {};
    return {
      enabled: t.enabled ?? false,
      host: t.host,
      port: t.port ?? 8091,
      model: t.model,
      minScore: t.min_score ?? 0.5,
      graceMs: t.grace_ms ?? 150,
      minMs: t.min_ms ?? 1500,
      timeoutMs: t.timeout_ms,
    };
  }

  /** Resolved double-clap activation settings with defaults applied. */
  get clap(): { enabled: boolean; threshold: number; minGapMs: number; maxGapMs: number; deactivate: boolean } {
    const c = this.config.clap ?? {};
    return {
      enabled: c.enabled ?? true,
      threshold: c.threshold ?? 0.5,
      minGapMs: c.min_gap_ms ?? 80,
      maxGapMs: c.max_gap_ms ?? 600,
      deactivate: c.deactivate ?? false,
    };
  }

  /**
   * Resolved intent-judge settings. `enabled` alone is not enough to turn it on:
   * the daemon also needs a configured `classifier` model, and says so when one
   * is missing rather than borrowing the reply model.
   */
  get intentJudge(): {
    enabled: boolean;
    hotWindowMs: number;
    minConfidence: number;
    contextTurns: number;
    timeoutMs: number;
  } {
    const j = this.config.intent_judge ?? {};
    return {
      enabled: j.enabled ?? false,
      hotWindowMs: j.hot_window_ms ?? 15_000,
      minConfidence: j.min_confidence ?? 0.6,
      contextTurns: j.context_turns ?? 4,
      timeoutMs: j.timeout_ms ?? 1_500,
    };
  }

  /** Resolved streaming-VAD end-of-turn settings with defaults applied. */
  get vad(): {
    enabled: boolean;
    hangoverMs: number;
    openFactor: number;
    minSpeechMs: number;
    calibrationMs: number;
    prerollMs: number;
  } {
    const v = this.config.vad ?? {};
    return {
      enabled: v.enabled ?? true,
      hangoverMs: v.hangover_ms ?? 500,
      openFactor: v.open_factor ?? 3,
      minSpeechMs: v.min_speech_ms ?? 120,
      calibrationMs: v.calibration_ms ?? 300,
      prerollMs: v.preroll_ms ?? 240,
    };
  }

  /** Resolved TTS input coalescing, or null when it is off (the default). */
  get ttsCoalesce(): CoalesceOptions | null {
    const c = this.config.tts_coalesce;
    if (!c?.enabled) return null;
    return {
      maxChars: c.max_chars ?? DEFAULT_COALESCE_OPTIONS.maxChars,
      passthroughFirst: c.passthrough_first ?? DEFAULT_COALESCE_OPTIONS.passthroughFirst,
    };
  }

  get quickIntents(): CiceroConfig["quick_intents"] { return this.config.quick_intents; }
  get raw(): CiceroConfig { return this.config; }

  /** Commit one validated live provider selection after its candidate is ready. */
  setVoiceBackend(role: "stt" | "tts", value: STTProviderConfig | TTSProviderConfig): void {
    if (role === "stt") this.config.stt = { ...value } as CiceroConfig["stt"];
    else this.config.tts = { ...value } as CiceroConfig["tts"];
  }

  /** Keep runtime fallback ownership aligned with an atomically persisted swap plan. */
  setVoiceFallback(role: "stt" | "tts", value: STTProviderConfig | TTSProviderConfig): void {
    if (role === "stt") this.config.stt_fallback = { ...value } as CiceroConfig["stt_fallback"];
    else this.config.tts_fallback = { ...value } as CiceroConfig["tts_fallback"];
  }

  get sttBackend(): STTProviderConfig {
    if (this.config.stt) {
      return this.config.stt as STTProviderConfig;
    }
    return {
      backend: "mlx-whisper",
      port: this.config.servers.stt.port,
      model: this.config.servers.stt.model,
    };
  }

  /** Optional hot-standby STT engine — see FallbackSTTProvider. */
  get sttFallbackBackend(): STTProviderConfig | null {
    return (this.config.stt_fallback as STTProviderConfig | undefined) ?? null;
  }

  get ttsBackend(): TTSProviderConfig {
    if (this.config.tts) {
      const explicit = this.config.tts as TTSProviderConfig;
      const voiceContract = voiceProviderContractForBackend(explicit.backend);
      // Legacy global references feed only reference-capable backends. Stale
      // paths must not leak into an ID/preset backend after `voice use` switches.
      const acceptsReference = !explicit.backend
        || explicit.backend === "mlx-audio"
        || voiceContract?.activation === "reference";
      if (!acceptsReference) {
        const { refAudio: _staleAudio, refText: _staleText, ...withoutReferences } = explicit;
        return withoutReferences;
      }
      return {
        ...explicit,
        refAudio: explicit.refAudio ?? this.config.voice_ref_audio,
        refText: explicit.refText ?? this.config.voice_ref_text,
      };
    }
    return {
      backend: "mlx-audio",
      port: this.config.servers.tts.port,
      model: this.config.servers.tts.model,
      voice: this.config.voice === "default" ? "Ryan" : this.config.voice,
      refAudio: this.config.voice_ref_audio,
      refText: this.config.voice_ref_text,
    };
  }

  /** Optional hot-standby TTS engine — see FallbackTTSProvider. */
  get ttsFallbackBackend(): TTSProviderConfig | null {
    return (this.config.tts_fallback as TTSProviderConfig | undefined) ?? null;
  }

  get llmBackend(): LLMProviderConfig {
    if (this.config.llm) {
      return this.config.llm as LLMProviderConfig;
    }
    return {
      backend: "mlx-lm",
      port: this.config.servers.router.port,
      model: this.config.servers.router.model,
    };
  }

  /**
   * Optional classification-only model. Unlike llmBackend there is no implicit
   * default: an absent section means the role is unconfigured, which callers
   * must treat as "off", never as "borrow the reply model".
   */
  get classifierBackend(): LLMProviderConfig | null {
    return (this.config.classifier as LLMProviderConfig | undefined) ?? null;
  }
}

/**
 * Load the merged Cicero config (defaults ← config file ← tier preset ← flags).
 *
 * `opts.home` overrides the directory the config/actions files are read from
 * (defaults to {@link ciceroHome}). Resolving the directory at call time — rather
 * than at module load — lets tests point at a config-free directory to exercise
 * built-in defaults without depending on the developer's real ~/.cicero.
 */
export function loadConfig(
  flags: CLIFlags = {},
  opts: { home?: string; allowInvalidWebVoiceToken?: boolean } = {},
): RuntimeConfig {
  const home = opts.home ?? ciceroHome();
  ensurePrivateDirectorySync(home);
  const configPath = join(home, CONFIG_FILE);
  const actionsPath = join(home, ACTIONS_FILE);

  // Deep clone so flag/file overrides never mutate the shared DEFAULT_CONFIG
  // (nested objects like `brain` would otherwise be aliased across calls).
  let config = structuredClone(DEFAULT_CONFIG);

  // Layer 1: Config file
  if (ensurePrivateFileIfExistsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      // An empty or comment-only document parses as null and means "use the
      // defaults", matching updateConfigFields' empty-document behavior.
      const parsed = requireConfigMapping(parseYaml(raw) ?? {}, configPath) as Partial<CiceroConfig>;
      config = deepMerge(config, parsed);
    } catch (e) {
      throw new Error(`Could not load ${configPath}: ${(e as Error).message}`, { cause: e });
    }
  }

  // Load actions
  try {
    config.actions = loadActionSnapshot(actionsPath).actions;
  } catch (e) {
    throw new Error(`Could not load ${actionsPath}: ${(e as Error).message}`, { cause: e });
  }

  // Tier expansion — apply preset defaults if deployment is set
  const rawConfig = config as unknown as Record<string, unknown>;
  if (rawConfig.deployment && typeof rawConfig.deployment === "string") {
    const tier = TIER_PRESETS[rawConfig.deployment];
    if (tier) {
      if (tier.stt && !rawConfig.stt) rawConfig.stt = tier.stt;
      if (tier.tts && !rawConfig.tts) rawConfig.tts = tier.tts;
      if (tier.llm && !rawConfig.llm) rawConfig.llm = tier.llm;
      if (tier.terminal && !rawConfig.terminal) config.terminal = tier.terminal as CiceroConfig["terminal"];
    }
  }

  // Layer 2: CLI flags override
  if (flags.tts !== undefined) config.tts_enabled = flags.tts;
  if (flags.brain) {
    const VALID_BRAINS = ["claude-code", "codex", "gemini", "qwen", "ollama", "acp"] as const;
    if (!(VALID_BRAINS as readonly string[]).includes(flags.brain)) {
      throw new Error(`Invalid --brain value '${flags.brain}'. Valid: ${VALID_BRAINS.join(", ")}`);
    }
    config.brain.backend = flags.brain as CiceroConfig["brain"]["backend"];
  }
  if (flags.brainMode) config.brain.mode = flags.brainMode;
  if (flags.brainTab) config.brain.target_tab = flags.brainTab;
  // --turn/--no-turn flips Smart-Turn without editing config.yaml, for A/B.
  if (flags.turn !== undefined) config.turn = { ...(config.turn ?? {}), enabled: flags.turn };
  // --agent-first/--no-agent-first routes all conversation to the brain, for A/B.
  if (flags.agentFirst !== undefined) config.brain.agent_first = flags.agentFirst;

  const configuredToken = config.web_voice?.token;
  const ignoreTokenProblem = opts.allowInvalidWebVoiceToken === true
    && configuredToken !== undefined
    && webVoiceTokenProblem(configuredToken) !== null;
  if (ignoreTokenProblem) delete config.web_voice!.token;
  try {
    validateRuntimeConfig(config, configPath);
  } finally {
    if (ignoreTokenProblem) config.web_voice!.token = configuredToken;
  }
  return new RuntimeConfig(config);
}

export function ensureConfigDir(): void {
  ensurePrivateDirectorySync(ciceroHome());
}

/**
 * Persist a partial config to `config.yaml`, deep-merging into any existing
 * user config. Writes atomically (tmp file + rename) so a crash mid-write can
 * never leave a truncated config. Used by `cicero voice use` and other commands
 * that mutate persisted settings.
 */
export interface ConfigUpdateOptions {
  replaceTopLevel?: readonly (keyof CiceroConfig)[];
  preserveTopLevelWhenSame?: readonly {
    key: keyof CiceroConfig;
    discriminator: string;
  }[];
  clearNested?: readonly {
    key: keyof CiceroConfig;
    fields: readonly string[];
  }[];
  /** Internal final gate run synchronously at the config commit boundary. */
  validateBeforeCommit?: () => void;
}

export function updateConfigFields(
  fields: Partial<CiceroConfig>,
  configPath: string = join(ciceroHome(), CONFIG_FILE),
  options: ConfigUpdateOptions = {},
): void {
  ensurePrivateDirectorySync(dirname(configPath));
  const lock = acquireConfigUpdateLock(configPath);
  try {
    let existing: Record<string, unknown> = {};
    if (ensurePrivateFileIfExistsSync(configPath)) {
      const original = readFileSync(configPath, "utf-8");
      try {
        const parsed = parseYaml(original);
        existing = requireConfigMapping(
          parsed === null && isBlankYamlDocument(original) ? {} : parsed,
          configPath,
        );
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Refusing to update ${configPath}: the existing file is not valid mapping YAML. `
          + `Fix it manually or move it aside, then retry. The original file was not changed. ${detail}`,
          { cause: error },
        );
      }
    }
    const incoming = fields as Record<string, unknown>;
    for (const key of options.replaceTopLevel ?? []) {
      const name = String(key);
      const preserveRule = options.preserveTopLevelWhenSame?.find((rule) => rule.key === key);
      const currentValue = existing[name];
      const incomingValue = incoming[name];
      const currentDiscriminator = preserveRule && isMapping(currentValue)
        ? currentValue[preserveRule.discriminator]
        : undefined;
      const incomingDiscriminator = preserveRule && isMapping(incomingValue)
        ? incomingValue[preserveRule.discriminator]
        : undefined;
      const preserve = currentDiscriminator !== undefined
        && currentDiscriminator === incomingDiscriminator;
      if (!preserve) delete existing[name];
    }
    for (const rule of options.clearNested ?? []) {
      const currentValue = existing[String(rule.key)];
      if (!isMapping(currentValue)) continue;
      for (const field of rule.fields) delete currentValue[field];
    }
    const merged = deepMerge(existing, fields);
    const tmp = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(tmp, stringifyYaml(merged), { flag: "wx", mode: PRIVATE_FILE_MODE });
      ensurePrivateFileSync(tmp);
      options.validateBeforeCommit?.();
      lock.assertOwned();
      renameSync(tmp, configPath);
      ensurePrivateFileSync(configPath);
    } catch (error: unknown) {
      try { unlinkSync(tmp); } catch { /* absent after rename, or best-effort cleanup */ }
      throw error;
    }
  } finally {
    lock.release();
  }
}

/**
 * Persist only `web_voice.token` without reserializing the rest of config.yaml.
 * The common block-style form is edited line-by-line so comments and layout are
 * byte-for-byte preserved; unusual YAML shapes fall back to yaml's comment-aware
 * document editor. The final write uses the same private atomic path as other
 * config mutations.
 */
export function setWebVoiceToken(
  token: string,
  configPath: string = join(ciceroHome(), CONFIG_FILE),
): void {
  const problem = webVoiceTokenProblem(token);
  if (problem) throw new Error(`web_voice.token ${problem}`);
  ensurePrivateDirectorySync(dirname(configPath));
  const lock = acquireConfigUpdateLock(configPath);
  try {
    const original = ensurePrivateFileIfExistsSync(configPath)
      ? readFileSync(configPath, "utf8")
      : "";
    let updated: string;
    const lines = original.split("\n");
    const webVoiceLine = lines.findIndex((line) => /^web_voice\s*:\s*(?:#.*)?\r?$/.test(line));
    if (webVoiceLine >= 0) {
      let blockEnd = lines.length;
      for (let index = webVoiceLine + 1; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (line.trim() === "" || /^\s+#/.test(line)) continue;
        if (!/^\s/.test(line)) {
          blockEnd = index;
          break;
        }
      }
      const tokenLine = lines.findIndex((line, index) => (
        index > webVoiceLine
        && index < blockEnd
        && /^\s+token\s*:/.test(line)
      ));
      if (tokenLine >= 0) {
        const match = lines[tokenLine]!.match(/^(\s+token\s*:\s*)([^#\r]*?)(\s+#.*)?(\r?)$/);
        if (!match) throw new Error(`Refusing to update ${configPath}: web_voice.token uses an unsupported YAML form`);
        lines[tokenLine] = `${match[1]}${JSON.stringify(token)}${match[3] ?? ""}${match[4] ?? ""}`;
      } else {
        const indentation = lines
          .slice(webVoiceLine + 1, blockEnd)
          .map((line) => line.match(/^(\s+)\S/))
          .find((match) => match)?.[1] ?? "  ";
        const carriageReturn = lines[webVoiceLine]!.endsWith("\r") ? "\r" : "";
        lines.splice(webVoiceLine + 1, 0, `${indentation}token: ${JSON.stringify(token)}${carriageReturn}`);
      }
      updated = lines.join("\n");
    } else {
      const document = parseYamlDocument(original || "{}\n");
      if (document.errors.length > 0) {
        throw new Error(`Refusing to update ${configPath}: the existing file is not valid YAML`);
      }
      document.setIn(["web_voice", "token"], token);
      updated = String(document);
    }

    const tmp = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(tmp, updated, { flag: "wx", mode: PRIVATE_FILE_MODE });
      ensurePrivateFileSync(tmp);
      lock.assertOwned();
      renameSync(tmp, configPath);
      ensurePrivateFileSync(configPath);
    } catch (error: unknown) {
      try { unlinkSync(tmp); } catch { /* absent after rename, or best-effort cleanup */ }
      throw error;
    }
  } finally {
    lock.release();
  }
}

function isBlankYamlDocument(source: string): boolean {
  return source.split(/\r?\n/).every((line) => {
    const trimmed = line.trim();
    return trimmed === "" || trimmed.startsWith("#");
  });
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge<T extends object>(target: T, source: object): T {
  const targetRecord = target as Record<string, unknown>;
  const sourceRecord = source as Record<string, unknown>;
  const result: Record<string, unknown> = { ...targetRecord };
  for (const key of Object.keys(sourceRecord)) {
    const sourceValue = sourceRecord[key];
    if (isMapping(sourceValue)) {
      const targetValue = isMapping(targetRecord[key]) ? targetRecord[key] : {};
      result[key] = deepMerge(targetValue, sourceValue);
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue;
    }
  }
  return result as T;
}
