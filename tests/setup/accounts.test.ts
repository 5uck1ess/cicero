import { expect, test } from "bun:test";
import type { BoundedCommandResult } from "../../src/process/bounded-command";
import { detectAccounts, parseAccounts, unsetEnvFor } from "../../src/setup/accounts";
import { SETUP_STEPS } from "../../src/setup/steps";
import { SetupSession } from "../../src/setup/session";
import { fixtureSystem } from "./fixtures";

const out = (text: string): BoundedCommandResult => {
  const o = { text, receivedBytes: text.length, capturedBytes: text.length, limitBytes: 4096, truncated: false };
  return { command: [], exitCode: 0, durationMs: 1, stdout: o, stderr: { ...o, text: "" }, combined: { receivedBytes: text.length, capturedBytes: text.length, limitBytes: 5120, truncated: false } };
};
const files = (map: Record<string, string>) => (path: string) => map[path] ?? null;
const base = { homeDir: () => "/h", platform: "linux", which: () => null };

test("reports presence only; the key value never appears", async () => {
  const secret = "sk-ant-SYNTHETIC-TEST-MARKER-0000";
  const result = await detectAccounts({ ...base, env: { ANTHROPIC_API_KEY: secret }, readFile: files({ "/h/.claude/.credentials.json": `{"token":"${secret}"}` }) });
  expect(result.agents.find((a) => a.provider === "claude")).toMatchObject({ login: "found", key: "found", likely: "per-token key", keyOverridesLogin: true, loginSource: "~/.claude/.credentials.json" });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.recommended).toEqual(["claude"]);
});

test("login only is a subscription; key only is per-token; neither is unknown", async () => {
  const loginOnly = await detectAccounts({ ...base, env: {}, readFile: files({ "/h/.grok/auth.json": "{}" }) });
  expect(loginOnly.agents.find((a) => a.provider === "grok")).toMatchObject({ login: "found", key: "not found", likely: "subscription", keyOverridesLogin: false });
  const keyOnly = await detectAccounts({ ...base, env: { XAI_API_KEY: "SYNTHETIC" }, readFile: files({}) });
  expect(keyOnly.agents.find((a) => a.provider === "grok")).toMatchObject({ login: "not found", key: "found", likely: "per-token key", keyOverridesLogin: false });
  expect(keyOnly.agents.find((a) => a.provider === "claude")).toMatchObject({ login: "not found", likely: "unknown" });
});

test("CLAUDE_CONFIG_DIR and CODEX_HOME override the home locations; Codex reads only auth_mode", async () => {
  const result = await detectAccounts({ ...base, env: { CLAUDE_CONFIG_DIR: "/cfg", CODEX_HOME: "/alt" }, readFile: files({
    "/cfg/.credentials.json": "{}",
    "/alt/auth.json": JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "SYNTHETIC-CODEX-TOKEN" } }),
  }) });
  expect(result.agents.find((a) => a.provider === "claude")).toMatchObject({ login: "found", loginSource: "$CLAUDE_CONFIG_DIR/.credentials.json" });
  expect(result.agents.find((a) => a.provider === "codex")).toMatchObject({ login: "found", loginSource: "$CODEX_HOME/auth.json", loginUnvalidated: true, likely: "subscription" });
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC-CODEX-TOKEN");
});

test("Codex key-over-login precedence is unverified, so it is unknown and never offered", async () => {
  const result = await detectAccounts({ ...base, env: { OPENAI_API_KEY: "SYNTHETIC" }, readFile: files({ "/h/.codex/auth.json": '{"auth_mode":"chatgpt"}' }) });
  expect(result.agents.find((a) => a.provider === "codex")).toMatchObject({ likely: "unknown", keyOverridesLogin: "unknown" });
  expect(result.recommended).not.toContain("codex");
  expect(() => parseAccounts({ useSubscription: ["codex"] }, result)).toThrow();
});

test("the claude status command runs without the key and its JSON decides the login", async () => {
  let seenEnv: Record<string, string | undefined> | undefined;
  const result = await detectAccounts({ ...base, which: (b) => b === "claude" ? "/bin/claude" : null, env: { ANTHROPIC_API_KEY: "SYNTHETIC", PATH: "/bin" }, readFile: files({}),
    runCommand: async (_argv, options) => { seenEnv = options?.env; return out('{"loggedIn":true,"authMethod":"claude.ai","email":"someone@example.test"}'); } });
  expect(seenEnv?.ANTHROPIC_API_KEY).toBeUndefined();
  expect(result.agents.find((a) => a.provider === "claude")).toMatchObject({ login: "found", loginSource: "claude auth status", keyOverridesLogin: true });
  expect(JSON.stringify(result)).not.toContain("someone@example.test");
});

