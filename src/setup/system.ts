import { existsSync, statfsSync, type StatsFs } from "node:fs";
import { arch as osArch, freemem, homedir, platform as osPlatform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { TIER_PRESETS } from "../backends/tiers";
import { supportsCurrentMlx } from "../platform/python";
import { probeNvidiaGpu, type GpuCommandRunner, type GpuProbe } from "../platform/gpu";

export type Tier = "local-mlx" | "local-cuda" | "local-cpu";
export interface DiskFact { path: string; freeBytes: number | null }
export interface SystemFacts {
  platform: string;
  arch: string;
  release: string;
  appleSilicon: boolean;
  mlxSupported: boolean;
  ramTotalBytes: number;
  ramFreeBytes: number;
  disks: { checkout: DiskFact; huggingface: DiskFact };
  gpu: GpuProbe;
  recommendedTier: Tier;
  reason: string;
  gpuWarning?: string;
}

export interface SystemDeps {
  platform?: () => string;
  arch?: () => string;
  release?: () => string;
  totalmem?: () => number;
  freemem?: () => number;
  homeDir?: () => string;
  env?: Record<string, string | undefined>;
  checkout?: string;
  exists?: (path: string) => boolean;
  statfs?: (path: string) => StatsFs;
  which?: (binary: string) => string | null;
  runCommand?: GpuCommandRunner;
}

const CUDA_MIN_TOTAL_MIB = 8 * 1024;

export function recommendTier(facts: Pick<SystemFacts, "platform" | "arch" | "mlxSupported" | "gpu">): { tier: Tier; reason: string; warning?: string } {
  if (facts.platform === "darwin" && facts.arch === "arm64" && facts.mlxSupported) {
    return { tier: "local-mlx", reason: "Apple Silicon with macOS 14 or newer supports the MLX preset." };
  }
  if (facts.gpu.status === "ok" && facts.gpu.totalMiB >= CUDA_MIN_TOTAL_MIB) {
    return {
      tier: "local-cuda",
      reason: `${facts.gpu.name} has ${facts.gpu.totalMiB} MiB total VRAM, enough for the CUDA preset.`,
      ...(facts.gpu.freeMiB < CUDA_MIN_TOTAL_MIB
        ? { warning: `Only ${(facts.gpu.freeMiB / 1024).toFixed(1)} GB free right now — other processes are using the GPU. Free VRAM before starting Cicero.` }
        : {}),
    };
  }
  return { tier: "local-cpu", reason: "No compatible MLX host or NVIDIA GPU with at least 8192 MiB total VRAM was detected." };
}

function diskFact(path: string, deps: SystemDeps): DiskFact {
  const exists = deps.exists ?? existsSync;
  let target = path;
  try {
    while (!exists(target)) {
      const parent = dirname(target);
      if (parent === target) return { path, freeBytes: null };
      target = parent;
    }
    const fs = (deps.statfs ?? statfsSync)(target);
    return { path, freeBytes: Number(fs.bavail) * Number(fs.bsize) };
  } catch {
    return { path, freeBytes: null };
  }
}

export async function detectSystem(deps: SystemDeps = {}): Promise<SystemFacts> {
  const platform = (deps.platform ?? osPlatform)();
  const arch = (deps.arch ?? osArch)();
  const osRelease = (deps.release ?? release)();
  const gpu = await probeNvidiaGpu({ which: deps.which, runCommand: deps.runCommand });
  const mlxSupported = arch === "arm64" && supportsCurrentMlx(platform, osRelease);
  const recommendation = recommendTier({ platform, arch, mlxSupported, gpu });
  if (!(recommendation.tier in TIER_PRESETS)) throw new Error("recommended tier is unavailable");
  const home = (deps.homeDir ?? homedir)();
  const hfHome = (deps.env ? deps.env.HF_HOME : process.env.HF_HOME) ?? join(home, ".cache", "huggingface");
  const checkout = deps.checkout ?? dirname(dirname(import.meta.dir));
  return {
    platform, arch, release: osRelease, appleSilicon: platform === "darwin" && arch === "arm64", mlxSupported,
    ramTotalBytes: (deps.totalmem ?? totalmem)(), ramFreeBytes: (deps.freemem ?? freemem)(),
    disks: { checkout: diskFact(checkout, deps), huggingface: diskFact(hfHome, deps) },
    gpu, recommendedTier: recommendation.tier, reason: recommendation.reason, gpuWarning: recommendation.warning,
  };
}
