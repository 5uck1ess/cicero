import type { TerminalAdapter, Tab, SpawnTabOptions } from "../types";
import {
  executeTerminalCommand,
  type TerminalCommandExecutor,
} from "./command";

export function tmuxWindowTarget(nameOrId: string, sessionId?: string): string {
  if (nameOrId.startsWith("@")) return nameOrId;
  if (/^\d+$/.test(nameOrId)) return `@${nameOrId}`;

  const qualifiedSessionId = sessionId?.trim();
  if (!qualifiedSessionId) {
    throw new Error(`tmux session id is required to address window name "${nameOrId}"`);
  }
  return `${qualifiedSessionId}:${nameOrId}`;
}

export function tmuxSendTextArgs(tab: string, text: string, sessionId?: string): string[] {
  return ["tmux", "send-keys", "-t", tmuxWindowTarget(tab, sessionId), "-l", text];
}

function normalizeTmuxKey(key: string): string {
  const normalized = key.toLowerCase();
  return normalized === "enter"
    ? "Enter"
    : normalized === "escape" || normalized === "esc"
      ? "Escape"
      : normalized === "ctrl-c"
        ? "C-c"
        : key;
}

export function tmuxSendKeyArgs(tab: string, key: string, sessionId?: string): string[] {
  return [
    "tmux",
    "send-keys",
    "-t",
    tmuxWindowTarget(tab, sessionId),
    normalizeTmuxKey(key),
  ];
}

export class TmuxAdapter implements TerminalAdapter {
  private sessionId: string | null = null;

  constructor(
    private readonly execute: TerminalCommandExecutor = executeTerminalCommand,
    private readonly tmuxPane: string | undefined = process.env.TMUX_PANE,
  ) {}

  private async resolveWindowTarget(nameOrId: string): Promise<string> {
    try {
      if (nameOrId.startsWith("@") || /^\d+$/.test(nameOrId)) {
        return tmuxWindowTarget(nameOrId);
      }
      return tmuxWindowTarget(nameOrId, await this.resolveSessionId());
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private async resolveSessionId(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    try {
      const args = ["tmux", "display-message", "-p"];
      if (this.tmuxPane) args.push("-t", this.tmuxPane);
      args.push("#{session_id}");
      const result = await this.execute(args, {
        captureStdout: true,
        label: "tmux resolve-session",
      });
      const sessionId = result.stdout.trim();
      if (!/^\$\d+$/.test(sessionId)) {
        throw new Error(`tmux returned an invalid session id: ${sessionId || "<empty>"}`);
      }
      this.sessionId = sessionId;
      return sessionId;
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async listTabs(): Promise<Tab[]> {
    try {
      const result = await this.execute(
        ["tmux", "list-windows", "-F", "#{window_id}\t#{window_name}\t#{window_active}\t#{pane_current_path}"],
        { captureStdout: true, label: "tmux list-windows" },
      );
      return this.parseTmuxOutput(result.stdout);
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  parseTmuxOutput(raw: string): Tab[] {
    return raw.trim().split("\n").filter(Boolean).map((line, idx) => {
      const [id, name, active, cwd] = line.split("\t");
      return {
        id: id?.replace("@", "") ?? String(idx),
        title: name ?? "",
        is_focused: active === "1",
        cwd: cwd ?? undefined,
      };
    });
  }

  async focusTab(nameOrId: string): Promise<void> {
    try {
      const target = await this.resolveWindowTarget(nameOrId);
      await this.execute(
        ["tmux", "select-window", "-t", target],
        { label: "tmux select-window" },
      );
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async sendText(tab: string, text: string): Promise<void> {
    try {
      const target = await this.resolveWindowTarget(tab);
      await this.execute(["tmux", "send-keys", "-t", target, "-l", text], {
        label: "tmux send-text",
      });
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async sendKey(tab: string, key: string): Promise<void> {
    try {
      const target = await this.resolveWindowTarget(tab);
      const args = ["tmux", "send-keys", "-t", target, normalizeTmuxKey(key)];
      await this.execute(args, { label: "tmux send-key" });
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async getText(tab: string, extent?: "screen" | "all" | "last_cmd_output"): Promise<string> {
    try {
      const target = await this.resolveWindowTarget(tab);
      const args = ["tmux", "capture-pane", "-t", target, "-p"];
      if (extent === "all") args.push("-S", "-");
      const result = await this.execute(args, { captureStdout: true, label: "tmux capture-pane" });
      return result.stdout;
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async spawnTab(opts: SpawnTabOptions): Promise<Tab> {
    try {
      const args = ["tmux", "new-window", "-P", "-F", "#{window_id}", "-n", opts.title];
      if (opts.cwd) args.push("-c", opts.cwd);
      if (opts.keepFocus) args.push("-d");

      const result = await this.execute(args, { captureStdout: true, label: "tmux new-window" });
      const id = result.stdout.trim().replace("@", "");

      if (opts.command) {
        // tmux scopes env at the session level; prefix inline for simplicity.
        const envPrefix = Object.entries(opts.env ?? {})
          .map(([k, v]) => `${k}=${v} `)
          .join("");
        await this.sendText(id, envPrefix + opts.command);
        await this.sendKey(id, "enter");
      }

      return { id, title: opts.title, is_focused: !opts.keepFocus, cwd: opts.cwd };
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async closeTab(id: string): Promise<void> {
    try {
      await this.execute(
        ["tmux", "kill-window", "-t", tmuxWindowTarget(id)],
        { label: "tmux kill-window" },
      );
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async health(): Promise<{ ok: boolean; reason?: string }> {
    if (!process.env.TMUX) {
      return { ok: false, reason: "no tmux session — start one with 'tmux new'" };
    }
    try {
      await this.execute(["tmux", "info"], { label: "tmux info", timeoutMs: 1_000 });
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, reason: err instanceof Error ? err.message : "tmux server not running" };
    }
  }
}
