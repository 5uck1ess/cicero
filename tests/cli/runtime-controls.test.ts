import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startRuntimeControl } from "../../src/runtime-control";

const PROJECT_ROOT = dirname(dirname(import.meta.dir));

async function runCli(args: string[], env: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const processHandle = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } catch (error: unknown) {
    try {
      processHandle.kill(9);
    } catch {
      // The subprocess may already have exited while an output stream failed.
    }
    throw error;
  }
}

describe("runtime control CLI truthfulness", () => {
  test.each(["on", "off"])("tts %s fails instead of claiming it changed runtime state", async (state) => {
    const result = await runCli(["tts", state]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no authenticated runtime control channel");
    expect(result.stderr).toContain(`spoken command \"tts ${state}\"`);
    expect(result.stderr).not.toContain(state === "on" ? "TTS enabled" : "TTS disabled");
  });

  test("rejects an invalid TTS state", async () => {
    const result = await runCli(["tts", "maybe"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: cicero tts on|off");
  });

  test("restart-brain fails instead of claiming a restart", async () => {
    const result = await runCli(["restart-brain"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no authenticated runtime control channel");
    expect(result.stderr).toContain("spoken command \"restart brain\"");
    expect(result.stderr).not.toContain("Brain restart (requires running daemon)");
  });

  test("help does not advertise restart-brain as a working control", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("restart-brain");
    expect(result.stdout).toContain("Explain how to reset the Brain LLM session");
    expect(result.stdout).not.toContain("restart-brain              Reset the Brain LLM session");
  });

  test("help advertises live provider swapping", async () => {
    const result = await runCli(["swap", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("swap [options] <role> <backend> [model]");
    expect(result.stdout).toContain("persist only after readiness succeeds");
  });

  test("swap rejects unsupported backends before contacting the daemon", async () => {
    const result = await runCli(["swap", "stt", "imaginary"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unsupported STT backend 'imaginary'");
    expect(result.stderr).toContain("swap failed");
  });

  test("swap command reaches the authenticated daemon control and reports persisted success", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-swap-cli-"));
    const ciceroHome = join(home, ".cicero");
    mkdirSync(ciceroHome, { mode: 0o700 });
    const requests: unknown[] = [];
    const control = await startRuntimeControl({
      token: "test-token",
      descriptorPath: join(ciceroHome, "runtime-control.json"),
      onSwap: async (request) => {
        requests.push(request);
        return { ...request, status: "active" };
      },
    });

    try {
      const result = await runCli(["swap", "tts", "kokoro", "model-a"], { HOME: home });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("TTS active: kokoro (model-a). Config persisted.");
      expect(result.stderr).toBe("");
      expect(requests).toEqual([{ role: "tts", backend: "kokoro", model: "model-a" }]);
    } finally {
      await control.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
