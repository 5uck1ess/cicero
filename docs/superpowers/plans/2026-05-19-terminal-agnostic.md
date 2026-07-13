# Terminal-Agnostic Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple Cicero from kitty as the assumed terminal. The `TerminalAdapter` abstraction already exists (`src/terminal/`); this plan removes the kitty-specific leakage that bypasses it, generalizes the `Tab` shape, adds auto-detection, and introduces a no-terminal headless mode.

**Architecture:** The interface at `src/types.ts:126` is sound. Three structural changes:

1. **Generalize `Tab`** — drop kitty-specific `window_id` field; each adapter encodes its native handle in `id` (string).
2. **Extend `TerminalAdapter`** with `spawnTab()`, `closeTab()`, and `health()` so `src/brain/tab-inject.ts` no longer shells out to `kitty` directly.
3. **Default to `"auto"` detection** instead of hardcoded `"kitty"`; add a `NullTerminalAdapter` for headless deployments where the user doesn't want spawn/inject UX.

After this lands, adding a new terminal (wezterm, iterm2, screen) is purely an adapter file — no other code changes needed.

**Tech Stack:** Bun ≥1.1, TypeScript 5.9, `Bun.spawn`. No new deps.

**Non-goals:**
- Don't reimplement the brain layer — `tab-inject.ts` keeps its responsibility, it just calls through the adapter.
- Don't add iterm2 / screen adapters in this plan. Wire WezTerm because the stub already exists.
- Don't change the speaker / listener layer — they don't touch the terminal.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/types.ts` | MODIFY | Generalize `Tab` shape; extend `TerminalAdapter` interface |
| `src/terminal/index.ts` | MODIFY | Add `"auto"` detection, `"none"` headless, WezTerm dispatch |
| `src/terminal/kitty.ts` | MODIFY | Implement `spawnTab`, `closeTab`, `health`; drop `window_id` |
| `src/terminal/tmux.ts` | MODIFY | Implement `spawnTab`, `closeTab`, `health`; drop `window_id` |
| `src/terminal/wezterm.ts` | NEW | WezTerm adapter via `wezterm cli` |
| `src/terminal/null.ts` | NEW | No-op headless adapter |
| `src/terminal/detect.ts` | NEW | Auto-detection logic (env, PATH probes) |
| `src/config.ts` | MODIFY | Default `terminal: "auto"`; remove kitty CLI strings from `DEFAULT_CONFIG.servers` |
| `src/brain/tab-inject.ts` | MODIFY | Replace direct `Bun.spawn(["kitty", ...])` with adapter calls |
| `src/backends/tiers.ts` | MODIFY | Remove `terminal: "kitty"` from tier presets — let it cascade |
| `src/index.ts` | MODIFY | Health check uses `adapter.health()` instead of `kitty @ ls` |
| `tests/terminal-tab-shape.test.ts` | NEW | Adapter contract test: `Tab` shape, required methods |
| `tests/terminal-detect.test.ts` | NEW | Auto-detect picks tmux when `$TMUX` set, etc. |
| `tests/terminal-kitty-spawn.test.ts` | NEW | KittyAdapter `spawnTab`/`closeTab` integration (mocked spawn) |
| `tests/terminal-tmux-spawn.test.ts` | NEW | TmuxAdapter `spawnTab`/`closeTab` integration (mocked spawn) |
| `tests/terminal-null.test.ts` | NEW | NullTerminalAdapter never throws, returns empty lists |
| `tests/terminal-wezterm.test.ts` | NEW | WezTermAdapter parses `wezterm cli list` |
| `tests/brain-tab-inject-uses-adapter.test.ts` | NEW | `tab-inject.ts` no longer references `kitty` literal |

---

## Task 1: Generalize the `Tab` shape

**Files:**
- Modify: `src/types.ts:60-70`

The current `Tab` has `id: number` and `window_id: number` with comments explicitly tying both to kitty. tmux's adapter at `src/terminal/tmux.ts:18-19` already shoves the same value into both fields as a workaround. Fix the shape.

- [ ] **Step 1: Write the failing test**

Create `tests/terminal-tab-shape.test.ts`:

```ts
import { test, expect } from "bun:test";
import type { Tab } from "../src/types";

