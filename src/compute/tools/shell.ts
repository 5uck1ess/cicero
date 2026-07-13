import type { Tool } from "../tool";
import {
  BoundedCommandError,
  CommandAbortError,
  CommandDeadlineError,
  runBoundedCommand,
} from "../../process/bounded-command";

const SHELL_TIMEOUT_MS = 30_000;
const SHELL_STREAM_LIMIT_BYTES = 4_000;
const SHELL_TOTAL_LIMIT_BYTES = 8_000;
const TOOL_OUTPUT_CHARS = 4_000;

export const shellTool: Tool = {
  name: "shell",
  description: "run a shell command and return its output",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  async run(args, context) {
    const command = String(args.command ?? "").trim();
    if (!command) return { ok: false, output: "empty command" };
    try {
      const result = await runBoundedCommand(["/bin/sh", "-c", command], {
        signal: context?.signal,
        timeoutMs: SHELL_TIMEOUT_MS,
        stdoutLimitBytes: SHELL_STREAM_LIMIT_BYTES,
        stderrLimitBytes: SHELL_STREAM_LIMIT_BYTES,
        totalLimitBytes: SHELL_TOTAL_LIMIT_BYTES,
        outputLimitBehavior: "truncate",
      });
      const raw = (result.stdout.text + result.stderr.text).trim();
      const wasTruncated = result.stdout.truncated || result.stderr.truncated || raw.length > TOOL_OUTPUT_CHARS;
      const output = wasTruncated
        ? `${raw.slice(0, TOOL_OUTPUT_CHARS - 20).trimEnd()}\n[output truncated]`
        : raw;
      return { ok: result.exitCode === 0, output: output || `(exit ${result.exitCode})` };
    } catch (error) {
      if (error instanceof CommandAbortError) throw error;
      if (error instanceof CommandDeadlineError) {
        return { ok: false, output: `command timed out after ${SHELL_TIMEOUT_MS}ms` };
      }
      if (error instanceof BoundedCommandError) {
        return { ok: false, output: error.message };
      }
      throw error;
    }
  },
};
