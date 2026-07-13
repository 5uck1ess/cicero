import { expect, test } from "bun:test";
import { KittyAdapter } from "../src/terminal/kitty";
import { TmuxAdapter } from "../src/terminal/tmux";
import { WezTermAdapter } from "../src/terminal/wezterm";
import {
  executeTerminalCommand,
  type TerminalCommandExecutor,
} from "../src/terminal/command";

test("terminal adapters surface send command failures", async () => {
  const fail: TerminalCommandExecutor = () => Promise.reject(new Error("remote command failed"));

  await expect(new KittyAdapter(fail).sendKey("7", "escape")).rejects.toThrow("remote command failed");
  await expect(new TmuxAdapter(fail).sendKey("7", "escape")).rejects.toThrow("remote command failed");
  await expect(new WezTermAdapter(fail).sendKey("7", "escape")).rejects.toThrow("remote command failed");
});

test("Kitty tab operations match the exposed window id without tab-id collisions", async () => {
  const calls: string[][] = [];
  const execute: TerminalCommandExecutor = (args) => {
    calls.push(args);
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  };
  const adapter = new KittyAdapter(execute);

  await adapter.focusTab("7");
  await adapter.closeTab("7");

  expect(calls).toEqual([
    ["kitty", "@", "focus-tab", "--match", "window_id:7"],
    ["kitty", "@", "close-tab", "--match", "window_id:7"],
  ]);
});

test("default terminal command execution reports nonzero exit and stderr", async () => {
  await expect(executeTerminalCommand(
    [process.execPath, "-e", "console.error('terminal boom'); process.exit(7)"],
    { label: "test terminal command" },
  )).rejects.toThrow("test terminal command failed with exit code 7: terminal boom");
});

test("default terminal command execution kills commands at the deadline", async () => {
  await expect(executeTerminalCommand(
    [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
    { label: "hung terminal command", timeoutMs: 10 },
  )).rejects.toThrow("hung terminal command timed out after 10ms");
});
