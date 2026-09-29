# Setup v2 part 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stranger, or their AI agent, gets from clone to a first spoken reply on one documented path. The wizard sizes models to their hardware, respects a declared privacy policy, shows which account pays, and tests the running engines.

**Architecture:** The step contract in `src/setup/steps.ts` stays the single source of truth. The choice → draft → check → write pipeline moves out of the HTTP handler into `src/setup/session.ts`, so the page, `cicero setup --plan/--apply/--test --json` and the docs tests share one code path. New pure modules: `fit.ts` (budget and fit rules), `accounts.ts` (read-only login detection), `privacy.ts` (policy gating and doctor warnings), `helper.ts` (runtime model listing) and `probes.ts` (Test). The brain factory wraps any primary in `RoutingBrain` when `brain.escalate` is set.

**Tech Stack:** Bun 1.4.2, TypeScript, `bun:test`, VitePress 1.6 plus a Mermaid plugin (chosen in Task 1), vanilla JS setup page (`src/setup/page.ts`).

**Spec:** `docs/superpowers/specs/2026-09-29-setup-wizard-v2-basics-design.md` (rev 10). It builds on `docs/superpowers/specs/2026-09-24-setup-wizard-design.md`; the new spec wins where they differ. Issue: #143.

## Global Constraints

- Scope: Linux + NVIDIA (`local-cuda`) and Apple Silicon (`local-mlx`). CPU-only and Windows keep today's behavior, apart from the platform-neutral Privacy and Accounts steps.
- `privacy: { mode: "local" | "cloud", allow?: ("agent" | "telegram" | "board")[] }`. `mode` is required when `privacy` is present, unknown values are errors, and no `privacy` key means no privacy warnings.
- Speech reservation: 3.5 GB for audio.cpp Nemotron + Pocket (measured), 2 GB for the Python presets (estimate), 2 GB on Apple Silicon (estimate). Headroom is 1.5 GB (CUDA only). Mac budget is 60% of unified memory minus speech.
- Footprints (llama.cpp, 64k context, q8 KV): E2B 2.5 (estimate), E4B 4.0 (measured), 12B 8.5 (estimate), 26B-A4B 15 (measured), 31B 20 (estimate) GB.
- Helper: E4B if it fits, else E2B. Front desk: the largest model **larger than the helper** that fits in budget − helper, else reuse the helper's instance. Never load a second copy of the same model.
- The helper is local-only in part 1. Cicero does not own or install the helper runtime.
- An explicit `llm` of `backend: openai` is always written, pointing at the helper, or with no helper at the cloud front desk's preset.
- New presets: `cerebras` → `https://api.cerebras.ai/v1`, `CEREBRAS_API_KEY`; `xai` → `https://api.x.ai/v1`, `XAI_API_KEY`.
- Credentials are only ever reported as "found" or "not found". Never read or print a key's value.
- Anything the spec marks "verified during implementation" is checked live in Task 1. If it can't be verified, the UI and JSON show "unknown"/"unverified". Never guess.
- Test starts and stops nothing. Every probe has a timeout and can be cancelled. An engine that isn't running is reported as "not running" with its start command. Results are cleared when the draft changes.
- The v1 write rules stand: write only when no config exists, and back up an invalid config only on explicit request.
- Repo gates: `bun run typecheck`, the full `bun test` (never piped), `git diff --check`, `bun run docs:build`.
- Never `bun link` from a scratch clone: it repoints `~/.bun/bin/cicero` and breaks every cron notify on this box. Docs and `INSTALL.md` use `bun run src/index.ts …`.
- No Claude attribution in commits, the PR or code.

## Step order (the contract every task uses)

| # | id | Title | Takes a choice | Notes |
|---|---|---|---|---|
| 1 | `privacy` | Privacy | yes | new |
| 2 | `system` | Machine | yes (tier) | was "System"; gains the budget |
| 3 | `accounts` | Accounts | yes | new |
| 4 | `frontdesk` | Front desk | yes | new; replaces `provider` |
| 5 | `helper` | Helper | yes | new; replaces `router` |
| 6 | `stt` | Hear | yes | retitled |
| 7 | `tts` | Speak | yes | retitled; Play sample |
| 8 | `brain` | Agent | yes | retitled; brain or brain.escalate |
| 9 | `board` | Tasks | yes | retitled; board allowance |
| 10 | `test` | Test | no | new |
| — | `channels` | Channels | preview | unchanged, unavailable |
| — | `install` | Install | preview | unchanged, unavailable |
| 11 | `check` | Check | no | v1, unchanged |
| 12 | `write` | Save | no | v1 Write, retitled to the spec's "Save" |
| 13 | `handoff` | Hand-off | no | v1, unchanged |

The spec numbers eleven steps and ends with "Save". Check and Hand-off stay as v1 defined them, because the spec keeps the v1 rules and names them (`src/setup/steps.ts:51`). `provider` and `router` are removed as steps. `probeRemoteProviderModels` and `/api/provider-models` stay, because the cloud front desk reuses "Load models".

The ordered list of available, non-preview titles (the docs test contract) is: Privacy, Machine, Accounts, Front desk, Helper, Hear, Speak, Agent, Tasks, Test, Check, Save, Hand-off.

The steps that take a choice, and so must appear in an answers file, are: `privacy`, `system`, `accounts`, `frontdesk`, `helper`, `stt`, `tts`, `brain`, `board`.

## Review Focus

1. **Budget drift after Hear/Speak change.** Front desk and Helper are sized before Hear/Speak are chosen. If the user then picks a heavier speech stack, the stored picks may no longer fit. Expected: the Machine bar and a draft warning say so. Nothing is silently changed. Test in Task 5.
2. **Privacy flip after later steps.** The user picks a cloud agent in cloud mode, then goes back and switches Privacy to local. Expected: the stored agent, board or cloud front desk choice is invalidated (removed from `choices`, with a visible reason), not written to a local-mode config. Test in Task 3.
3. **`--apply` against a changed machine.** An answers file names a helper model that is no longer listed, or an engine that went away. Expected: a non-zero exit with the parser's own message. No partial config is written. Test in Task 11.
4. **Credential values leaking through plan/doctor JSON.** `ANTHROPIC_API_KEY=sk-…` in the environment. Expected: JSON shows `"found"` only, and the synthetic key string appears nowhere in stdout. Test in Tasks 4, 11 and 12.
5. **Existing config at apply time.** `~/.cicero/config.yaml` is valid. Expected: apply exits non-zero with the v1 "already exists" message and leaves the file byte-identical. An invalid config is only backed up with `--backup-invalid`. Test in Task 11.

---
### Task 1: Verify the spec's "verified during implementation" facts

This task writes no production code. It produces `docs/superpowers/plans/2026-09-29-setup-v2-verification.md`, a record that later tasks read. Each row gives the command, the raw result, and the verdict: verified, unverified or unknown.

**Files:**
- Create: `docs/superpowers/plans/2026-09-29-setup-v2-verification.md`

**Produces:** the constants later tasks hard-code (status commands, ACP adapter list, model tags and the Mermaid plugin), each marked verified, or else rendered as "unknown".

- [ ] **Step 1: Agent login status commands.** Run each command and record the exit code and output shape, never the credential values:

```bash
claude --help | grep -iE 'auth|login|status'; claude auth status 2>&1 | head -5; echo rc=$?
codex login status 2>&1 | head -3; echo rc=$?
grok --help 2>&1 | grep -iE 'auth|login|status|acp'; ls ~/.grok/ 2>&1
jq -r '.auth_mode // "absent"' ~/.codex/auth.json 2>/dev/null
grep -n 'cli_auth_credentials_store\|keyring' ~/.codex/config.toml 2>/dev/null
```

Known caveat (from box memory): `codex login status` returns rc=0 "logged in" even when the refresh token is dead. Record this. The Accounts step then labels Codex "login found (not validated)", never "working".

- [ ] **Step 2: Key-over-login precedence.** Claude's `ANTHROPIC_API_KEY` beats the login (`src/brain/claude-code.ts:19`), and Grok's `XAI_API_KEY` wins per `~/.grok/README.md`. For Codex, check whether `OPENAI_API_KEY` overrides a ChatGPT login in the installed CLI: grep its `--help` and bundled docs, then run `OPENAI_API_KEY=invalid-synthetic codex login status`. If this is not provable, Codex's "most likely credential" is `unknown`.

- [ ] **Step 3: ACP adapters for escalation.** For each candidate, check that the package exists and responds to `--help` without starting a session:

```bash
curl -s https://registry.npmjs.org/@zed-industries/codex-acp | jq -r '."dist-tags".latest'
curl -s https://registry.npmjs.org/@zed-industries/claude-code-acp | jq -r '."dist-tags".latest, .deprecated // "not deprecated"'
curl -s https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp | jq -r '."dist-tags".latest'
grok --help 2>&1 | grep -i acp
which hermes bunx
```

Only adapters with a published, non-deprecated package or a native `acp` subcommand go on the list, pinned to the version recorded here. Grok is listed only if `grok` has a verified ACP mode; otherwise it is left off, and the verification doc says why.

- [ ] **Step 4: Ollama and LM Studio Gemma 4 tags.** Check that each tag resolves:

```bash
for t in e2b e4b 12b 26b 31b; do curl -s -o /dev/null -w "gemma4:$t %{http_code}\n" https://ollama.com/library/gemma4:$t; done
curl -s 'https://huggingface.co/api/models?search=gemma-4&author=lmstudio-community' | jq -r '.[].id'
for r in E2B E4B 12B 26B-A4B 31B; do curl -s -o /dev/null -w "google/gemma-4-$r-it-qat-q4_0-gguf %{http_code}\n" https://huggingface.co/api/models/google/gemma-4-$r-it-qat-q4_0-gguf; done
```

Any tag without a 200 is recorded as `null`. The Helper step then offers that model on that runtime only if it is already listed by the running runtime.

- [ ] **Step 5: Mermaid plugin.** Try `vitepress-plugin-mermaid` with `mermaid` in a throwaway branch of the worktree. Wrap the config with `withMermaid(defineConfig(...))`, run `bun run docs:build`, and grep the built README page for `class="mermaid"`. Record the versions that build. If it fails, try a markdown-it fence renderer that emits `<pre class="mermaid">` plus a client-side `mermaid` import in `docs/.vitepress/theme/index.ts`, and record which one worked.

- [ ] **Step 6: GPU process attribution.** Run `nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits` and `ss -ltnpH 'sport = :8092'` (and :8080), and confirm the PIDs match. Record whether `ss` shows PIDs without root. If it doesn't, PID matching is "unavailable" and memory shows as "other GPU use".