test("Tab uses opaque string id, no terminal-specific fields", () => {
  const tab: Tab = {
    id: "any-string-handle",
    title: "test",
    is_focused: false,
    cwd: "/tmp",
  };
  expect(tab.id).toBe("any-string-handle");
  // @ts-expect-error window_id should no longer exist
  expect(tab.window_id).toBeUndefined();
});
```

- [ ] **Step 2: Run test — expect FAIL**

`bun test tests/terminal-tab-shape.test.ts` — fails because `window_id` still exists on `Tab`.

- [ ] **Step 3: Update `Tab` interface**

In `src/types.ts`, replace the `Tab` interface:

```ts
export interface Tab {
  id: string;            // opaque adapter-specific handle
  title: string;
  is_focused: boolean;
  cwd?: string;
}
```

- [ ] **Step 4: Update KittyAdapter to use string id**

In `src/terminal/kitty.ts:22-29`, return `id: String(win?.id ?? tab.id)`. Internally KittyAdapter keeps numeric kitty IDs but exposes them as strings.

- [ ] **Step 5: Update TmuxAdapter to use string id**

In `src/terminal/tmux.ts:14-25`, return `id: id?.replace("@", "") ?? String(idx)`. Drop the duplicate `window_id` line.

- [ ] **Step 6: Update all call sites**

Search: `grep -rn "window_id" src/`. Every reference must be replaced with `id`. Notably `src/brain/tab-inject.ts:251` uses `target.window_id.toString()` — becomes just `target.id`.

- [ ] **Step 7: Re-run test — expect PASS**

`bun test tests/terminal-tab-shape.test.ts` and `bun test` (full suite). All 240+ tests still pass.

---

## Task 2: Extend `TerminalAdapter` with `spawnTab`, `closeTab`, `health`

**Files:**
- Modify: `src/types.ts:126`

This is the central change. After this, `tab-inject.ts` never needs to know which terminal is running.

- [ ] **Step 1: Write the contract test**

Create `tests/terminal-adapter-contract.test.ts`:

```ts
import { test, expect } from "bun:test";
import type { TerminalAdapter } from "../src/types";

test("TerminalAdapter declares spawnTab, closeTab, health", () => {
  const methods: (keyof TerminalAdapter)[] = [
    "listTabs", "focusTab", "sendText", "sendKey", "getText",
    "spawnTab", "closeTab", "health",
  ];
  expect(methods.length).toBe(8);
});
```

- [ ] **Step 2: Run test — expect FAIL** (TS compile error: methods don't exist yet)

- [ ] **Step 3: Extend the interface**

```ts
export interface SpawnTabOptions {
  title: string;
  cwd?: string;
  command?: string;       // optional shell command to send into the new tab
  env?: Record<string, string>;
  keepFocus?: boolean;
}

