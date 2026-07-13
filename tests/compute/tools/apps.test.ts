import { test, expect } from "bun:test";
import { createOpenAppTool, openAppCommand } from "../../../src/compute/tools/apps";
import type { BoundedCommandOptions, BoundedCommandResult } from "../../../src/process/bounded-command";

test("open command is platform-correct", () => {
  expect(openAppCommand("Safari", "darwin")).toEqual(["open", "-a", "Safari"]);
  expect(openAppCommand("notepad", "win32")).toEqual(["cmd", "/c", "start", "", "notepad"]);
  expect(openAppCommand("gedit", "linux")).toEqual(["xdg-open", "gedit"]);
});

test("open_app uses bounded cancellation while explicitly preserving the launched GUI", async () => {
  const controller = new AbortController();
  let capturedCommand: readonly string[] = [];
  let capturedOptions: BoundedCommandOptions | undefined;
  const result: BoundedCommandResult = {
    command: [],
    exitCode: 0,
    durationMs: 1,
    stdout: { text: "", receivedBytes: 0, capturedBytes: 0, limitBytes: 16_384, truncated: false },
    stderr: { text: "", receivedBytes: 0, capturedBytes: 0, limitBytes: 16_384, truncated: false },
    combined: { receivedBytes: 0, capturedBytes: 0, limitBytes: 32_768, truncated: false },
  };
  const tool = createOpenAppTool(async (command, options) => {
    capturedCommand = command;
    capturedOptions = options;
    return result;
  }, "linux");

  expect(await tool.run({ name: "gedit" }, { signal: controller.signal })).toEqual({ ok: true, output: "opened gedit" });
  expect(capturedCommand).toEqual(["xdg-open", "gedit"]);
  expect(capturedOptions!.signal).toBe(controller.signal);
  expect(capturedOptions!.allowBackgroundOnSuccess).toBe(true);
  expect(capturedOptions!.timeoutMs).toBe(15_000);
});
