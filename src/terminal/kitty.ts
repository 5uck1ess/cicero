import type { TerminalAdapter, Tab, SpawnTabOptions } from "../types";
import {
  executeTerminalCommand,
  type TerminalCommandExecutor,
} from "./command";

export class KittyAdapter implements TerminalAdapter {
  constructor(private readonly execute: TerminalCommandExecutor = executeTerminalCommand) {}

  async listTabs(): Promise<Tab[]> {
    try {
      const result = await this.execute(["kitty", "@", "ls"], {
        captureStdout: true,
        label: "kitty list tabs",
      });
      const data = JSON.parse(result.stdout);
      const tabs: Tab[] = [];

      for (const osWindow of data) {
        for (const tab of osWindow.tabs || []) {
          const win = tab.windows?.[0];
          // Expose the kitty WINDOW id (used by send-text/send-key/get-text/focus)
          // as the opaque string handle.
          tabs.push({
            id: String(win?.id ?? tab.id),
            title: tab.title || "untitled",
            is_focused: tab.is_focused || false,
            cwd: win?.cwd,
          });
        }
      }

      return tabs;
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async focusTab(nameOrId: string): Promise<void> {
    // Tab-scoped commands accept a window_id selector, matching the opaque
    // window handle exposed by listTabs without risking a tab-id collision.
    const matchArg = isNaN(Number(nameOrId))
      ? `title:${nameOrId}`
      : `window_id:${nameOrId}`;

    try {
      await this.execute(["kitty", "@", "focus-tab", "--match", matchArg], {
        label: "kitty focus tab",
      });
    } catch {
      // Try fuzzy match on title — normalize by removing spaces/punctuation
      const tabs = await this.listTabs();
      const normalize = (s: string) => s.toLowerCase().replace(/[\s\-_]+/g, "");
      const needle = normalize(nameOrId);
      const match = tabs.find(t =>
        normalize(t.title).includes(needle) || needle.includes(normalize(t.title))
      );
      if (match) {
        await this.execute(["kitty", "@", "focus-tab", "--match", `window_id:${match.id}`], {
          label: "kitty focus tab",
        });
      } else {
        throw new Error(`No tab matching "${nameOrId}"`);
      }
    }
  }

  async sendText(windowId: string, text: string): Promise<void> {
    // send-text requires window ID for --match id:X
    const matchArg = isNaN(Number(windowId))
      ? `title:${windowId}`
      : `id:${windowId}`;

    try {
      await this.execute(["kitty", "@", "send-text", "--match", matchArg, text], {
        label: "kitty send-text",
      });
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async sendKey(windowId: string, key: string): Promise<void> {
    const matchArg = isNaN(Number(windowId))
      ? `title:${windowId}`
      : `id:${windowId}`;

    try {
      await this.execute(["kitty", "@", "send-key", "--match", matchArg, key], {
        label: "kitty send-key",
      });
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async getText(windowId: string, extent: "screen" | "all" | "last_cmd_output" = "screen"): Promise<string> {
    const matchArg = isNaN(Number(windowId))
      ? `title:${windowId}`
      : `id:${windowId}`;

    try {
      const result = await this.execute(
        ["kitty", "@", "get-text", "--match", matchArg, `--extent=${extent}`],
        { captureStdout: true, label: "kitty get-text" },
      );
      return result.stdout;
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async spawnTab(opts: SpawnTabOptions): Promise<Tab> {
    const args = [
      "kitty", "@", "launch",
      "--type=tab",
      `--tab-title=${opts.title}`,
    ];
    if (opts.keepFocus) args.push("--keep-focus");
    args.push(opts.cwd ? `--cwd=${opts.cwd}` : "--cwd=current");
    for (const [key, val] of Object.entries(opts.env ?? {})) {
      args.push("--env", `${key}=${val}`);
    }

    try {
      const result = await this.execute(args, { captureStdout: true, label: "kitty launch" });

      // kitty @ launch prints the new WINDOW id.
      const id = result.stdout.trim();

      if (opts.command) {
        // Give the shell a moment to initialize before injecting the command.
        await Bun.sleep(1500);
        await this.sendText(id, opts.command);
        await this.sendKey(id, "enter");
      }

      return { id, title: opts.title, is_focused: !opts.keepFocus, cwd: opts.cwd };
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async closeTab(id: string): Promise<void> {
    try {
      await this.execute(["kitty", "@", "close-tab", "--match", `window_id:${id}`], {
        label: "kitty close tab",
      });
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async health(): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.execute(["kitty", "@", "ls"], { label: "kitty health", timeoutMs: 1_000 });
      return { ok: true };
    } catch (err: unknown) {
      return {
        ok: false,
        reason: err instanceof Error
          ? err.message
          : "kitty remote control not available (enable allow_remote_control)",
      };
    }
  }
}