export interface TerminalAdapter {
  listTabs(): Promise<Tab[]>;
  focusTab(nameOrId: string): Promise<void>;
  sendText(tab: string, text: string): Promise<void>;
  sendKey(tab: string, key: string): Promise<void>;
  getText(tab: string, extent?: "screen" | "all" | "last_cmd_output"): Promise<string>;
  spawnTab(opts: SpawnTabOptions): Promise<Tab>;
  closeTab(id: string): Promise<void>;
  health(): Promise<{ ok: boolean; reason?: string }>;
}
```

- [ ] **Step 4: Re-run test — expect PASS** (compile-only; implementations still missing)

---

## Task 3: Implement `KittyAdapter` extensions

**Files:**
- Modify: `src/terminal/kitty.ts`

- [ ] **Step 1: Write the test**

Create `tests/terminal-kitty-spawn.test.ts`. Use Bun's `mock()` to intercept `Bun.spawn`; assert that `spawnTab({ title: "x", command: "echo hi" })` runs `kitty @ launch --type=tab --tab-title=x` then injects the command.

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement `spawnTab` in `KittyAdapter`**

Port the logic currently in `src/brain/tab-inject.ts:142-186` — `kitty @ launch --type=tab --tab-title=${opts.title} [--keep-focus] [--cwd=${opts.cwd}]` with `CICERO_BRAIN=1` env. Returns a `Tab` constructed from the returned window ID. If `opts.command` is set, follow up with `sendText` + `sendKey("enter")`.

- [ ] **Step 4: Implement `closeTab(id)` in `KittyAdapter`**

Wrap `kitty @ close-tab --match id:${id}`. Currently inlined at `tab-inject.ts:193-196`.

- [ ] **Step 5: Implement `health()` in `KittyAdapter`**

Run `kitty @ ls` with a 1-second timeout. Return `{ ok: true }` on exit 0, `{ ok: false, reason: "kitty remote control not available" }` otherwise. This replaces the inline check at `src/index.ts:92`.

- [ ] **Step 6: Re-run test — expect PASS**

---

## Task 4: Implement `TmuxAdapter` extensions

**Files:**
- Modify: `src/terminal/tmux.ts`

- [ ] **Step 1: Write the test**

Create `tests/terminal-tmux-spawn.test.ts`. Assert `spawnTab({ title: "x", command: "echo hi" })` runs `tmux new-window -n x` then `tmux send-keys ... Enter`.

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement `spawnTab`**

`tmux new-window -P -F "#{window_id}" -n ${title} [-c ${cwd}]` — `-P` prints the new window id, `-F` formats it. Parse, then optionally `send-keys` the command. Use `set-environment` for env vars if needed (tmux scopes env at session level — for simplicity, prefix the command with `EnvKey=Val command`).

- [ ] **Step 4: Implement `closeTab(id)`**

`tmux kill-window -t @${id}`.

- [ ] **Step 5: Implement `health()`**

`tmux info` — exit 0 means a server is running; non-zero means no tmux session (and `$TMUX` env var also empty). Return `{ ok: false, reason: "no tmux session — start one with 'tmux new'" }` when not in a session.

- [ ] **Step 6: Re-run test — expect PASS**

---

## Task 5: Add `NullTerminalAdapter` for headless mode

**Files:**
- Create: `src/terminal/null.ts`

For users who want voice → brain dispatch without spawning terminal windows (e.g., a server deployment, or someone who just wants Cicero to drive `claude-code` in-process).

- [ ] **Step 1: Write the test**

Create `tests/terminal-null.test.ts`. Assert that every adapter method returns a sensible empty/no-op value, never throws.

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement `NullTerminalAdapter`**

```ts
export class NullTerminalAdapter implements TerminalAdapter {
  async listTabs() { return []; }
  async focusTab() {}
  async sendText() {}
  async sendKey() {}
  async getText() { return ""; }
  async spawnTab(opts: SpawnTabOptions): Promise<Tab> {
    return { id: "null", title: opts.title, is_focused: false };
  }
  async closeTab() {}
  async health() { return { ok: true, reason: "headless mode (no terminal integration)" }; }
}
```

- [ ] **Step 4: Re-run test — expect PASS**

---

## Task 6: Auto-detection — `terminal: "auto"`

**Files:**
- Create: `src/terminal/detect.ts`
- Modify: `src/terminal/index.ts`

- [ ] **Step 1: Write the test**

Create `tests/terminal-detect.test.ts`:

```ts
import { test, expect } from "bun:test";
import { detectTerminal } from "../src/terminal/detect";

test("auto-detect picks tmux when $TMUX set", () => {
  expect(detectTerminal({ TMUX: "/tmp/tmux-foo" })).toBe("tmux");
});

test("auto-detect picks kitty when KITTY_WINDOW_ID set", () => {
  expect(detectTerminal({ KITTY_WINDOW_ID: "1" })).toBe("kitty");
});

test("auto-detect picks wezterm when WEZTERM_PANE set", () => {
  expect(detectTerminal({ WEZTERM_PANE: "0" })).toBe("wezterm");
});

