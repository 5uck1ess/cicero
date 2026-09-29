import { homedir } from "node:os";
import { join } from "node:path";
import { OPENAI_COMPATIBLE_BACKENDS, resolveOpenAiTarget } from "../backends/llm/openai";
import { runBoundedCommand } from "../process/bounded-command";
import type { PickerDeps } from "./pickers";
import { readBoundedText } from "./read-bounded";

// Presence checks only; a real credential file is a few KB.
const CREDENTIAL_FILE_LIMIT = 1024 * 1024;

/**
 * Read-only account detection for the Accounts step. It reports only whether a
 * login or key exists and which one the tool will most likely bill; it never
 * reads, returns, or logs a credential value. Facts verified on 2026-09-29 are
 * recorded in docs/superpowers/plans/2026-09-29-setup-v2-verification.md.
 */
export type AgentProvider = "claude" | "codex" | "grok";
export type Presence = "found" | "not found" | "unknown";
export interface AccountStatus {
  provider: AgentProvider;
  login: Presence;
  loginSource: string | null;
  /** True when the login's validity cannot be checked read-only (Codex reports a dead token as logged in). */
  loginUnvalidated: boolean;
  key: "found" | "not found";
  keyVariable: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "XAI_API_KEY";
  likely: "subscription" | "per-token key" | "unknown";
  keyOverridesLogin: boolean | "unknown";
}
export interface AccountsDetected {
  agents: AccountStatus[];
  /** OpenAI-compatible preset id → whether its API key variable is set. */
  cloudKeys: Record<string, "found" | "not found">;
  recommended: AgentProvider[];
  reason: string;
}
export interface AccountsChoice { useSubscription: AgentProvider[] }

const KEY_VARIABLE: Record<AgentProvider, AccountStatus["keyVariable"]> = { claude: "ANTHROPIC_API_KEY", codex: "OPENAI_API_KEY", grok: "XAI_API_KEY" };
const PROBE = { timeoutMs: 1500, stdoutLimitBytes: 4096, stderrLimitBytes: 1024, totalLimitBytes: 5120, outputLimitBehavior: "error" as const };

function has(env: Record<string, string | undefined>, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.length > 0;
}

function readText(deps: PickerDeps, path: string): string | null {
  if (deps.readFile) return deps.readFile(path);
  try { return readBoundedText(path, CREDENTIAL_FILE_LIMIT); } catch { return null; }
}

function without(env: Record<string, string | undefined>, name: string): Record<string, string | undefined> {
  const copy = { ...env };
  delete copy[name];
  return copy;
}

async function detectClaude(deps: PickerDeps, env: Record<string, string | undefined>, home: string): Promise<AccountStatus> {
  const key = has(env, "ANTHROPIC_API_KEY");
  const which = deps.which ?? ((binary: string) => Bun.which(binary));
  const binary = which("claude");
  let login: Presence = "unknown";
  let loginSource: string | null = null;
  if (binary) {
    // `claude auth status` prints JSON; with the key removed it reports the login underneath.
    try {
      const result = await (deps.runCommand ?? runBoundedCommand)([binary, "auth", "status"], { ...PROBE, env: without(env, "ANTHROPIC_API_KEY") });
      const parsed = JSON.parse(result.stdout.text) as { loggedIn?: unknown; authMethod?: unknown };
      if (typeof parsed.loggedIn === "boolean") {
        login = parsed.loggedIn && parsed.authMethod !== "api_key" ? "found" : "not found";
        loginSource = "claude auth status";
      }
    } catch { /* fall back to the credentials file */ }
  }
  if (login === "unknown" && (deps.platform ?? process.platform) !== "darwin") {
    const base = env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : join(home, ".claude");
    login = readText(deps, join(base, ".credentials.json")) !== null ? "found" : "not found";
    loginSource = env.CLAUDE_CONFIG_DIR ? "$CLAUDE_CONFIG_DIR/.credentials.json" : "~/.claude/.credentials.json";
  }
  // Verified: with ANTHROPIC_API_KEY set, `claude auth status` reports authMethod api_key.
  return {
    provider: "claude", login, loginSource, loginUnvalidated: false,
    key: key ? "found" : "not found", keyVariable: "ANTHROPIC_API_KEY",
    likely: key ? "per-token key" : login === "found" ? "subscription" : "unknown",
    keyOverridesLogin: key && login === "found",
  };
}