- [ ] **Step 7: Commit.** `git add` the verification doc; commit "docs: record setup v2 implementation-time verification".

---

### Task 2: Config surface: `privacy` key and the `cerebras`/`xai` presets

**Files:**
- Modify: `src/types.ts` (add `privacy` to `CiceroConfig`)
- Modify: `src/config-validation.ts:318` (allowlist + validation block)
- Modify: `src/backends/llm/openai.ts:22` (two presets)
- Test: `tests/config.test.ts` (privacy), `tests/brain-openai-compatible.test.ts` (presets)

**Produces:** `PrivacyConfig = { mode: "local" | "cloud"; allow?: ("agent" | "telegram" | "board")[] }` exported from `src/types.ts`, and `PRIVACY_ALLOWANCES` exported from `src/config-validation.ts`.

- [ ] **Step 1: Write failing tests**

```ts
// tests/config.test.ts
import { validateRuntimeConfig } from "../src/config-validation";
describe("privacy key", () => {
  const base = { brain: { backend: "claude-code", mode: "subprocess" } };
  test("accepts local and cloud with known allowances", () => {
    expect(() => validateRuntimeConfig({ ...base, privacy: { mode: "local" } })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...base, privacy: { mode: "cloud", allow: ["telegram", "board"] } })).not.toThrow();
  });
  test("requires mode and rejects unknown values", () => {
    expect(() => validateRuntimeConfig({ ...base, privacy: {} })).toThrow(/privacy.mode/);
    expect(() => validateRuntimeConfig({ ...base, privacy: { mode: "hybrid" } })).toThrow(/privacy.mode/);
    expect(() => validateRuntimeConfig({ ...base, privacy: { mode: "local", allow: ["email"] } })).toThrow(/privacy.allow/);
    expect(() => validateRuntimeConfig({ ...base, privacy: { mode: "local", extra: 1 } })).toThrow(/privacy/);
  });
});
```

```ts
// tests/brain-openai-compatible.test.ts
import { OPENAI_COMPATIBLE_BACKENDS, resolveOpenAiTarget } from "../src/backends/llm/openai";
test("cerebras and xai are OpenAI-compatible presets", () => {
  expect(OPENAI_COMPATIBLE_BACKENDS).toEqual(expect.arrayContaining(["cerebras", "xai"]));
  expect(resolveOpenAiTarget({ backend: "cerebras" })).toEqual({ baseUrl: "https://api.cerebras.ai/v1", apiKeyEnv: "CEREBRAS_API_KEY" });
  expect(resolveOpenAiTarget({ backend: "xai" })).toEqual({ baseUrl: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY" });
});
```

- [ ] **Step 2: Run them to see the failure:** `bun test tests/config.test.ts tests/brain-openai-compatible.test.ts`. Expected: FAIL, with "privacy is not a known key" and a missing preset.

- [ ] **Step 3: Implement.** In `openai.ts` `PRESETS`, add:

```ts
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", apiKeyEnv: "CEREBRAS_API_KEY" },
  xai: { baseUrl: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY" },
```

In `config-validation.ts`, add `"privacy"` to the top-level `checkKnownKeys` list, add a module-scope `export const PRIVACY_ALLOWANCES = ["agent", "telegram", "board"] as const;`, and after the switchboard block add:

```ts
  if (config.privacy !== undefined && checkRecord(config.privacy, "privacy", issues)) {
    checkKnownKeys(config.privacy, "privacy", ["mode", "allow"], issues);
    if (config.privacy.mode !== "local" && config.privacy.mode !== "cloud") issues.push("privacy.mode must be local or cloud");
    const allow = config.privacy.allow;
    if (allow !== undefined && (!Array.isArray(allow) || allow.some((item) => !(PRIVACY_ALLOWANCES as readonly unknown[]).includes(item))))
      issues.push(`privacy.allow must be a list of ${PRIVACY_ALLOWANCES.join(", ")}`);
  }
```

In `src/types.ts`, add `privacy?: PrivacyConfig;` to `CiceroConfig` and export the interface.

- [ ] **Step 4: Run the tests again.** Expected: PASS. Also run `bun test tests/config*.test.ts tests/brain-factory.test.ts` to check that the preset list change breaks nothing (the brain backend enum reads `OPENAI_COMPATIBLE_BACKENDS`, `config-validation.ts:782`).

- [ ] **Step 5: Commit** "config: add privacy policy key and cerebras/xai presets".

---

### Task 3: Extract the setup session and add the Privacy step

The choice pipeline in `src/setup/server.ts:254-312` moves into `src/setup/session.ts` unchanged. Then `StepContext` gains `choices`, and Privacy is added as step 1 together with the gating helper every later step uses.

**Files:**
- Create: `src/setup/session.ts`, `src/setup/privacy.ts`, `tests/setup/fixtures.ts`
- Modify: `src/setup/steps.ts` (`StepContext.choices`, `recommend`, `privacy` step, retitles, remove `provider`/`router`)
- Modify: `src/setup/server.ts` (delegate to the session)
- Modify: `src/setup/draft.ts` (`EXPLANATIONS` for `privacy`, `privacy.mode`, `privacy.allow`)
- Modify: `src/setup/page.ts` (Privacy renderer)
- Test: `tests/setup/session.test.ts`, `tests/setup/privacy.test.ts`; update `tests/setup/server.test.ts` and `tests/setup/pickers.test.ts` for removed steps

**Interfaces (produced):**

```ts
// steps.ts
export interface StepContext { system: SystemFacts; draft: SetupDraft; detected?: unknown; choices: ReadonlyMap<string, unknown> }
export interface SetupStep<Choice = unknown> {
  // …existing fields…
  /** Deterministic default choice for --plan. Absent on steps with no choice. */
  recommend?(detected: unknown, context: StepContext): { choice: unknown; reason: string };
}
export const CHOICE_STEP_IDS: readonly string[]; // ids of available steps that define recommend

// privacy.ts
export type PrivacyMode = "local" | "cloud";
export type Allowance = "agent" | "telegram" | "board";
export interface PrivacyChoice { mode: PrivacyMode; allow: Allowance[] }
export function parsePrivacy(raw: unknown): PrivacyChoice;
export function privacyOf(ctx: { draft: SetupDraft }): PrivacyChoice | null;
export function withAllowance(ctx: { draft: SetupDraft }, item: Allowance): { privacy: PrivacyChoice } | Record<string, never>;
export const PRIVACY_COPY: Record<Allowance, string>; // the plain sentence of what leaves

// session.ts
export interface ChoiceResult { accepted: boolean; probe?: { ok: boolean; message: string }; invalidated: { id: string; reason: string }[] }
export class SetupSession {
  constructor(system: SystemFacts, token?: string);
  readonly system: SystemFacts;
  draft: SetupDraft; revision: number;
  choices: Map<string, unknown>;
  context(detected?: unknown): StepContext;
  detect(stepId: string, deps?: PickerDeps): Promise<unknown>;
  choose(stepId: string, raw: unknown, opts: { deps?: PickerDeps; detected?: unknown; probe: boolean }): Promise<ChoiceResult>;
  check(run?: typeof checkDraft, options?: DoctorCheckOptions): Promise<Check[]>; // stores checks + revision; stale if revision moved
  writeGate(acknowledgeNotReady: boolean): { ok: true } | { ok: false; error: string };
}
```

`choose` behaves exactly like today's handler: it carries saved secrets and `companyId` forward, runs `probeChoice` when `probe` is true, rejects on `probe.ok === false`, and rebuilds the draft in `SETUP_STEPS` order. New: during the rebuild, each stored choice is re-parsed against the fresh context in step order. A choice that no longer parses is removed and reported in `invalidated` (Review Focus 2). `writeGate` returns the exact strings the handler returns today ("Run Check again before writing", "Resolve config validity failures before writing", "Acknowledge that runtime components are not ready yet before writing").

- [ ] **Step 1: Pin today's behavior before moving it.** Run `bun test tests/setup` and record that it passes. The existing server tests are the regression net for the extraction.

- [ ] **Step 2: Write failing tests**

```ts
// tests/setup/fixtures.ts — deterministic SystemFacts
export function fixtureSystem(kind: "cuda24" | "cuda16" | "mac32" | "mac64" | "cpu"): SystemFacts { /* literal facts per kind; gpu.totalMiB 24576 / 16384; ramTotalBytes 32/64 GiB for macs */ }
```

```ts
// tests/setup/session.test.ts
import { SetupSession } from "../../src/setup/session";
import { fixtureSystem } from "./fixtures";
test("a later privacy flip invalidates a stored cloud agent", async () => {
  const s = new SetupSession(fixtureSystem("cuda24"));
  await s.choose("privacy", { mode: "cloud" }, { probe: false });
  await s.choose("frontdesk", { kind: "agent" }, { probe: false });
  await s.choose("brain", { id: "claude-code" }, { probe: false });
  const r = await s.choose("privacy", { mode: "local" }, { probe: false });
  expect(r.invalidated.map((i) => i.id)).toContain("brain");
  expect(s.choices.has("brain")).toBe(false);
  expect(s.draft.brain.backend).toBeUndefined();
});
test("revision bumps and the write gate needs a fresh Check", async () => {
  const s = new SetupSession(fixtureSystem("cuda24"));
  const before = s.revision;
  await s.choose("privacy", { mode: "local" }, { probe: false });
  expect(s.revision).toBe(before + 1);
  expect(s.writeGate(false)).toEqual({ ok: false, error: "Run Check again before writing" });
});
```

(The first test goes green only after Tasks 6 and 8 add `frontdesk` and the privacy-aware `brain`. Write it now with `test.todo` and flip it in Task 8.)

```ts
// tests/setup/privacy.test.ts
import { parsePrivacy, withAllowance } from "../../src/setup/privacy";
test("parsePrivacy defaults allow to [] and rejects unknowns", () => {
  expect(parsePrivacy({ mode: "local" })).toEqual({ mode: "local", allow: [] });
  expect(() => parsePrivacy({ mode: "public" })).toThrow();
  expect(() => parsePrivacy({ mode: "cloud", allow: ["email"] })).toThrow();
});
test("withAllowance unions without duplicates", () => {
  const draft = { privacy: { mode: "local", allow: ["board"] } } as never;
  expect(withAllowance({ draft }, "agent")).toEqual({ privacy: { mode: "local", allow: ["board", "agent"] } });
  expect(withAllowance({ draft }, "board")).toEqual({ privacy: { mode: "local", allow: ["board"] } });
});
```

