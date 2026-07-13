# Terminal Adapters

Cicero talks to your terminal through a `TerminalAdapter` (`src/types.ts`). Tab management, brain-tab spawning, and screen scraping all go through this interface — no other code knows which terminal is running.

## The contract

```ts
interface TerminalAdapter {
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

`Tab.id` is an **opaque string handle** — each adapter encodes its native handle (kitty window id, tmux window id, wezterm pane id) however it likes. Nothing outside the adapter parses it.

`SpawnTabOptions`: `{ title, cwd?, command?, env?, keepFocus? }`. If `command` is set, the adapter spawns the tab then injects the command.

## Selection & auto-detection

Config `terminal` accepts: `auto` (default) | `kitty` | `tmux` | `wezterm` | `none`.

`auto` runs `detectTerminal()` (`src/terminal/detect.ts`), which checks env vars in priority order: `$TMUX` → tmux, `$KITTY_WINDOW_ID` → kitty, `$WEZTERM_PANE` → wezterm, else `none`.

`none` uses `NullTerminalAdapter` — every method is a safe no-op. Use it for headless/server deployments with subprocess, ACP, or HTTP brains. Claude `tab-inject` deliberately fails fast with this adapter because no interactive tab can exist.

## Adding a new terminal (e.g. iTerm2)

1. Create `src/terminal/iterm2.ts` implementing the 8-method contract.
2. Add a `case "iterm2": return new ITerm2Adapter();` to `createTerminalAdapter` (`src/terminal/index.ts`).
3. (Optional) add an env probe to `detectTerminal` so `auto` finds it.

That's the entire surface — no other file changes.