async function detectCodex(deps: PickerDeps, env: Record<string, string | undefined>, home: string): Promise<AccountStatus> {
  const key = has(env, "OPENAI_API_KEY");
  const base = env.CODEX_HOME ? env.CODEX_HOME : join(home, ".codex");
  let login: Presence = "not found";
  let loginSource: string | null = null;
  let mode: string | null = null;
  const text = readText(deps, join(base, "auth.json"));
  if (text !== null) {
    try {
      const authMode = (JSON.parse(text) as { auth_mode?: unknown }).auth_mode;
      mode = typeof authMode === "string" ? authMode : null;
    } catch { /* unreadable file: presence only */ }
    login = "found";
    loginSource = env.CODEX_HOME ? "$CODEX_HOME/auth.json" : "~/.codex/auth.json";
  } else {
    // A keyring-stored login has no auth.json; ask the CLI.
    const binary = (deps.which ?? ((name: string) => Bun.which(name)))("codex");
    if (binary) {
      try {
        const result = await (deps.runCommand ?? runBoundedCommand)([binary, "login", "status"], { ...PROBE, env });
        // Verified 2026-09-29: codex-cli 0.159.0 prints this status on stderr, with nothing on stdout.
        const status = `${result.stdout.text}\n${result.stderr.text}`;
        if (/^Logged in/m.test(status)) {
          login = "found"; loginSource = "codex login status";
          mode = /^Logged in using ChatGPT/m.test(status) ? "chatgpt" : /^Logged in using an API key/m.test(status) ? "apikey" : null;
        }
      } catch { login = "unknown"; }
    }
  }
  // Only the two known modes say how Codex bills; a malformed file or a new mode stays unknown.
  const subscription = login === "found" && mode === "chatgpt";
  const perToken = login === "found" && mode === "apikey";
  return {
    provider: "codex", login, loginSource, loginUnvalidated: login === "found",
    key: key ? "found" : "not found", keyVariable: "OPENAI_API_KEY",
    // Unverified whether OPENAI_API_KEY overrides a ChatGPT login at run time.
    likely: key && login === "found" ? "unknown" : key ? "per-token key" : subscription ? "subscription" : perToken ? "per-token key" : "unknown",
    keyOverridesLogin: key && login === "found" ? "unknown" : false,
  };
}

function detectGrok(deps: PickerDeps, env: Record<string, string | undefined>, home: string): AccountStatus {
  const key = has(env, "XAI_API_KEY");
  const login: Presence = readText(deps, join(home, ".grok", "auth.json")) !== null ? "found" : "not found";
  // Documented in the Grok CLI README: "The API key takes precedence over browser credentials."
  return {
    provider: "grok", login, loginSource: login === "found" ? "~/.grok/auth.json" : null, loginUnvalidated: login === "found",
    key: key ? "found" : "not found", keyVariable: "XAI_API_KEY",
    likely: key ? "per-token key" : login === "found" ? "subscription" : "unknown",
    keyOverridesLogin: key && login === "found",
  };
}

export async function detectAccounts(deps: PickerDeps = {}): Promise<AccountsDetected> {
  const env = deps.env ?? process.env;
  const home = (deps.homeDir ?? homedir)();
  const agents = [await detectClaude(deps, env, home), await detectCodex(deps, env, home), detectGrok(deps, env, home)];
  const cloudKeys = Object.fromEntries(OPENAI_COMPATIBLE_BACKENDS.filter((id) => id !== "openai-compatible")
    .map((id) => [id, has(env, resolveOpenAiTarget({ backend: id }).apiKeyEnv) ? "found" : "not found"] as const));
  const recommended = agents.filter((a) => a.keyOverridesLogin === true).map((a) => a.provider);
  return {
    agents, cloudKeys, recommended,
    reason: recommended.length ? "Keeps these agents on your subscription instead of per-token billing." : "No API key overrides a login.",
  };
}

export function parseAccounts(raw: unknown, detected: AccountsDetected | undefined): AccountsChoice {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Choose which accounts to use");
  const list = (raw as { useSubscription?: unknown }).useSubscription ?? [];
  if (!Array.isArray(list) || list.some((item) => item !== "claude" && item !== "codex" && item !== "grok"))
    throw new Error("Use my subscription applies only to Claude, Codex and Grok");
  const chosen = [...new Set(list as AgentProvider[])];
  // Detection is re-run on the Accounts step; later re-validation keeps the saved choice.
  if (detected) {
    for (const provider of chosen) {
      const status = detected.agents.find((a) => a.provider === provider);
      if (!status || status.keyOverridesLogin !== true)
        throw new Error(`Use my subscription needs a ${provider} login that an API key overrides`);
    }
  }
  return { useSubscription: chosen };
}

const PROVIDER_OF: Record<string, AgentProvider> = { "claude-code": "claude", claude: "claude", codex: "codex", grok: "grok" };

/** The key variables to strip from one agent's environment, so it falls back to the login. */
export function unsetEnvFor(agent: string, choice: AccountsChoice | undefined): string[] {
  const provider = PROVIDER_OF[agent];
  if (!provider || !choice?.useSubscription.includes(provider)) return [];
  return [KEY_VARIABLE[provider]];
}