test("auto-detect falls back to null when nothing available", () => {
  expect(detectTerminal({})).toBe("none");
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement `detectTerminal(env = process.env)`**

Priority order: `$TMUX` → tmux, `$KITTY_WINDOW_ID` → kitty, `$WEZTERM_PANE` → wezterm, `$ITERM_SESSION_ID` → none for now (no iterm adapter yet), else `"none"`. The function returns the literal that `createTerminalAdapter` accepts.

- [ ] **Step 4: Update `createTerminalAdapter`**

In `src/terminal/index.ts`, add `case "auto":` that calls `createTerminalAdapter({ ...config, terminal: detectTerminal() })`. Add `case "none":` that returns `new NullTerminalAdapter()`. Remove the platform-based default block (no longer needed) — fall back to `NullTerminalAdapter` if unknown value.

- [ ] **Step 5: Re-run test — expect PASS**

---

## Task 7: Wire WezTerm adapter (stub already exists)

**Files:**
- Create: `src/terminal/wezterm.ts`
- Modify: `src/terminal/index.ts:12-13`

WezTerm has `wezterm cli list-clients`, `wezterm cli spawn`, `wezterm cli send-text`, `wezterm cli get-text`. Surface area maps cleanly.

- [ ] **Step 1: Write the test**

Create `tests/terminal-wezterm.test.ts`. Mock `Bun.spawn`; assert `listTabs()` parses `wezterm cli list` output.

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement `WezTermAdapter`**

Wrap `wezterm cli` commands matching the contract. Spawn: `wezterm cli spawn --new-window`. Send-text: `wezterm cli send-text --pane-id ${id} --no-paste ${text}`. Get-text: `wezterm cli get-text --pane-id ${id}`.

- [ ] **Step 4: Wire dispatch**

In `src/terminal/index.ts`, replace the `throw new Error("WezTerm adapter not yet implemented")` with `return new WezTermAdapter()`.

- [ ] **Step 5: Re-run test — expect PASS**

---

## Task 8: Refactor `tab-inject.ts` to use the adapter

**Files:**
- Modify: `src/brain/tab-inject.ts`

This is where the most kitty leakage lives.

- [ ] **Step 1: Write the regression test**

Create `tests/brain-tab-inject-uses-adapter.test.ts`:

```ts
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

test("tab-inject.ts has no direct kitty references", () => {
  const src = readFileSync("src/brain/tab-inject.ts", "utf8");
  expect(src.includes('"kitty"')).toBe(false);
  expect(src.includes("kitty @")).toBe(false);
});
```

- [ ] **Step 2: Run test — expect FAIL** (kitty references at lines 146, 194)

- [ ] **Step 3: Replace `spawnBrainTab` body**

Replace the `Bun.spawn(["kitty", "@", "launch", ...])` block at `tab-inject.ts:142-186` with:

```ts
const tab = await this.terminal.spawnTab({
  title: this.targetTab,
  cwd: process.cwd(),
  command: "claude --dangerously-skip-permissions",
  env: { CICERO_BRAIN: "1" },
  keepFocus: true,
});
this.ownedTabId = tab.id;
await this.waitForBrainReady();
```

- [ ] **Step 4: Replace `stop()` body**

Replace the `Bun.spawn(["kitty", "@", "close-tab", ...])` block at `tab-inject.ts:188-201` with:

```ts
if (this.ownedTabId !== null) {
  await this.terminal.closeTab(this.ownedTabId);
  this.ownedTabId = null;
}
```

- [ ] **Step 5: Update `ownedTabId` type**

Change `private ownedTabId: number | null = null` → `private ownedTabId: string | null = null` to match the new `Tab.id` shape.

- [ ] **Step 6: Remove the "claude --dangerously-skip-permissions" string from tab-inject**

That's a Claude-Code-specific command — should be set by `ClaudeCodeBrain`, not `tab-inject`. Add a `brainCommand` parameter to whatever class owns `spawnBrainTab` (out of scope refactor — note as TODO for Plan 1, where brain backends are split).

- [ ] **Step 7: Re-run test — expect PASS** + full `bun test` suite green

---

## Task 9: Remove kitty from `DEFAULT_CONFIG` and tier presets

**Files:**
- Modify: `src/config.ts:19, 55, 61`
- Modify: `src/backends/tiers.ts:13` (and any other tier preset with `terminal:`)

- [ ] **Step 1: Write the test**

Create `tests/config-no-kitty-default.test.ts`:

```ts
import { test, expect } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";

test("DEFAULT_CONFIG.terminal is 'auto'", () => {
  expect(DEFAULT_CONFIG.terminal).toBe("auto");
});

test("DEFAULT_CONFIG.servers contains no kitty CLI strings", () => {
  const json = JSON.stringify(DEFAULT_CONFIG);
  expect(json.includes("kitty @")).toBe(false);
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Update `DEFAULT_CONFIG`**

In `src/config.ts:19`: `terminal: "auto"`.

In `src/config.ts:55, 61` (or wherever `kitty @ focus-tab` and `kitty @ ls` strings live): delete them. These shell commands belong inside `KittyAdapter`, not the runtime config.

- [ ] **Step 4: Update tier presets**

In `src/backends/tiers.ts`, remove `terminal: "kitty"` from every tier preset. Let it fall through to `DEFAULT_CONFIG.terminal = "auto"`.

- [ ] **Step 5: Update `types.ts:10`**

```ts
terminal: "auto" | "kitty" | "iterm2" | "wezterm" | "tmux" | "none";
```

(`"iterm2"` stays in the union as a placeholder; adapter implementation deferred.)

- [ ] **Step 6: Re-run test — expect PASS**

---

## Task 10: Health checks via adapter

**Files:**
- Modify: `src/index.ts:92, 106`

- [ ] **Step 1: Write the test**

Add to existing health-check test (or create `tests/index-health-uses-adapter.test.ts`):

```ts
test("brain-tab health uses adapter.health(), not literal kitty", () => {
  const src = readFileSync("src/index.ts", "utf8");
  expect(src.includes('"kitty"')).toBe(false);
  expect(src.includes("kitty @ ls")).toBe(false);
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Replace the inline `kitty @ ls` health check**

At `src/index.ts:92`, replace:

```ts
const proc = Bun.spawn(["kitty", "@", "ls"], { stdout: "pipe", stderr: "ignore" });
```

with:

```ts
const adapter = createTerminalAdapter(config);
const { ok, reason } = await adapter.health();
checks.push({
  name: "Terminal",
  status: ok ? "✓ available" : `✗ ${reason ?? "unavailable"}`,
});
```

Remove the hardcoded "kitty not available" message at line 106.

- [ ] **Step 4: Re-run test — expect PASS** + full suite green

---

## Task 11: Documentation

**Files:**
- Modify: `README.md` (if it mentions kitty as a hard requirement)
- Modify: `docs/model-recommendations-may-2026.md` is unaffected
- Create: `docs/superpowers/terminal-adapters.md` (~150 words)

- [ ] **Step 1: Document the adapter contract**

In a new file `docs/superpowers/terminal-adapters.md`, document the 8-method `TerminalAdapter` contract, the `SpawnTabOptions` shape, the auto-detection rules, and the headless mode. One short example showing how to add an iTerm2 adapter for someone who wants it next.

- [ ] **Step 2: Update README**

If the README says "kitty is required," soften to "kitty, tmux, or WezTerm — Cicero auto-detects. Set `terminal: none` for headless mode."

- [ ] **Step 3: Run linter / format / final test**

`bun test` — all green. Commit.

---

## Acceptance checklist

- [ ] `grep -rn "kitty" src/` returns matches **only** inside `src/terminal/kitty.ts` and `src/terminal/detect.ts` (env var name)
- [ ] `bun test` — full suite passes, no new failures
- [ ] Running `cicero` with `terminal: "auto"` inside a tmux session uses TmuxAdapter
- [ ] Running `cicero` with `terminal: "auto"` inside kitty uses KittyAdapter
- [ ] Running `cicero` with `terminal: "none"` starts cleanly with no terminal integration
- [ ] Adding a new terminal (e.g., iTerm2) requires *only* creating `src/terminal/iterm2.ts` and adding the switch case
