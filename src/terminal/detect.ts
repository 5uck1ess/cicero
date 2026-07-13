import type { CiceroConfig } from "../types";

type TerminalKind = CiceroConfig["terminal"];

/**
 * Detect the active terminal from environment variables. Returns a concrete
 * adapter kind that `createTerminalAdapter` accepts (never "auto"). Falls back
 * to "none" (headless) when nothing recognizable is present.
 */
export function detectTerminal(env: Record<string, string | undefined> = process.env): Exclude<TerminalKind, "auto"> {
  if (env.TMUX) return "tmux";
  if (env.KITTY_WINDOW_ID) return "kitty";
  if (env.WEZTERM_PANE) return "wezterm";
  // $ITERM_SESSION_ID → iterm2 adapter not implemented yet; fall through.
  return "none";
}
