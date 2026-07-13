import type { Tool } from "../tool";
import {
  BoundedCommandError,
  CommandAbortError,
  CommandDeadlineError,
  runBoundedCommand,
  type BoundedCommandResult,
} from "../../process/bounded-command";

const OPEN_TIMEOUT_MS = 15_000;
const OPEN_STREAM_LIMIT_BYTES = 16 * 1024;

type CommandRunner = (
  command: readonly string[],
  options: Parameters<typeof runBoundedCommand>[1],
) => Promise<BoundedCommandResult>;

export function openAppCommand(name: string, platform: NodeJS.Platform = process.platform): string[] {
  switch (platform) {
    case "darwin": return ["open", "-a", name];
    case "win32": return ["cmd", "/c", "start", "", name];
    default: return ["xdg-open", name];
  }
}

export function createOpenAppTool(
  runCommand: CommandRunner = runBoundedCommand,
  platform: NodeJS.Platform = process.platform,
): Tool {
  return {
    name: "open_app",
    description: "open an application or document by name",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async run(args, context) {
      const name = String(args.name ?? "").trim();
      if (!name) return { ok: false, output: "empty app name" };
      try {
        const result = await runCommand(openAppCommand(name, platform), {
          signal: context?.signal,
          timeoutMs: OPEN_TIMEOUT_MS,
          stdoutLimitBytes: OPEN_STREAM_LIMIT_BYTES,
          stderrLimitBytes: OPEN_STREAM_LIMIT_BYTES,
          totalLimitBytes: OPEN_STREAM_LIMIT_BYTES * 2,
          outputLimitBehavior: "truncate",
          stderrCapture: "head-tail",
          // Launchers intentionally return while the opened GUI application
          // keeps running. This is the narrow product-supported exception to
          // normal successful-exit descendant cleanup.
          allowBackgroundOnSuccess: true,
        });
        if (result.exitCode === 0) return { ok: true, output: `opened ${name}` };
        const stderr = result.stderr.text.trim();
        return { ok: false, output: stderr || `failed to open ${name} (exit ${result.exitCode})` };
      } catch (error: unknown) {
        if (error instanceof CommandAbortError) throw error;
        if (error instanceof CommandDeadlineError) {
          return { ok: false, output: `opening ${name} timed out after ${OPEN_TIMEOUT_MS}ms` };
        }
        if (error instanceof BoundedCommandError) return { ok: false, output: error.message };
        throw error;
      }
    },
  };
}

export const openAppTool: Tool = createOpenAppTool();