test("macOS Claude without a working status command is unknown, not a guess", async () => {
  const result = await detectAccounts({ ...base, platform: "darwin", env: {}, readFile: files({}) });
  expect(result.agents.find((a) => a.provider === "claude")).toMatchObject({ login: "unknown" });
});

test("cloud keys report presence per preset", async () => {
  const result = await detectAccounts({ ...base, env: { CEREBRAS_API_KEY: "SYNTHETIC" }, readFile: files({}) });
  expect(result.cloudKeys.cerebras).toBe("found");
  expect(result.cloudKeys.xai).toBe("not found");
  expect(result.cloudKeys["openai-compatible"]).toBeUndefined();
});

test("Use my subscription is accepted only where a key overrides a found login", async () => {
  const detected = await detectAccounts({ ...base, env: { ANTHROPIC_API_KEY: "SYNTHETIC" }, readFile: files({ "/h/.claude/.credentials.json": "{}" }) });
  expect(parseAccounts({ useSubscription: ["claude"] }, detected)).toEqual({ useSubscription: ["claude"] });
  expect(() => parseAccounts({ useSubscription: ["grok"] }, detected)).toThrow();
  expect(() => parseAccounts({ useSubscription: ["gemini"] }, detected)).toThrow();
  expect(unsetEnvFor("claude-code", { useSubscription: ["claude"] })).toEqual(["ANTHROPIC_API_KEY"]);
  expect(unsetEnvFor("codex", { useSubscription: ["claude"] })).toEqual([]);
  expect(unsetEnvFor("claude-code", undefined)).toEqual([]);
});

test("Accounts is the third step and contributes nothing itself", async () => {
  expect(SETUP_STEPS.map((s) => s.id).slice(0, 3)).toEqual(["privacy", "system", "accounts"]);
  const session = new SetupSession(fixtureSystem("cuda24"));
  const before = JSON.stringify(session.draft);
  await session.choose("accounts", { useSubscription: [] }, { probe: false });
  expect(JSON.stringify(session.draft)).toBe(before);
});

test("Codex billing is subscription only for a known ChatGPT login; a malformed or unknown auth mode stays unknown", async () => {
  const codex = async (auth: string | null, status = "") => (await detectAccounts({ ...base, env: {}, readFile: files(auth === null ? {} : { "/h/.codex/auth.json": auth }),
    which: (b: string) => b === "codex" ? "/usr/bin/codex" : null,
    runCommand: (async () => ({ command: [], exitCode: 0, durationMs: 1, stdout: { text: status, receivedBytes: status.length, capturedBytes: status.length, limitBytes: 8192, truncated: false }, stderr: { text: "", receivedBytes: 0, capturedBytes: 0, limitBytes: 1024, truncated: false }, combined: { receivedBytes: status.length, capturedBytes: status.length, limitBytes: 9216, truncated: false } })) as never,
  })).agents.find((a) => a.provider === "codex")!;
  expect((await codex('{"auth_mode":"chatgpt"}')).likely).toBe("subscription");
  expect((await codex('{"auth_mode":"apikey"}')).likely).toBe("per-token key");
  expect((await codex("{not json")).likely).toBe("unknown");
  expect((await codex('{"auth_mode":"something-new"}')).likely).toBe("unknown");
  expect((await codex(null, "Logged in using ChatGPT\n")).likely).toBe("subscription");
  expect((await codex(null, "Logged in using an API key - sk-***\n")).likely).toBe("per-token key");
  expect((await codex(null, "Logged in\n")).likely).toBe("unknown");
});

test("a Codex keyring login reported on stderr is found (codex-cli 0.159 prints its status there)", async () => {
  const status = "Logged in using ChatGPT\n";
  const result = await detectAccounts({ ...base, env: {}, readFile: files({}), which: (b: string) => b === "codex" ? "/usr/bin/codex" : null,
    runCommand: (async () => ({ command: [], exitCode: 0, durationMs: 1, stdout: { text: "", receivedBytes: 0, capturedBytes: 0, limitBytes: 8192, truncated: false }, stderr: { text: status, receivedBytes: status.length, capturedBytes: status.length, limitBytes: 1024, truncated: false }, combined: { receivedBytes: status.length, capturedBytes: status.length, limitBytes: 9216, truncated: false } })) as never });
  const codex = result.agents.find((a) => a.provider === "codex")!;
  expect(codex).toMatchObject({ login: "found", loginSource: "codex login status", likely: "subscription" });
});
