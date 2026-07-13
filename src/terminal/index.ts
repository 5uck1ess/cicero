import type { RuntimeConfig } from "../config";
import type { TerminalAdapter } from "../types";
import { KittyAdapter } from "./kitty";
import { TmuxAdapter } from "./tmux";
import { WezTermAdapter } from "./wezterm";
import { NullTerminalAdapter } from "./null";
import { detectTerminal } from "./detect";
import type { TerminalCommandExecutor } from "./command";

export function createTerminalAdapter(
  config: RuntimeConfig,
  execute?: TerminalCommandExecutor,
): TerminalAdapter {
  switch (config.terminal) {
    case "auto":
      return createTerminalAdapter(
        { ...config, terminal: detectTerminal() } as RuntimeConfig,
        execute,
      );
    case "kitty":
      return new KittyAdapter(execute);
    case "tmux":
      return new TmuxAdapter(execute);
    case "wezterm":
      return new WezTermAdapter(execute);
    case "none":
      return new NullTerminalAdapter();
    default:
      return new NullTerminalAdapter();
  }
}
