import type { SystemFacts } from "../../src/setup/system";

const GIB = 1024 ** 3;
const disks = { checkout: { path: "/fixture/repo", freeBytes: 100 * GIB }, huggingface: { path: "/fixture/.cache/huggingface", freeBytes: 100 * GIB } };

/** Deterministic machines for setup tests: the spec's worked examples plus CPU. */
export function fixtureSystem(kind: "cuda24" | "cuda16" | "mac32" | "mac64" | "cpu"): SystemFacts {
  if (kind === "cuda24" || kind === "cuda16") {
    const totalMiB = kind === "cuda24" ? 24576 : 16384;
    return {
      platform: "linux", arch: "x64", release: "6.8", appleSilicon: false, mlxSupported: false,
      ramTotalBytes: 64 * GIB, ramFreeBytes: 32 * GIB, disks,
      gpu: { status: "ok", name: "Fixture GPU", freeMiB: totalMiB, totalMiB, doctorDetail: "fixture" },
      recommendedTier: "local-cuda", reason: "fixture",
    };
  }
  if (kind === "mac32" || kind === "mac64") {
    return {
      platform: "darwin", arch: "arm64", release: "24.0.0", appleSilicon: true, mlxSupported: true,
      ramTotalBytes: (kind === "mac32" ? 32 : 64) * GIB, ramFreeBytes: 8 * GIB, disks,
      gpu: { status: "absent" }, recommendedTier: "local-mlx", reason: "fixture",
    };
  }
  return {
    platform: "linux", arch: "x64", release: "6.8", appleSilicon: false, mlxSupported: false,
    ramTotalBytes: 16 * GIB, ramFreeBytes: 8 * GIB, disks, gpu: { status: "absent" }, recommendedTier: "local-cpu", reason: "fixture",
  };
}