- [ ] **Step 3: Run the tests to see them fail.** `bun test tests/setup/session.test.ts tests/setup/privacy.test.ts`: the modules are missing.

- [ ] **Step 4: Implement `privacy.ts`, `session.ts` and the Privacy step.** The Privacy step:

```ts
{ id: "privacy", title: "Privacy", available: true, pipeline: "mic",
  explain: info("What may leave this machine?", "Nothing leaves unless you allow it, one item at a time. This is a declared policy the wizard and doctor enforce, not a firewall: doctor cannot see what a CLI agent does on the network.", "Your answer goes into privacy.", "docs/using.md#privacy"),
  async detect() { return { options: ["local", "cloud"], recommended: "local", copy: PRIVACY_COPY }; },
  recommend() { return { choice: { mode: "local" }, reason: "Nothing leaves unless you allow it." }; },
  parseChoice: (raw) => parsePrivacy(raw),
  contribute: (_ctx, c) => ({ privacy: c.allow.length ? c : { mode: c.mode } }) }
```

Retitle `system` → "Machine", `stt` → "Hear", `tts` → "Speak", `brain` → "Agent", `board` → "Tasks" and `write` → "Save". Remove the `provider` and `router` entries from `SETUP_STEPS`; their picker functions are replaced in Tasks 6 and 7. `server.ts` keeps HTTP, auth, the view and redaction, and calls `session.detect/choose/check/writeGate`. The view adds `invalidated`, so the page can show "Agent was cleared: Privacy is now local".

- [ ] **Step 5: Page.** Add `renderPrivacy(step)`: two radio cards with the spec's copy, plus the per-item sentences from `PRIVACY_COPY` shown under "Nothing, unless I allow it". Route `id === 'privacy'` to it in `render()`. Render `state.invalidated` as a dismissible warning panel at the top of any step.

- [ ] **Step 6: Run the tests.** `bun test tests/setup`. Expected: PASS apart from the `todo`. Existing server tests that posted `provider`/`router` choices now post `privacy`/`stt`.

- [ ] **Step 7: Commit** "setup: extract session pipeline, add Privacy step and invalidation".

---

### Task 4: Accounts step (read-only login detection)

**Files:**
- Create: `src/setup/accounts.ts`
- Modify: `src/setup/pickers.ts` (`PickerDeps` gains `homeDir?: () => string`, `readFile?: (path: string) => string | null`, `platform?: string`)
- Modify: `src/setup/steps.ts` (add `accounts` after `system`), `src/setup/page.ts` (`renderAccounts`), `src/setup/draft.ts` (`EXPLANATIONS["brain.unset_env"]`, `["brain.escalate.unset_env"]`)
- Test: `tests/setup/accounts.test.ts`

**Interfaces (produced):**

```ts
export type AgentProvider = "claude" | "codex" | "grok";
export interface AccountStatus {
  provider: AgentProvider;
  login: "found" | "not found" | "unknown";   // never a value
  loginSource: string | null;                   // e.g. "$CLAUDE_CONFIG_DIR/.credentials.json", "macOS Keychain (unverified)"
  key: "found" | "not found";                   // presence of the env var only
  keyVariable: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "XAI_API_KEY";
  likely: "subscription" | "per-token key" | "unknown";
  keyOverridesLogin: boolean | "unknown";
}
export interface AccountsDetected { agents: AccountStatus[]; cloudKeys: Record<string, "found" | "not found"> } // preset id → its apiKeyEnv presence
export function detectAccounts(deps: PickerDeps): Promise<AccountsDetected>;
export interface AccountsChoice { useSubscription: AgentProvider[] }
export function parseAccounts(raw: unknown, detected: AccountsDetected | undefined): AccountsChoice;
/** The env var to strip for an agent backend, or [] when the user did not ask. */
export function unsetEnvFor(backendOrAcpCommand: string, choice: AccountsChoice | undefined): string[];
```

Location rules from the spec table: Claude uses `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json` on Linux, and on macOS the Keychain is `unknown` unless Task 1 verified `claude auth status`. Codex uses `$CODEX_HOME/auth.json` or `~/.codex/auth.json` and reads only `auth_mode`. Grok uses `~/.grok/auth.json`. When Task 1 verified a status command for a provider, run it through `runBoundedCommand` with a 1.5 s deadline and output caps, and trust only its exit code and a fixed pattern. `cloudKeys` covers every `OPENAI_COMPATIBLE_BACKENDS` preset except `openai-compatible`, and reports only whether the preset's `apiKeyEnv` is present. It is empty-safe.

`useSubscription` may only name providers where `keyOverridesLogin === true` and `login === "found"`. The Agent step (Task 8) reads `ctx.choices.get("accounts")` and writes `unset_env: [keyVariable]` on the chosen agent, which is `brain` or `brain.escalate`. The Accounts step itself contributes nothing.

- [ ] **Step 1: Write failing tests** with a fixture home and env. The cases: login only; key only; key overrides login; `CLAUDE_CONFIG_DIR`/`CODEX_HOME` overrides; macOS Claude reports `unknown`; and the redaction test from Review Focus 4:

```ts
test("reports presence only; the key value never appears", async () => {
  const secret = "sk-ant-SYNTHETIC-TEST-MARKER-0000";
  const files: Record<string, string> = { "/h/.claude/.credentials.json": "{}" };
  const out = await detectAccounts({ homeDir: () => "/h", platform: "linux", env: { ANTHROPIC_API_KEY: secret }, readFile: (p) => files[p] ?? null, which: () => null });
  const claude = out.agents.find((a) => a.provider === "claude")!;
  expect(claude).toMatchObject({ login: "found", key: "found", likely: "per-token key", keyOverridesLogin: true });
  expect(JSON.stringify(out)).not.toContain(secret);
});
test("CODEX_HOME wins over ~/.codex and only auth_mode is read", async () => {
  const files = { "/alt/auth.json": JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "SYNTHETIC" } }) };
  const out = await detectAccounts({ homeDir: () => "/h", platform: "linux", env: { CODEX_HOME: "/alt" }, readFile: (p) => files[p as keyof typeof files] ?? null, which: () => null });
  expect(out.agents.find((a) => a.provider === "codex")).toMatchObject({ login: "found", loginSource: "$CODEX_HOME/auth.json", likely: "subscription" });
  expect(JSON.stringify(out)).not.toContain("SYNTHETIC");
});
test("useSubscription is rejected where no key overrides a login", async () => {
  expect(() => parseAccounts({ useSubscription: ["grok"] }, { agents: [{ provider: "grok", login: "not found", key: "found", keyOverridesLogin: true } as never], cloudKeys: {} })).toThrow();
});
```

- [ ] **Step 2: Run them to see them fail:** `bun test tests/setup/accounts.test.ts`.
- [ ] **Step 3: Implement** `accounts.ts` and the step (`recommend`: `useSubscription` = every provider with a key overriding a found login; reason "Keeps agents on your subscription instead of per-token billing"). Accounts parse errors never echo file contents.
- [ ] **Step 4: Page** `renderAccounts`: one row per agent (login / key / likely billing). A "Use my subscription" checkbox shows only where the key overrides a login, with the note "falls back to your login". The cloud key list shows found / not found.
- [ ] **Step 5: Run** `bun test tests/setup`. Expected: PASS.
- [ ] **Step 6: Commit** "setup: Accounts step with read-only login and key detection".

---
### Task 5: Model budget and fit rules; Machine step shows the budget

**Files:**
- Create: `src/setup/fit.ts`
- Modify: `src/setup/steps.ts` (`system.detect` returns `{ ...system, budget }`), `src/setup/server.ts` view (adds `budget` and `fitWarnings` computed from the current draft), `src/setup/page.ts` (`renderSystem` budget bar)
- Test: `tests/setup/fit.test.ts`

**Interfaces (produced):**

```ts
export type GemmaId = "e2b" | "e4b" | "12b" | "26b-a4b" | "31b";
export interface GemmaModel { id: GemmaId; label: string; footprintGb: number; basis: "measured" | "estimate"; hfRepo: string; ollamaTag: string | null; lmStudioId: string | null }
export const GEMMA_MODELS: readonly GemmaModel[]; // ascending footprint; tags from Task 1 (null = unverified)
export type SpeechKind = "audiocpp" | "python" | "mlx";
export function speechKind(tier: Tier, stt?: string, tts?: string): SpeechKind; // audiocpp only when BOTH seats are audiocpp
export function speechReservationGb(kind: SpeechKind): { gb: number; basis: "measured" | "estimate" }; // 3.5 measured / 2 estimate / 2 estimate
export interface Budget { platform: "cuda" | "mlx" | "other"; totalGb: number; speech: { gb: number; basis: string; kind: SpeechKind }; headroomGb: number; budgetGb: number; inUseByOthersGb: number | null }
export function modelBudget(system: SystemFacts, kind: SpeechKind): Budget | null; // null on CPU/Windows (out of scope)
export interface FitPlan { helper: GemmaModel | null; frontDesk: GemmaModel | null; frontDeskReusesHelper: boolean; reason: string; localHelperImpossible: boolean }
export function planFit(budgetGb: number, mode: PrivacyMode): FitPlan;
export function fitWarnings(budget: Budget, helper: GemmaModel | null, frontDesk: GemmaModel | null, frontDeskReusesHelper: boolean): string[];
```

