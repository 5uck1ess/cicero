import { describe, expect, test } from "bun:test";
import { detectSystem, recommendTier } from "../../src/setup/system";
import { probeNvidiaGpu } from "../../src/platform/gpu";
import type { BoundedCommandResult } from "../../src/process/bounded-command";

function result(text: string, exitCode = 0): BoundedCommandResult {
  const output = { text, receivedBytes: text.length, capturedBytes: text.length, limitBytes: 8192, truncated: false };
  return { command: [], exitCode, durationMs: 1, stdout: output, stderr: { ...output, text: "" }, combined: { receivedBytes: text.length, capturedBytes: text.length, limitBytes: 9216, truncated: false } };
}

const disk = () => ({ bavail: 1000, bsize: 4096 }) as ReturnType<typeof import("node:fs")["statfsSync"]>;
const base = { homeDir: () => "/fixture", checkout: "/fixture/repo", exists: () => true, statfs: disk, totalmem: () => 32e9, freemem: () => 16e9 };

describe("setup system facts", () => {
  test("detects CUDA GPU, RAM, and both disk locations", async () => {
    let query: readonly string[] = [];
    const facts = await detectSystem({ ...base, platform: () => "linux", arch: () => "x64", release: () => "6.8", which: () => "/fixture/nvidia-smi", runCommand: async (command) => { query = command; return result("RTX 3090, 20000 MiB, 24576 MiB\n"); } });
    expect(query[1]).toBe("--query-gpu=name,memory.free,memory.total");
    expect(facts.gpu).toMatchObject({ status: "ok", name: "RTX 3090", freeMiB: 20000, totalMiB: 24576 });
    expect(facts.recommendedTier).toBe("local-cuda");
    expect(facts.gpuWarning).toBeUndefined();
    expect(facts.disks.checkout.freeBytes).toBe(4096000);
    expect(facts.disks.huggingface.path).toBe("/fixture/.cache/huggingface");
  });
  test("a 24 GB GPU remains CUDA-capable when other processes leave only 5.4 GB free", async () => {
    const facts = await detectSystem({ ...base, platform: () => "linux", arch: () => "x64", release: () => "6.8", which: () => "/fixture/nvidia-smi", runCommand: async () => result("RTX 3090, 5485 MiB, 24576 MiB\n") });
    expect(facts.recommendedTier).toBe("local-cuda");
    expect(facts.reason).toContain("24576 MiB total VRAM");
    expect(facts.gpuWarning).toContain("Only 5.4 GB free right now");
    expect(facts.gpuWarning).toContain("other processes are using the GPU");
  });
  test("Apple Silicon macOS 14 uses MLX", async () => {
    const facts = await detectSystem({ ...base, platform: () => "darwin", arch: () => "arm64", release: () => "23.0.0", which: () => null });
    expect(facts.appleSilicon).toBe(true);
    expect(facts.recommendedTier).toBe("local-mlx");
  });
  test("Windows, no GPU, and timed-out GPU use CPU", async () => {
    const windows = await detectSystem({ ...base, platform: () => "win32", arch: () => "x64", release: () => "10.0", which: () => null });
    expect(windows.recommendedTier).toBe("local-cpu");
    expect(await probeNvidiaGpu({ which: () => null })).toEqual({ status: "absent" });
    expect(await probeNvidiaGpu({ which: () => "nvidia-smi", runCommand: async () => { throw Error("deadline"); } })).toEqual({ status: "timeout" });
    expect(recommendTier({ platform: "linux", arch: "x64", mlxSupported: false, gpu: { status: "ok", name: "small", freeMiB: 4096, totalMiB: 6144, doctorDetail: "small, 4096 MiB" } }).tier).toBe("local-cpu");
  });
});
