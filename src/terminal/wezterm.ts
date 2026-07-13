import type { TerminalAdapter, Tab, SpawnTabOptions } from "../types";
import {
  executeTerminalCommand,
  type TerminalCommandExecutor,
} from "./command";

/**
 * WezTerm adapter via `wezterm cli`. Panes are the addressable unit; we treat
 * each pane as a "tab" and use its pane-id as the opaque handle.
 */
export class WezTermAdapter implements TerminalAdapter {
  constructor(private readonly execute: TerminalCommandExecutor = executeTerminalCommand) {}

  async listTabs(): Promise<Tab[]> {
    try {
      const result = await this.execute(["wezterm", "cli", "list", "--format", "json"], {
        captureStdout: true,
        label: "wezterm list panes",
      });
      return this.parseListOutput(result.stdout);
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  parseListOutput(raw: string): Tab[] {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = JSON.parse(raw);
    } catch {
      return [];
    }
    return rows.map((r) => ({
      id: String(r.pane_id ?? ""),
      title: String(r.title ?? r.tab_title ?? "untitled"),
      is_focused: r.is_active === true,
      cwd: typeof r.cwd === "string" ? r.cwd : undefined,
    }));
  }

  async focusTab(nameOrId: string): Promise<void> {
    const id = await this.resolvePaneId(nameOrId);
    if (!id) throw new Error(`WezTerm pane not found: "${nameOrId}"`);
    try {
      await this.execute(["wezterm", "cli", "activate-pane", "--pane-id", id], {
        label: "wezterm activate-pane",
      });
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async sendText(tab: string, text: string): Promise<void> {
    const id = await this.resolvePaneId(tab);
    if (!id) throw new Error(`WezTerm pane not found: "${tab}"`);
    try {
      await this.execute(
        ["wezterm", "cli", "send-text", "--pane-id", id, "--no-paste", text],
        { label: "wezterm send-text" },
      );
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async sendKey(tab: string, key: string): Promise<void> {
    // WezTerm has no dedicated key-event CLI; encode semantic control keys as
    // their terminal byte sequences instead of typing their names literally.
    const normalized = key.toLowerCase();
    const text = normalized === "enter"
      ? "\n"
      : normalized === "escape" || normalized === "esc"
        ? "\x1b"
        : normalized === "ctrl-c"
          ? "\x03"
          : key;
    const id = await this.resolvePaneId(tab);
    if (!id) throw new Error(`WezTerm pane not found: "${tab}"`);
    try {
      await this.execute(
        ["wezterm", "cli", "send-text", "--pane-id", id, "--no-paste", text],
        { label: "wezterm send-key" },
      );
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async getText(tab: string, _extent?: "screen" | "all" | "last_cmd_output"): Promise<string> {
    const id = await this.resolvePaneId(tab);
    if (!id) throw new Error(`WezTerm pane not found: "${tab}"`);
    try {
      const result = await this.execute(["wezterm", "cli", "get-text", "--pane-id", id], {
        captureStdout: true,
        label: "wezterm get-text",
      });
      return result.stdout;
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async spawnTab(opts: SpawnTabOptions): Promise<Tab> {
    const args = ["wezterm", "cli", "spawn", "--new-window"];
    if (opts.cwd) args.push("--cwd", opts.cwd);

    try {
      const result = await this.execute(args, { captureStdout: true, label: "wezterm spawn" });
      const id = result.stdout.trim();

      if (opts.command) {
        await Bun.sleep(1000);
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
      await this.execute(["wezterm", "cli", "kill-pane", "--pane-id", id], {
        label: "wezterm kill-pane",
      });
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async health(): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.execute(["wezterm", "cli", "list"], { label: "wezterm health", timeoutMs: 1_000 });
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, reason: err instanceof Error ? err.message : "wezterm CLI unavailable" };
    }
  }

  /** Resolve a title or pane-id to a concrete pane-id string. */
  private async resolvePaneId(nameOrId: string): Promise<string | null> {
    if (!isNaN(Number(nameOrId))) return nameOrId;
    const tabs = await this.listTabs();
    const lower = nameOrId.toLowerCase();
    const match = tabs.find(t => t.title.toLowerCase().includes(lower));
    return match?.id ?? null;
  }
}