Budget math, from the spec: CUDA = `gpu.totalMiB/1024 − speech − 1.5`. MLX = `0.6 × ramTotalBytes/2^30 − speech`, with no headroom. `inUseByOthersGb` = `(totalMiB − freeMiB)/1024` on CUDA, shown next to the budget and never subtracted. Before Hear/Speak are chosen, the Machine step uses the kind it would recommend (`audiocpp` when Task 9's detection says audio.cpp is ready, else `python`/`mlx`). Afterwards the view recomputes from `draft.stt.backend`/`draft.tts.backend`.

- [ ] **Step 1: Write failing tests**, table-driven over the spec's four worked examples plus the boundaries:

```ts
import { modelBudget, planFit, fitWarnings, GEMMA_MODELS } from "../../src/setup/fit";
import { fixtureSystem } from "./fixtures";
const byId = (id: string) => GEMMA_MODELS.find((m) => m.id === id)!;
test.each([
  ["cuda24", "audiocpp", 19, "e4b", "26b-a4b", false],
  ["cuda16", "audiocpp", 11, "e4b", "e4b", true],
  ["mac32", "mlx", 17.2, "e4b", "12b", false],
  ["mac64", "mlx", 36.4, "e4b", "31b", false],
] as const)("%s worked example", (kind, speech, budget, helper, front, reuse) => {
  const b = modelBudget(fixtureSystem(kind), speech)!;
  expect(b.budgetGb).toBeCloseTo(budget, 5);
  const plan = planFit(b.budgetGb, "local");
  expect(plan.helper?.id).toBe(helper);
  expect(plan.frontDesk?.id).toBe(front);
  expect(plan.frontDeskReusesHelper).toBe(reuse);
});
test("front desk fits exactly at the boundary (15 of 15 GB left)", () => {
  expect(planFit(19, "local").frontDesk?.id).toBe("26b-a4b");
  expect(planFit(18.99, "local").frontDesk?.id).toBe("12b");
});
test("E2B fallback when E4B does not fit; front desk must be larger than the helper", () => {
  const plan = planFit(3.9, "local");
  expect(plan.helper?.id).toBe("e2b");
  expect(plan.frontDeskReusesHelper).toBe(true); // 1.4 GB left: nothing larger than E2B fits
});
test("below E2B: local mode says it cannot run a helper; cloud mode runs without one", () => {
  expect(planFit(2.4, "local")).toMatchObject({ helper: null, localHelperImpossible: true });
  expect(planFit(2.4, "cloud")).toMatchObject({ helper: null, localHelperImpossible: false });
});
test("CPU and Windows get no budget (out of scope)", () => {
  expect(modelBudget(fixtureSystem("cpu"), "python")).toBeNull();
});
test("Review Focus 1: switching to a heavier speech stack surfaces a fit warning", () => {
  const light = modelBudget(fixtureSystem("cuda24"), "python")!; // 20.5
  const heavy = modelBudget(fixtureSystem("cuda24"), "audiocpp")!; // 19
  expect(fitWarnings(light, byId("e4b"), byId("26b-a4b"), false)).toEqual([]);
  heavy.budgetGb = 18; // another process claimed memory
  expect(fitWarnings(heavy, byId("e4b"), byId("26b-a4b"), false)[0]).toMatch(/no longer fit/);
});
```

- [ ] **Step 2: Run them to see them fail:** `bun test tests/setup/fit.test.ts`.
- [ ] **Step 3: Implement `fit.ts`.** Front desk selection: filter `GEMMA_MODELS` to `footprintGb > helper.footprintGb && footprintGb <= budget − helper.footprintGb`, then take the last. With none, reuse the helper. Compare with a `1e-9` epsilon so 15 ≤ 15 holds. In cloud mode with no helper, `frontDesk` is null: the cloud front desk is chosen in Task 6.
- [ ] **Step 4: Machine step + view.** `system.detect` returns `{ ...system, budget, fit }`. The server view gains `budget` and `fitWarnings`, computed from `session.draft` and the stored helper/front desk choices (Task 7 exposes `helperModelId`/`frontDeskModelId` on those choices). Page: the budget bar is a flex row with one segment per planned model (label, GB, and a "measured"/"estimate" tag), a speech segment, headroom, and an "other GPU use" note when `inUseByOthersGb > 0`. `gpuWarning` stays as today.
- [ ] **Step 5: Run** `bun test tests/setup`. Expected: PASS.
- [ ] **Step 6: Commit** "setup: hardware model budget and Gemma 4 fit rules".

---

### Task 6: Front desk step (replaces the LLM provider step)

**Files:**
- Create: `src/setup/runtimes.ts` (runtime + model listing shared by Front desk and Helper)
- Modify: `src/setup/pickers.ts` (remove `detectProvider/parseProvider/contributeProvider`; keep `probeRemoteProviderModels`, `fetchLimited`, `boundedResponse`)
- Modify: `src/setup/steps.ts` (`frontdesk` step), `src/setup/page.ts` (`renderFrontDesk`, reusing the "Load models" UI), `src/setup/server.ts` (`/api/provider-models` saves the key under `frontdesk`)
- Test: `tests/setup/frontdesk.test.ts`; delete the provider cases from `tests/setup/pickers.test.ts`

**Interfaces (produced):**

```ts
// runtimes.ts
export type RuntimeId = "llama-cpp" | "ollama" | "lm-studio";
export interface RuntimeListing { id: RuntimeId; running: boolean; baseUrl: string; models: string[]; singleModel: boolean; installed: boolean }
export const RUNTIME_ENDPOINTS: Record<RuntimeId, { health: string; list: string; baseUrl: string }>;
// llama-cpp: health http://127.0.0.1:8080/health, list /v1/models, baseUrl http://127.0.0.1:8080/v1
// ollama: list http://127.0.0.1:11434/api/tags, baseUrl http://127.0.0.1:11434/v1
// lm-studio: list http://127.0.0.1:1234/v1/models, baseUrl http://127.0.0.1:1234/v1
export function listRuntimes(deps: PickerDeps): Promise<Record<RuntimeId, RuntimeListing>>;
export function suggestListedModel(models: string[], target: GemmaModel): string | null; // case-insensitive "gemma" + "4" + id tokens, e.g. /gemma.?4.*e4b/i

// frontdesk choice
export type FrontDeskChoice =
  | { kind: "agent" }
  | { kind: "model"; runtime: RuntimeId; model: string }
  | { kind: "model"; runtime: "cloud"; preset: string; model: string };
```

Contributions (the spec's "writes `brain`"):
- `{ kind: "model", runtime: "ollama" }` → `brain: { backend: "ollama", mode: "subprocess", ollama_model: model }`
- `{ kind: "model", runtime: "llama-cpp" | "lm-studio" }` → `brain: { backend: "openai-compatible", mode: "subprocess", base_url: RUNTIME_ENDPOINTS[r].baseUrl, model }`
- `{ kind: "model", runtime: "cloud", preset }` → `brain: { backend: preset, mode: "subprocess", model }`. There is no `api_key`: the runtime reads the preset's env var (`resolveOpenAiTarget`).
- `{ kind: "agent" }` → nothing. The Agent step writes `brain` (Task 8).

Parse rules:
- In local mode, `runtime: "cloud"` is rejected with the reason "Privacy is local: the front desk must run on this machine".
- A cloud preset needs `detected.cloudKeys[preset] === "found"` (from Accounts via `ctx.choices`/detection), and the model must come from `/api/provider-models` (the existing `allowedModels` gate).
- A local runtime model must appear in that runtime's fresh listing, as `parseProvider` does today (`pickers.ts:155`).
- A single-model runtime: when the helper is chosen later on the same runtime, Task 7 enforces the same-model rule.
- An agent front desk is rejected when the stored helper is `none` ("A no-helper setup needs a model front desk", spec step 5).
- `mlx-lm` is not an option (spec step 4).

`recommend`: local mode → the fit plan's front desk on the first running runtime whose listing contains it (`suggestListedModel`). If none is listed, recommend `{ kind: "model", runtime: <first running>, model: <helper's listed model> }` (reuse), with the reason naming the pull command. With no runtime → `{ kind: "agent" }` is invalid without a helper, so `--plan` reports `blocked: "no local model runtime found"` and gives the install steps (Task 11 renders this). Cloud mode → the first preset with a found key, else the local plan.

- [ ] **Step 1: Write failing tests:** runtime listing via an injected `fetcher` (llama-swap listing two models; bare llama-server listing one → `singleModel: true`; Ollama `/api/tags`); a local-mode rejection of cloud; cloud mode accepts `xai` with a found key and writes no `api_key`; a model missing from the listing throws the parser message "Start the runtime, load a model, and Re-check before choosing it"; contributions for each runtime as listed above.
- [ ] **Step 2: Run to see them fail:** `bun test tests/setup/frontdesk.test.ts`.
- [ ] **Step 3: Implement** `runtimes.ts` by moving `fetchLimited` usage out of `detectProvider`, then add the step. `frontdesk` detection returns `{ runtimes, cloudPresets, cloudKeys, fit, mode, options, disabled, recommended, reason }`, where `disabled` maps an option to its reason (the page already renders `disabled`).
- [ ] **Step 4: Page** `renderFrontDesk`: "A model (fast, no tools; recommended)" vs "An agent (slower, can use tools)". Under "model": a runtime select, then that runtime's listed models (the recommended one badged, with footprint and "estimate"/"measured"), plus the settings note for Ollama/LM Studio ("set context 65536 and q8 KV cache; every fit is an estimate"). For llama-swap, a copyable model entry:

```yaml
models:
  gemma-4-e4b:
    cmd: llama-server --port ${PORT} -hf google/gemma-4-E4B-it-qat-q4_0-gguf -c 65536 -ctk q8_0 -ctv q8_0 -ngl 99
```

(the command is generated from `GEMMA_MODELS`; flags per llama.cpp `llama-server --help`, checked in Task 1 Step 5's session on this box). Cloud: reuse the existing preset select + "Load models".
- [ ] **Step 5: Run** `bun test tests/setup`. Expected: PASS.
- [ ] **Step 6: Commit** "setup: Front desk step writes brain from a local runtime, cloud preset or agent".

---

### Task 7: Helper step (absorbs Router)

**Files:**
- Create: `src/setup/helper.ts`
- Modify: `src/setup/pickers.ts` (delete `detectRouter/parseRouter/contributeRouter/probeRouter`; keep `LAYA_LANES_REQUIRED` for the Advanced note), `src/setup/steps.ts`, `src/setup/page.ts` (`renderHelper`), `src/setup/draft.ts` (EXPLANATIONS for `web_voice.tldr.summarizer_url`, `.summarizer_model`, `llm.*`, `brain.history_compaction.enabled`)
- Test: `tests/setup/helper.test.ts`

**Interfaces (produced):**

```ts
export type HelperChoice = { id: "none" } | { id: "model"; runtime: RuntimeId; model: string; gemma: GemmaId | null; compact: boolean };
export function parseHelper(raw: unknown, ctx: StepContext): HelperChoice;
export function contributeHelper(ctx: StepContext, c: HelperChoice): Record<string, unknown>;
export function probeHelper(c: HelperChoice, deps: PickerDeps): Promise<{ ok: boolean; message: string }>; // re-lists the runtime; ok only when the model is listed
```

Contribution (spec step 5, "Config it writes"):

```ts
// helper set:
{ web_voice: { tldr: { summarizer_url: base, summarizer_model: model } },
  llm: { backend: "openai", baseUrl: base, model },
  ...(compact ? { brain: { history_compaction: { enabled: true } } } : {}) }
// no helper (cloud mode + cloud model front desk only):
{ llm: { backend: "openai", baseUrl: resolveOpenAiTarget({ backend: preset }).baseUrl, model: frontDeskModel, apiKeyEnv: <preset env> } }
```

Before writing `apiKeyEnv` in the no-helper branch, check that `llm` accepts `apiKeyEnv` (`grep -n apiKeyEnv src/config-validation.ts`). If it doesn't, use `backend: <preset>` instead of `openai`, and state that deviation from the spec's literal `backend: openai` in the PR. The point of the explicit `llm` is to stop the tier preset adding its own model (`src/config.ts:1164`), and a preset backend does that too.

Parse rules:
- `none` is allowed only in cloud mode, and only when the stored front desk is `{ kind: "model", runtime: "cloud" }`. Otherwise it fails with "Local mode needs a local helper" or "A no-helper setup needs a model front desk".
- The runtime must be running and list the model.
- On a single-model runtime, when the front desk is a local model on the same runtime, the helper model must equal the front desk model (spec "Single-model runtimes"). The error names llama-swap or Ollama for running two.
- `compact` is a boolean. It is hidden and forced false with no helper.
- Call minutes are not offered (they need Telegram, which waits for Channels).
- Laya appears only as a disabled Advanced option with the reason "needs a checkpoint trained on your roster" + `LAYA_LANES_REQUIRED`. No office lanes exist in part 1, so it cannot be chosen.

`recommend`: the fit plan's helper on the first running runtime whose listing contains it. Otherwise it recommends that runtime's closest listed Gemma, with the reason naming the pull/download command for the fit model: `ollama pull <ollamaTag>` when verified, or the Hugging Face repo for llama-swap/LM Studio. In cloud mode with `localHelperImpossible` → `none`.

**CPU and Windows (out of fit scope).** `modelBudget` returns null there, so Front desk and Helper make no size-based pick. They recommend today's defaults instead: the first running runtime's listed model, or `qwen3.5:0.8b` on Ollama as in `TIER_PRESETS["local-cpu"]`. The model is labeled "not sized for this machine". Front desk and Helper each get a test for this.

- [ ] **Step 1: Write failing tests:** writes summarizer + explicit `llm` + optional compaction; `none` rejected in local mode; `none` rejected with an agent front desk; single-model runtime same-model rule; `probeHelper` fails when the model disappeared from the listing (Review Focus 3); no `switchboard` key is ever written; and a draft with the helper passes `loadConfig` via `checkDraft` (the real validation path) with no tier `llm` injected.

```ts
test("an explicit llm stops the CUDA tier from adding llama-server on :8080", async () => {
  const s = new SetupSession(fixtureSystem("cuda24"));
  // privacy local, front desk ollama gemma4:26b, helper ollama gemma4:e4b (listing injected)
  // …
  const config = loadDraftConfig(s.draft); // helper: renderDraft → temp home → loadConfig
  expect(config.raw.llm).toEqual({ backend: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e4b" });
});
```

- [ ] **Step 2: Run to see them fail:** `bun test tests/setup/helper.test.ts`.
- [ ] **Step 3: Implement** `helper.ts` + the step (`probeChoice: probeHelper`).
- [ ] **Step 4: Page** `renderHelper`: the runtime + model select, the badge and footprint, a "Compress long conversations" checkbox, and a collapsed "Advanced" section with the disabled Laya row. "Skipped" is shown when `none`, with the note that long replies end with "say details".
- [ ] **Step 5: Run** `bun test tests/setup`. Expected: PASS.
- [ ] **Step 6: Commit** "setup: Helper step writes summarizer, explicit llm and compaction".

---

### Task 8: Escalation for any front desk + privacy-aware Agent step

**Files:**
- Modify: `src/brain/index.ts:208-260` (move the `RoutingBrain` wrap out of the `acp` branch)
- Modify: `src/setup/pickers.ts` (`detectBrain/parseBrain/contributeBrain` → the Agent step), `src/setup/steps.ts`, `src/setup/page.ts`
- Test: `tests/brain-factory.test.ts` (escalation), `tests/setup/agent.test.ts`; flip the `test.todo` from Task 3

**Brain factory change.** Split `buildBrain` into `buildPrimary(...)` (today's body, minus escalation) and a wrapper:

```ts
function buildBrain(config, terminal, hooks): Brain {
  const primary = buildPrimary(config, terminal, hooks);            // acp returns the bare AcpBrain here; lanes stay in the acp branch below
  const esc = config.brain.escalate;
  const front = esc?.binary || esc?.binary_args ? new RoutingBrain(primary, buildEscalation(config, hooks), esc.triggers) : primary;
  return config.brain.backend === "acp" ? wrapLanes(config, front, hooks) : front;
}
```

`buildEscalation` is the existing `new AcpBrain({...esc...})` block verbatim. `wrapLanes` is the existing lanes/`SwitchboardBrain` block verbatim, returning `front` when there are no lanes. Existing ACP configs therefore keep: primary → RoutingBrain → SwitchboardBrain. Tab-inject is a primary like any other.

- [ ] **Step 1: Write failing factory tests**

```ts
test("brain.escalate wraps a model front desk", () => {
  const brain = createBrain(runtimeConfig({ brain: { backend: "ollama", mode: "subprocess", ollama_model: "gemma4:e4b", escalate: { binary: "bunx", binary_args: ["@zed-industries/codex-acp@<pinned>"] } } }));
  expect(brain).toBeInstanceOf(RoutingBrain);
});
test("existing ACP escalation + lanes layering is unchanged", () => {
  const brain = createBrain(runtimeConfig({ brain: { backend: "acp", binary: "hermes", binary_args: ["acp"], escalate: { binary: "hermes", binary_args: ["-p", "think", "acp"] }, lanes: { coder: { binary: "hermes", binary_args: ["-p", "coder", "acp"] } } } }));
  expect(brain.constructor.name).toBe("SwitchboardBrain");
  // and its front is a RoutingBrain (read via the existing test seam in tests/brain-factory.test.ts)
});
test("no escalate → bare primary", () => { /* openai-compatible → OpenAiCompatibleBrain */ });
```

(`runtimeConfig` is the existing helper in `tests/brain-factory.test.ts`. No process is spawned, because construction is lazy until `start()`.)

- [ ] **Step 2: Run to see them fail:** `bun test tests/brain-factory.test.ts`. Expected: the ollama case is not a RoutingBrain.
- [ ] **Step 3: Implement the refactor.** Run `bun test tests/brain*` and `bun test tests/brain` to confirm the existing ACP tests are unchanged.

- [ ] **Step 4: Agent step.** The detected shape adds:
  - `mode`: `frontdesk.kind === "agent"` means "brain", otherwise "escalate".
  - `acp`: `[{ id, label, command: string[], found: boolean, status: "unverified until first call" }]` for hermes (`["hermes","acp"]`), codex-acp (`["bunx", "<pinned pkg from Task 1>"]`), and the Claude adapter / Grok only if Task 1 verified them. `found` = `which(command[0])`.
  - `cloud`: `{ "claude-code": true, codex: true, gemini: true, qwen: true, <acp cloud adapters>: true, hermes: false }`. Hermes and local ACP harnesses are treated as local; the note says "whether it reaches the cloud depends on its model".

  Parse rules:
  - In escalate mode only the `acp` entries are accepted, plus `{ id: "none" }` (talk-only).
  - In brain mode, today's list plus ACP entries.
  - In local mode, a cloud agent needs `allowCloud: true` in the choice, or it fails with "Allow this agent to use the cloud first".

  Contribution:
  - brain mode → `brain: { backend, ...today, ...(unset.length ? { unset_env } : {}) }`
  - escalate mode → `brain: { escalate: { binary, binary_args, ...(unset.length ? { unset_env } : {}) } }`
  - `none` → `{}`

  `unset` = `unsetEnvFor(id, ctx.choices.get("accounts"))`. When `allowCloud`, also merge `withAllowance(ctx, "agent")`. Escalate mode always writes `binary` explicitly, never relying on the `"hermes"` fallback.
  `recommend`: `--agent <id>` from the CLI when given (Task 11). Otherwise escalate mode → `none`, and brain mode → the first installed, privacy-allowed CLI.

- [ ] **Step 5: Tests** (`tests/setup/agent.test.ts`): a model front desk writes `brain.escalate` and never overwrites `brain.backend`; local mode rejects `codex` without `allowCloud`; `allowCloud` adds `agent` to `privacy.allow`; Accounts `useSubscription: ["claude"]` writes `unset_env: ["ANTHROPIC_API_KEY"]` on whichever key the agent lands in; `none` writes nothing. Flip Task 3's `todo`. Then the draft for "ollama front desk + codex-acp escalation" validates through `checkDraft`.
- [ ] **Step 6: Page:** the Agent step shows the mode sentence ("The front desk hands a turn to this agent when you say 'think hard' … suits one-off deep questions, not follow-ups"), each ACP row's found/not found + "unverified until first call", and an "Allow this agent to use the cloud" checkbox on cloud agents in local mode.
- [ ] **Step 7: Run** `bun test tests/setup tests/brain-factory.test.ts`. Expected: PASS.
- [ ] **Step 8: Commit** "brain: escalation wraps any front desk; setup: privacy-aware Agent step".

---

### Task 9: Hear, Speak (Play sample) and Tasks (board allowance)

**Files:**
- Modify: `src/setup/pickers.ts` (`detectSpeech`: the recommendation rule already matches the spec. Expose `speechKind` for fit; `parseBoard`: allowance), `src/setup/steps.ts`, `src/setup/page.ts`, `src/setup/server.ts` (`/api/sample`)
- Create: `src/setup/sample.ts` (one-sentence synthesis against a running engine, shared with Test)
- Test: `tests/setup/pickers.test.ts` (board allowance), `tests/setup/sample.test.ts`

**Interfaces (produced):**

```ts
// sample.ts
export const SAMPLE_SENTENCE = "Hello, I'm Cicero. This is how I sound.";
export interface SynthResult { ok: true; audio: Uint8Array; mime: "audio/wav" } | { ok: false; state: "not running" | "failed" | "timeout" | "cancelled"; message: string; startCommand?: string }
export function synthesizeSample(tts: Record<string, unknown>, opts: { signal: AbortSignal; timeoutMs: number; deps?: PickerDeps; maxBytes?: number }): Promise<SynthResult>;
```

Implementation: port-probe the engine (`defaultPortProbe`). If the port is closed, return "not running" with the start command from the doctor's existing hint builders (`buildVenvHint`/the audio.cpp hint). If it is open, build the TTS provider from a minimal runtime config for that seat via the existing registry (`src/backends/registry.ts`, looked up in-task) **without calling `start()`**, and call its synthesize method under `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])`. Cap the audio at 2 MB (`maxBytes`). If a backend's provider can only synthesize after `start()` (checked per backend in-task), that option shows "sample unavailable for this engine" instead. It never starts a process.

Board allowance (spec step 9): the choice gains `allowBoard: boolean`. Any board other than `none` without `allowBoard: true` fails with "Allow task text to go to this board first", and **`probeBoard` is not run** (the session only probes after parse succeeds). The contribution merges `withAllowance(ctx, "board")`. This applies in both privacy modes.

- [ ] **Step 1: Write failing tests:** a board without `allowBoard` throws and `runCommand` is never called (spy); with it, `privacy.allow` gains `board`; `synthesizeSample` on a closed port returns `not running` with a `startCommand`; `synthesizeSample` aborts on `signal` and on the timeout; `maxBytes` is enforced.
- [ ] **Step 2: Run to see them fail:** `bun test tests/setup/pickers.test.ts tests/setup/sample.test.ts`.
- [ ] **Step 3: Implement.** `/api/sample` takes `{ tts: <parsed speak choice> }`, holds one `AbortController` per request, and returns `{ audio: base64 }` or the failure object. `/api/sample/cancel` aborts it.
- [ ] **Step 4: Page:** a "Play sample" button on each TTS option whose status is running, playing via `new Audio('data:audio/wav;base64,…')`. The Tasks step gets the "Allow task text to go to this board?" checkbox, and the board options are disabled until it is ticked.
- [ ] **Step 5: Run** `bun test tests/setup`. Expected: PASS.
- [ ] **Step 6: Commit** "setup: Play sample for running TTS engines; board needs an explicit allowance".

---
### Task 10: Test step (headless probes shared with `--test`)

**Files:**
- Create: `src/setup/probes.ts`, `assets/setup/hear-test.wav` (synthetic, ~3 s, 16 kHz mono), `assets/setup/hear-test.txt` (its exact text), `assets/setup/long-reply.txt` (a bundled long reply for the helper probe)
- Modify: `src/setup/steps.ts` (`test` step, no choice), `src/setup/server.ts` (`/api/test`, `/api/test/cancel`, results keyed to `revision`), `src/setup/page.ts` (`renderTest`)
- Test: `tests/setup/probes.test.ts`, `tests/setup/server.test.ts` (timeout, cancel, invalidation)

**The WAV fixture** is synthetic. Generate it once with the Kokoro default voice (not a clone, no real person's voice) from the sentence "Cicero, what time is it in Tokyo?", then commit it and the text. `assets/*.wav` is tracked; the `/*.wav` ignore rule only covers the repo root. Record the generation command in the commit message.

**Interfaces (produced):**

```ts
export type ProbeId = "hear" | "frontdesk" | "helper" | "memory";
export type ProbeState = "ok" | "failed" | "not running" | "skipped" | "timeout" | "cancelled" | "installed; tested on first call";
export interface ProbeResult { id: ProbeId; state: ProbeState; message: string; startCommand?: string; data?: unknown }
export interface ProbeOptions { signal: AbortSignal; timeoutMs?: number; deps?: PickerDeps & { gpuRunner?: GpuCommandRunner } }
export function probeHear(config: Record<string, unknown>, o: ProbeOptions): Promise<ProbeResult>;      // WAV → configured STT; word-overlap ≥ 0.6 → ok
export function probeFrontDesk(config: Record<string, unknown>, o: ProbeOptions): Promise<ProbeResult>; // one chat completion when brain is a model; agent → "installed; tested on first call" + Agent install check
export function probeHelper(config: Record<string, unknown>, o: ProbeOptions): Promise<ProbeResult>;    // one summary of long-reply.txt; no helper → skipped
export function probeMemory(config: Record<string, unknown>, o: ProbeOptions): Promise<ProbeResult>;    // CUDA only; else skipped ("Mac measurement is deferred")
export function runHeadlessProbes(config: Record<string, unknown>, o: ProbeOptions): Promise<ProbeResult[]>; // all four + { id: "speak", state: "skipped", message: "skipped (no browser)" }
```

Rules (spec step 10):
- The default timeout per probe is 20 s (the helper summary needs 5 s+ on a cold model). Every fetch is bounded (`readBoundedJson`, 64 KB).
- A closed port means `not running` plus the start command.
- For an agent front desk or escalation agent, the probe also runs the Task 1-verified status command, bounded at 1.5 s. It reports which credential the CLI says it will use (spec step 3, "where the CLI can say"), and shows "unknown" where no verified command exists.
- An agent front desk or escalation is never run.
- Memory: parse `nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits` via `runBoundedCommand`. Match PIDs to the listener PIDs of the configured speech and runtime ports using the method Task 1 Step 6 verified. Unmatched usage is "other GPU use". When the per-process query fails, fall back to `probeNvidiaGpu` labeled "whole GPU".
- A memory result replaces a fit estimate with "measured" only for a model whose runtime PID matched.

Server:
- `/api/test` `{ probe }` runs one probe against the **draft**: the rendered config, not a file.
- The server keeps one `AbortController` per probe and stores `{ revision, results }`. Results whose revision ≠ `session.revision` are dropped from the view.
- `/api/test/cancel` `{ probe }` aborts it, and the result is `cancelled`.
- Speak is the browser-side sample from Task 9.
- Probe failures never block Save. Only Check's config failures do (unchanged).

- [ ] **Step 1: Write failing tests:**
  - `probeHear` with an injected fetcher returning the expected transcript → `ok`, and garbage → `failed` with the transcript in the message (bounded to 200 chars).
  - A closed port → `not running`.
  - `probeFrontDesk` for an agent → the "installed; tested on first call" state, and the spawner is never called (spy on `runCommand`).
  - `probeHelper` with no helper → `skipped`.
  - `probeMemory` parses the CSV fixture `"4242, 4012\n777, 3480\n"` with listeners `{8092: 777, 8080: 4242}` into per-engine GB.
  - Server: a probe that never resolves hits its injected 50 ms timeout → `timeout`; cancel → `cancelled`; a choice made after a probe finished removes its result from `/api/state`.
- [ ] **Step 2: Run to see them fail:** `bun test tests/setup/probes.test.ts tests/setup/server.test.ts`.
- [ ] **Step 3: Implement** `probes.ts` and the endpoints. STT calls reuse the configured backend's client the same way `synthesizeSample` does: the registry provider, no `start()`. Where a backend needs `start()` to transcribe, the probe falls back to the engine's HTTP API. That fallback is decided per backend in-task from the provider source and noted in the code.
- [ ] **Step 4: Page** `renderTest`: one row per probe with Run / Cancel buttons and a state pill, plus the start command for `not running`. Speak row → the Task 9 sample button. The Memory row shows a per-engine table. A "Results were cleared because the draft changed" note appears when results were dropped.
- [ ] **Step 5: Run** `bun test tests/setup`. Expected: PASS.
- [ ] **Step 6: Commit** "setup: Test step probes running engines with timeout, cancel and invalidation".

---

### Task 11: `cicero setup --plan / --apply / --test --json`

**Files:**
- Create: `src/setup/headless.ts`
- Modify: `src/cli/setup.ts`, `src/index.ts:97` (options)
- Test: `tests/cli/setup-headless.test.ts`

**Interfaces (produced):**

```ts
export interface PlanOptions { privacy: "local" | "cloud"; agent?: string; systemDeps?: SystemDeps; pickerDeps?: PickerDeps }
export interface PlanOutput {
  version: 1;
  detected: Record<string, unknown>;              // per step id, credential-safe (presence only)
  recommended: AnswersFile;                      // ready for --apply
  reasons: Record<string, string>;               // one line per step
  blocked: { step: string; reason: string; fix: string[] }[]; // e.g. no runtime found
}
export interface AnswersFile { version: 1; privacy: { mode: "local" | "cloud"; allow?: string[] }; steps: Record<string, unknown> }
export function planSetup(o: PlanOptions): Promise<PlanOutput>;
export interface ApplyOptions { home: string; answers: unknown; acknowledgeNotReady: boolean; backupInvalid: boolean; systemDeps?: SystemDeps; pickerDeps?: PickerDeps; check?: typeof checkDraft; now?: () => number }
export interface ApplyOutput { ok: boolean; written?: string; backup?: string; checks: SetupCheckGroups | null; error?: string; step?: string }
export function applySetup(o: ApplyOptions): Promise<ApplyOutput>;
export function testSetup(o: { home: string; timeoutMs?: number; deps?: ProbeOptions["deps"] }): Promise<ProbeResult[]>;
```

Semantics (spec "Agent-assisted setup"):
- **`planSetup`** runs the real detections in step order on a `SetupSession`. For each choice step it calls `detect`, then `recommend`, and applies the recommendation with `probe: false` so later steps see the draft. The top-level `privacy` of the answers file mirrors `steps.privacy`. It runs no Test probes and no board probe; the board recommendation is always `{ id: "none" }` because the allowance is the user's call. It reads only.
- **The answers file** is validated strictly. `version` must be 1. `steps` must hold exactly the `CHOICE_STEP_IDS`: a missing step fails with "steps.<id> is required", and `check`, `write`, `handoff`, `test`, `channels`, `install` or any unknown id fails with "steps.<id> is not accepted". `privacy` must equal `steps.privacy`.
- **`applySetup`** creates a fresh `SetupSession` from a **fresh** `detectSystem()`. For each step in order it calls `session.detect(id)` and then `session.choose(id, raw, { detected, probe: true })`. The first rejection returns `{ ok: false, step, error }` with the parser's or probe's own message, and nothing is written (Review Focus 3).
- Then `backupInvalidConfig` if `backupInvalid` and the config is invalid, then `session.check()`, then `session.writeGate(acknowledgeNotReady)`, then `writeDraft(home, draft)`. The v1 errors propagate unchanged (Review Focus 5).
- **CLI:** `cicero setup --plan --json --privacy <m> [--agent <id>]`, `cicero setup --apply <file> [--acknowledge-not-ready] [--backup-invalid] [--home <dir>] [--json]` and `cicero setup --test --json [--home <dir>]`.
  - `--plan` requires `--json` and `--privacy`. The three modes are mutually exclusive, and none of them starts the server.
  - Exit codes: 0 ok, 1 rejected/blocked, 2 usage.
  - Every JSON output passes through `redactSnapshotSecrets` plus the draft-secret redaction the server uses.
  - `--test` loads `<home>/config.yaml` via `loadConfig({}, { home })`.

- [ ] **Step 1: Write failing tests**, in-process with injected deps, no network:
  - `planSetup` on the cuda24 fixture with a fetcher listing `gemma4:e4b` and `gemma4:26b` on Ollama gives `recommended.steps.frontdesk.model === "gemma4:26b"` and `helper.model === "gemma4:e4b"`, and every choice step is present.
  - The synthetic `ANTHROPIC_API_KEY` never appears in `JSON.stringify(plan)`.
  - Round trip: `applySetup({ answers: plan.recommended })` writes a config that `loadConfig` accepts.
  - Missing step, extra `check` step, `privacy` mismatch → each fails with its message.
  - A helper model no longer listed → `{ ok: false, step: "helper" }` and no file.
  - An existing valid config → error, bytes unchanged.
  - An invalid config without `--backup-invalid` → error, and with it → backup path returned + written.
  - notReady without the ack → error.
- [ ] **Step 2: Run to see them fail:** `bun test tests/cli/setup-headless.test.ts`.
- [ ] **Step 3: Implement** `headless.ts` and the CLI wiring.
- [ ] **Step 4: Live smoke (labeled).** On this box, run `bun run src/index.ts setup --plan --json --privacy local --agent codex-acp` and `bun run src/index.ts setup --test --json --home ~/.cicero`, both read-only. Paste a trimmed output into the PR's manual section.
- [ ] **Step 5: Run** `bun test tests/cli tests/setup`. Expected: PASS.
- [ ] **Step 6: Commit** "setup: --plan/--apply/--test JSON modes on the shared session".

---

### Task 12: Doctor privacy warnings and `cicero doctor --json`

**Files:**
- Modify: `src/setup/privacy.ts` (`privacyChecks(config)`), `src/cli/doctor.ts` (`collectChecks` appends them; `runDoctor({ json })`), `src/index.ts:89` (`--json`)
- Test: `tests/setup/privacy.test.ts`, `tests/cli/doctor-json.test.ts`

**Interfaces (produced):**

```ts
export function privacyChecks(config: RuntimeConfig): Check[]; // [] when config.raw.privacy is undefined
export async function runDoctor(options?: { json?: boolean; write?: (s: string) => void }): Promise<number>;
// --json prints { version: 1, checks: Check[], fails: number, warns: number } and exits with the same code as text mode
```

Warnings (spec step 1), one `warn` check named `privacy: <item>` each. **Local mode:**
- A non-loopback `brain.base_url`, a non-loopback `llm.baseUrl` (or an `llm.backend` cloud preset without a loopback `baseUrl`), or a non-loopback `web_voice.tldr.summarizer_url`. Loopback = `127.0.0.0/8`, `::1`, `localhost`, via `isKeylessHost` in `src/backends/net.ts` if it matches, else a local helper.
- A `brain.backend` in `claude-code|codex|gemini|qwen`, or an ACP `binary`/`escalate` command matching a Task 1 cloud adapter, without `allow: [agent]`.
- A cloud preset `brain.backend`, which is itself a model endpoint (handled above).

**Both modes:**
- A `notify.telegram` block without `allow: [telegram]`.
- `notify.kanban.enabled` without `allow: [board]`.

Cloud mode checks only the Telegram and board allowances. Every privacy check `detail` ends with "declared policy; doctor cannot see what a CLI agent does on the network" when it concerns an agent.

- [ ] **Step 1: Write failing tests:**
  - No `privacy` → no privacy checks.
  - Local + `brain.backend: xai` → warn.
  - Local + ollama loopback → none.
  - Local + `claude-code` without allow → warn, and with allow → none.
  - Cloud + `claude-code` → none.
  - Cloud + telegram without allow → warn.
  - Kanban enabled without allow → warn in both modes.
  - `--json`: capture `write`, parse JSON, and the checks equal the `collectChecks` output. The synthetic secret in `brain.api_key` never appears.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.** `classifySetupChecks` keeps `privacy:*` as warnings, so they never block Save.
- [ ] **Step 4: Run** `bun test tests/setup tests/cli`. Expected: PASS.
- [ ] **Step 5: Commit** "doctor: privacy policy warnings and --json output".

---
### Task 13: Mermaid on the docs site + the three diagrams

**Files:**
- Modify: `package.json` + `bun.lock` (the plugin chosen in Task 1, pinned per the lockfile convention), `docs/.vitepress/config.ts` (wrap with the plugin), possibly `docs/.vitepress/theme/index.ts` (fallback path)
- Modify: `README.md` (diagram 1), `docs/architecture.md` (diagram 1 replaces the ASCII pipeline; diagram 2), `docs/setup.md` (diagram 3)
- Delete: `docs/images/setup-overview.png` and every reference to it (`grep -rn setup-overview --include='*.md' .`)
- Test: `tests/docs-diagrams.test.ts`

Diagram content (the spec's "Diagrams"):
1. **How a turn flows:** `Hear (STT) → Front desk (model or agent) → [optional] escalation agent ("think hard …") → Helper shortens long replies → Speak (TTS)`, with a dotted "lanes (part 2)" node. No Laya router, no faster-whisper-specific label: nodes say "Hear (your STT engine)".
2. **What runs where:** the reference box as an example, labeled as such. Columns: engine/agent, port or command, footprint, basis. Rows: audio.cpp Nemotron + Pocket :8092, 3.5 GB measured; llama-swap Gemma 4 E4B helper :8080, 4.0 GB measured; Gemma 4 26B-A4B front desk, 15 GB measured (~14–15); escalation agent `bunx codex-acp`, "unknown (not measured)". The note says Test replaces estimates with measurements on CUDA, and that Mac values stay estimates.
3. **The wizard:** the thirteen available steps from the step table and what each writes (`privacy`, `deployment`, (nothing), `brain`, `web_voice.tldr` + `llm` + compaction, `stt`, `tts`, `brain` or `brain.escalate` + `unset_env`, `notify.kanban` + `privacy.allow`, (probes only), Check, `config.yaml`, start command).

- [ ] **Step 1: Write the failing test.** It checks that each of `README.md`, `docs/architecture.md` and `docs/setup.md` contains a ```` ```mermaid ```` fence; that no markdown file references `setup-overview.png`; that `docs/architecture.md` no longer contains the ASCII pipeline's box-drawing lines; and that no diagram mentions "faster-whisper" or "Laya" as the default path.
- [ ] **Step 2: Run to see it fail.**
- [ ] **Step 3: Add the plugin and the diagrams.** Run `bun run docs:build`, then check `grep -l 'class="mermaid"' docs/.vitepress/dist/index.html docs/.vitepress/dist/architecture.html docs/.vitepress/dist/setup.html` (all three must match).
- [ ] **Step 4: Run** `bun test tests/docs-diagrams.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** "docs: Mermaid on the docs site; turn, layout and wizard diagrams".

---

### Task 14: One setup path, README pitch, Using page, owner material to Advanced

**Files:**
- Rewrite: `docs/setup.md`, the only walkthrough. It follows the step table in order, one `##` section per step title, stating what the step asks and what it writes. After the steps:
  - "Start and pair" (from today's sections 5–6);
  - "Manual steps the wizard doesn't do yet" (Channels, Install, and audio.cpp weights);
  - "Platform variants";
  - "Remote model servers";
  - "CLI reference", including the new `setup` flags and `doctor --json`.
  The duplicated "Your first conversation" and "Additional Linux installation detail" walkthroughs are folded in or removed. It keeps one ```` ```yaml cicero-config ```` block, "What the wizard writes for a Claude Code setup", containing `brain: { backend: claude-code, mode: subprocess }`, which must pass validation (Task 16).
- Rewrite: `README.md`, cut to the pitch ("What it feels like", "What makes it different"), diagram 1, a quickstart and links. The quickstart:

```bash
git clone https://github.com/5uck1ess/cicero && cd cicero
bun install
bun run src/index.ts setup     # or: bun link, then cicero setup
```

  Open the printed URL. Its wizard copy, hand-written config, "Which brain" Hermes-default copy, and the Hermes/Laya/personality sections go. Supported agents are listed neutrally: Claude Code, Codex, Gemini, Qwen, and any ACP agent (Hermes, codex-acp, …).
- Create: `docs/using.md`, covering what to say; how to interrupt (barge-in); "details" after a shortened reply; the escalation triggers from `DEFAULT_TRIGGERS` (the test in Task 16 reads them from `src/brain/routing.ts`); what `local` vs `cloud` privacy means day to day (a `#privacy` anchor, which the Privacy step links); and `cicero status` / `cicero doctor [--json]`.
- Modify: `docs/configuration.md`. The "Deployment tier" section becomes "Tier presets (legacy defaults)": the wizard writes explicit `stt`/`tts`/`llm`, which override the preset. It documents `privacy`, the `cerebras`/`xai` presets, and `brain.escalate` on any front desk.
- Modify: `config.yaml.example`, whose header reads "Reference: every option. The wizard (`cicero setup`) writes your config; you do not need to copy this file." It gains a commented `privacy:` example.
- Create: `docs/advanced.md`, "Advanced / example deployment". It links `reference-deployment.md`, `office.md` (Hermes, lanes, personalities), `channels.md`, and the Laya sidecar README, and says "needs a checkpoint trained on your roster".
- Modify: `docs/.vitepress/config.ts` sidebar:
  - "Have your first conversation" → Setup, Using Cicero, Choosing a brain, Configuration.
  - A new "Advanced / example deployment" group → Advanced overview, Reference deployment, The office, Channels.
  - "The office" is removed from "Understand it".
- Modify: `docs/brains.md` so Hermes is no longer "recommended default" (grep `recommended default`), and `docs/README.md` (docs index links).
- Modify: `docs/setup.md` guided section's old `provider`/`router` wording, and any other doc mentioning "Intent router" as a wizard step (`grep -rn "Intent router\|LLM provider" docs README.md`).

- [ ] **Step 1:** Make the Task 16 docs tests exist first (write that task's test file now, failing), then edit the docs until they pass.
- [ ] **Step 2: Claims pass.** For every factual sentence added (ports, flags, keys, trigger phrases, file paths), `grep` the code and note the `file:line` in a scratch list. This follows the "docs claims need code proof" rule. Remove any sentence without a source.
- [ ] **Step 3:** `bun run docs:build` passes. There are no dead links: VitePress fails the build on them by default, and the `ignoreDeadLinks` setting is left unchanged.
- [ ] **Step 4: Commit** "docs: one setup path, README pitch, Using Cicero, owner material under Advanced".

---

### Task 15: `INSTALL.md`, `llms.txt`, `AGENTS.md` link

**Files:**
- Create: `INSTALL.md` (repo root), `llms.txt` (repo root)
- Modify: `AGENTS.md` (one line under a new "## Installing Cicero for a user" heading pointing to `INSTALL.md`; contributor guidance unchanged)
- Modify: `docs/.vitepress/config.ts` (`srcExclude` adds `INSTALL.md` and `llms.txt`, so they are repo-only agent files; the Using/Setup pages link to them on GitHub)

`INSTALL.md` contents, in order:
1. The rules: never invent config keys, never copy another user's config, never `bun link` in a scratch clone, and never overwrite `~/.cicero/config.yaml` (apply refuses; tell the user instead).
2. Prerequisites check: `bun --version` against `packageManager` in `package.json`, and `bun install`.
3. Ask the user two questions, verbatim: the Privacy question with its two options, and which agent (if any), listing the ids `--plan` accepts.
4. `bun run src/index.ts setup --plan --json --privacy <mode> [--agent <id>] > plan.json`. Show the user `recommended` + `reasons` + `blocked`, and get their OK. For `blocked`, show `fix` and stop.
5. Write `answers.json` = `plan.recommended`, with only the user's requested edits, each an existing choice shape from `plan.detected`.
6. `bun run src/index.ts setup --apply answers.json [--acknowledge-not-ready only if the user agrees]`.
7. `bun run src/index.ts doctor --json`, then summarize the fails and warnings for the user.
8. Optionally `bun run src/index.ts setup --test --json` once engines are running.
9. How to start: `bun run src/index.ts start`, and pairing from `docs/setup.md`.

It carries the ordered step title list (the Task 16 contract) and one ```` ```yaml cicero-config ```` example of a written config that validates.

`llms.txt` follows the llms.txt convention: an H1 "Cicero", a one-paragraph blockquote summary, then "## Setup" linking `INSTALL.md` and `docs/setup.md`, "## Use" linking `docs/using.md`, and "## Reference" linking `docs/configuration.md` and `config.yaml.example`. It uses GitHub URLs on `main`.

- [ ] **Step 1:** The Task 16 tests for `INSTALL.md` fail (the file is missing).
- [ ] **Step 2:** Write both files and the `AGENTS.md` line.
- [ ] **Step 3:** Run `bun test tests/onboarding-contract.test.ts` and `bun run docs:build`. Expected: PASS.
- [ ] **Step 4: Commit** "docs: INSTALL.md and llms.txt for agent-assisted setup".

---

### Task 16: Keeping docs true (docs tests)

**Files:**
- Modify: `tests/onboarding-contract.test.ts`

```ts
import { parse } from "yaml";
import { SETUP_STEPS } from "../src/setup/steps";
import { validateRuntimeConfig } from "../src/config-validation";
import { DEFAULT_TRIGGERS } from "../src/brain/routing";
const read = (p: string) => readFileSync(p, "utf8");
const fences = (text: string, info: string) => [...text.matchAll(new RegExp("```" + info + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1]!);
const titles = SETUP_STEPS.filter((s) => s.available).map((s) => s.title);

test("README links the setup guide and carries no config or step list", () => {
  const readme = read("README.md");
  expect(readme).toContain("docs/setup.md");
  expect(fences(readme, "yaml cicero-config")).toEqual([]);
  expect(readme).not.toMatch(/brain: \{ backend: claude-code, mode: subprocess \}/);
});
test.each(["docs/setup.md", "INSTALL.md"])("%s: every cicero-config block is a complete valid config", (path) => {
  const blocks = fences(read(path), "yaml cicero-config");
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) expect(() => validateRuntimeConfig(parse(block), path)).not.toThrow();
});
test("config.yaml.example is validated as a whole file", () => {
  expect(() => validateRuntimeConfig(parse(read("config.yaml.example")) ?? {}, "config.yaml.example")).not.toThrow();
});
test.each(["docs/setup.md", "INSTALL.md"])("%s lists the available step titles in order", (path) => {
  const text = read(path);
  let at = -1;
  for (const title of titles) { const i = text.indexOf(title, at + 1); expect(i).toBeGreaterThan(at); at = i; }
});
test("setup guide and example keep the headless Claude Code line", () => {
  expect(read("docs/setup.md")).toMatch(/brain: \{ backend: claude-code, mode: subprocess \}/);
  expect(read("config.yaml.example")).toMatch(/brain: \{ backend: claude-code, mode: subprocess \}/);
});
test("using.md lists the real escalation triggers", () => {
  const using = read("docs/using.md");
  for (const t of DEFAULT_TRIGGERS) expect(using).toContain(t);
});
```

The existing token assertions (`token: <generate-a-secret>` absent from README, setup guide, web guide and example) are kept verbatim. Whether `validateRuntimeConfig` is the right whole-config entry point, or whether `loadConfig` in a temp home is needed to expand tiers, is checked against `tests/config.test.ts` in-task. If the fenced blocks rely on tier expansion, validate via a temp home + `loadConfig` instead.

- [ ] **Step 1:** Write the test (done at the start of Task 14). Run it, expecting FAIL.
- [ ] **Step 2:** Tasks 14–15 make it pass.
- [ ] **Step 3: Commit** with Task 14 or on its own: "test: docs configs validate and step lists follow the wizard".

---

### Task 17: Screenshot of the v2 page

- [ ] **Step 1:** Check that Playwright + Chromium are present (`bun x playwright --version`, `ls ~/.cache/ms-playwright`). If they're absent, say so, and ask before installing a browser (per the "check existing installs first" rule).
- [ ] **Step 2:** Start `bun run src/index.ts setup --home "$(mktemp -d)" --port 0` in the background, capture the printed URL, drive to the Machine step (budget bar visible), and screenshot at 1280×900 to `docs/images/setup-wizard.png`. Stop the server.
- [ ] **Step 3:** Reference it in `docs/setup.md` under the wizard diagram, with alt text naming the step. Run `bun run docs:build`.
- [ ] **Step 4: Commit** "docs: v2 setup page screenshot".

---

### Task 18: Gates, live runs, acceptance, Astra check, PR and watch

- [ ] **Step 1: Gates** (never piped): `bun run typecheck`, `bun test`, `git diff --check origin/main...HEAD`, `bun run docs:build`. Fix anything red with its own regression first.
- [ ] **Step 2: Live wizard run on the reference Linux box (labeled manual).** Use a scratch home (`--home "$(mktemp -d)"`), since the live `~/.cicero` must stay untouched. Walk all steps on the page against the running llama-swap :8080 and audio.cpp :8092. Run Test (Hear, Front desk, Helper, Speak sample, Memory), Check and Save. Record the outcomes, measured memory and any "unknown" rows for the PR. **Apple Silicon run:** needs Tym's Mac. Mark it "needs your test" in the PR with the exact steps.
- [ ] **Step 3: Final acceptance (fresh clone, fresh agent).** It is isolated so it cannot touch the live box:

```bash
T=$(mktemp -d); mkdir -p "$T/home"
git clone --branch spec/wizard-v2-basics https://github.com/5uck1ess/cicero "$T/cicero"
cd "$T/cicero" && env -u BUN_INSTALL HOME="$T/home" BUN_INSTALL_CACHE_DIR="$HOME/.bun/install/cache" bun install
# Claude Code, turn 1 (the only instruction is the sentence below):
cd "$T/cicero" && env -u BUN_INSTALL HOME="$T/home" CLAUDE_CONFIG_DIR="$HOME/.claude" \
  claude -p "set up Cicero for me using INSTALL.md" --output-format json \
  --allowedTools "Read" "Bash(bun run src/index.ts setup:*)" "Bash(bun run src/index.ts doctor:*)" "Bash(bun --version)" "Bash(bun install:*)" "Write(answers.json)" > "$T/turn1.json"
# turn 2 answers the agent's questions as a user would ("local", "no agent", "yes, apply it"):
claude -p --resume "$(jq -r .session_id "$T/turn1.json")" "Local only. No agent for now. The plan looks good, apply it." --output-format json > "$T/turn2.json"
test -f "$T/home/.cicero/config.yaml" && bun run src/index.ts doctor --json   # with HOME="$T/home"
```

Codex variant: `env HOME="$T/home" CODEX_HOME="$HOME/.codex" codex exec -m gpt-6-sol -C "$T/cicero" "set up Cicero for me using INSTALL.md"`, then `codex exec resume --last "…same answer…"`. Report pass/fail per agent: whether it asked the Privacy question, ran `--plan`, showed the plan, applied, ran doctor, and whether `$T/home/.cicero/config.yaml` loads. Include a short transcript summary. HOME is swapped so `~/.cicero` and `~/.bun/bin` are never touched. Auth comes through `CLAUDE_CONFIG_DIR`/`CODEX_HOME`. Delete `$T` afterwards.
- [ ] **Step 4: Astra check (Tym's request).** Write `q.md` in the job tmp dir. It asks for a section-by-section check of `git diff origin/main...HEAD` against the spec (every section including "Docs and agent-assisted setup" and "Keeping docs true"), with a READY / NOT READY verdict and findings as `file:line`, severity, spec section, and the failing scenario. Paste the `bun run docs:build` result and the gate outputs into `q.md`, since a read-only sandbox can't run them. Then run:
  `codex exec -m gpt-6-astra -c model_reasoning_effort="high" -s read-only --skip-git-repo-check -C /home/ryzen/LocalDev/cicero-wt/wizard-v2 < q.md`
  Don't edit the tree while it reads. Check each finding against the code (an UNSUPPORTED from Codex is the edge of its sandbox, not a disproof), fix the real ones with tests, re-run the gates, and repeat until READY.
- [ ] **Step 5: PR.** Push the branch. Open ONE ready PR with `gh pr create --repo 5uck1ess/cicero --base main --head spec/wizard-v2-basics`, titled "Setup v2 part 1: wizard, docs, diagrams and agent-assisted setup". The body: "Closes #143", a summary per spec section, the "unknown/unverified" list from Task 1, gate results, the live-run and acceptance summaries, and "Apple Silicon: needs your test". No attribution lines.
- [ ] **Step 6: Watch.** `CronCreate` at `3-59/10 * * * *` with the prompt "run `bash ~/.claude/skills/fix-issue/pr-brief-status.sh 5uck1ess/cicero <pr>` for worktree /home/ryzen/LocalDev/cicero-wt/wizard-v2, branch spec/wizard-v2-basics; act on NEXT per fix-issue". Run the baseline check immediately and confirm the job's next run. Loop on NEXT until STOP, then report ready to merge. Never merge. Clean up only after Tym merges.
