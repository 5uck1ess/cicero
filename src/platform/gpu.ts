import { runBoundedCommand, type BoundedCommandOptions, type BoundedCommandResult } from "../process/bounded-command";

export type GpuCommandRunner = (command: readonly string[], options?: BoundedCommandOptions) => Promise<BoundedCommandResult>;

export type GpuProbe =
  | { status: "absent" }
  | { status: "timeout" }
  | { status: "empty" }
  | { status: "ok"; name: string; freeMiB: number; totalMiB: number; doctorDetail: string };

/** A single bounded nvidia-smi probe shared by doctor and guided setup. */
export async function probeNvidiaGpu(options: {
  which?: (binary: string) => string | null;
  runCommand?: GpuCommandRunner;
  includeTotal?: boolean;
} = {}): Promise<GpuProbe> {
  const binary = (options.which ?? ((name) => Bun.which(name)))("nvidia-smi");
  if (!binary) return { status: "absent" };
  try {
    const result = await (options.runCommand ?? runBoundedCommand)([
      binary, options.includeTotal === false ? "--query-gpu=name,memory.free" : "--query-gpu=name,memory.free,memory.total", "--format=csv,noheader",
    ], {
      timeoutMs: 3_000,
      stdoutLimitBytes: 8 * 1024,
      stderrLimitBytes: 1024,
      totalLimitBytes: 9 * 1024,
      outputLimitBehavior: "error",
    });
    const line = result.exitCode === 0 ? result.stdout.text.trim().split("\n")[0]?.trim() : undefined;
    if (!line) return { status: "empty" };
    // Preserve doctor's former name + free-memory display byte-for-byte.
    const lastComma = line.lastIndexOf(",");
    const doctorDetail = options.includeTotal === false || lastComma < 0 ? line : line.slice(0, lastComma);
    const match = line.match(/^(.*),\s*(\d+)\s*MiB,\s*(\d+)\s*MiB$/i);
    if (!match) return { status: "ok", name: doctorDetail, freeMiB: 0, totalMiB: 0, doctorDetail };
    return { status: "ok", name: match[1]!.trim(), freeMiB: Number(match[2]), totalMiB: Number(match[3]), doctorDetail };
  } catch {
    return { status: "timeout" };
  }
}
