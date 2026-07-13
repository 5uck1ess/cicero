import { test, expect, describe } from "bun:test";
import {
  TmuxAdapter,
  tmuxSendKeyArgs,
  tmuxSendTextArgs,
  tmuxWindowTarget,
} from "../../src/terminal/tmux";
import type { TerminalCommandExecutor } from "../../src/terminal/command";

describe("TmuxAdapter", () => {
  test("parseTmuxOutput parses tab list correctly", () => {
    const adapter = new TmuxAdapter();
    const raw = "1\tcode\t1\t/home/user/project\n2\tbrain\t0\t/home/user\n";
    const tabs = adapter.parseTmuxOutput(raw);
    expect(tabs).toHaveLength(2);
    expect(tabs[0].title).toBe("code");
    expect(tabs[0].is_focused).toBe(true);
    expect(tabs[1].title).toBe("brain");
    expect(tabs[1].is_focused).toBe(false);
  });

  test("parseTmuxOutput handles empty output", () => {
    const adapter = new TmuxAdapter();
    const tabs = adapter.parseTmuxOutput("");
    expect(tabs).toHaveLength(0);
  });

  test("addresses opaque numeric window ids with @ rather than index syntax", async () => {
    const calls: string[][] = [];
    const execute: TerminalCommandExecutor = (args) => {
      calls.push(args);
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    };
    const adapter = new TmuxAdapter(execute);

    await adapter.sendText("0", "hello");
    await adapter.sendKey("0", "escape");

    expect(tmuxWindowTarget("0")).toBe("@0");
    expect(() => tmuxWindowTarget("brain")).toThrow("session id is required");
    expect(tmuxWindowTarget("brain", "$7")).toBe("$7:brain");
    expect(calls).toEqual([
      tmuxSendTextArgs("0", "hello"),
      tmuxSendKeyArgs("0", "escape"),
    ]);
    expect(calls[0]).toEqual(["tmux", "send-keys", "-t", "@0", "-l", "hello"]);
    expect(calls[1]).toEqual(["tmux", "send-keys", "-t", "@0", "Escape"]);
  });

  test("session-qualifies a window-name fallback using the current pane", async () => {
    const calls: string[][] = [];
    const execute: TerminalCommandExecutor = (args) => {
      calls.push(args);
      if (args[1] === "display-message") {
        return Promise.resolve({ stdout: "$3\n", stderr: "", exitCode: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    };
    const adapter = new TmuxAdapter(execute, "%42");

    await adapter.sendText("brain", "hello");
    await adapter.sendKey("brain", "escape");

    expect(calls).toEqual([
      ["tmux", "display-message", "-p", "-t", "%42", "#{session_id}"],
      ["tmux", "send-keys", "-t", "$3:brain", "-l", "hello"],
      ["tmux", "send-keys", "-t", "$3:brain", "Escape"],
    ]);
  });

  test("rejects an invalid current-session response before sending to a name", async () => {
    const calls: string[][] = [];
    const execute: TerminalCommandExecutor = (args) => {
      calls.push(args);
      return Promise.resolve({ stdout: "not-a-session\n", stderr: "", exitCode: 0 });
    };
    const adapter = new TmuxAdapter(execute, "%42");

    await expect(adapter.sendText("brain", "hello")).rejects.toThrow(
      "invalid session id",
    );
    expect(calls).toHaveLength(1);
  });
});
