import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandAbortError,
  CommandDeadlineError,
  CommandOutputLimitError,
  runBoundedCommand,
} from "../../src/process/bounded-command";

const BUN = process.execPath;

async function rejection<T extends Error>(promise: Promise<unknown>, kind: abstract new (...args: never[]) => T): Promise<T> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(kind);
    return error as T;
  }
  throw new Error(`expected ${kind.name}`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runBoundedCommand", () => {
  test("writes bounded stdin and closes the child pipe", async () => {
    const result = await runBoundedCommand(
      [BUN, "-e", "const input = await Bun.stdin.bytes(); process.stdout.write(String(input.byteLength) + ':' + new TextDecoder().decode(input));"],
      { stdin: new TextEncoder().encode("hello"), stdinLimitBytes: 5 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.text).toBe("5:hello");
  });

  test("rejects oversized stdin before spawning", async () => {
    await expect(runBoundedCommand(
      [BUN, "-e", "process.stdout.write('spawned')"],
      { stdin: "too large", stdinLimitBytes: 3 },
    )).rejects.toThrow("3-byte input limit");
  });

  test("infinite stdout crosses the cap, terminates, and is reaped", async () => {
    const error = await rejection(
      runBoundedCommand(
        [BUN, "-e", `const chunk = "x".repeat(4096); while (true) process.stdout.write(chunk);`],
        {
          timeoutMs: 2_000,
          terminateGraceMs: 20,
          stdoutLimitBytes: 8_192,
          stderrLimitBytes: 128,
          totalLimitBytes: 16_384,
          outputLimitBehavior: "error",
        },
      ),
      CommandOutputLimitError,
    );

    expect(error.scope).toBe("stdout");
    expect(error.result.stdout.receivedBytes).toBeGreaterThan(8_192);
    expect(error.result.stdout.capturedBytes).toBe(8_192);
    expect(error.result.stdout.truncated).toBe(true);
    expect(error.result.exitCode).not.toBe(-1);
    expect(error.result.durationMs).toBeLessThan(1_000);
  });

  test("stderr flood is drained concurrently, bounded, and retains its head and tail", async () => {
    const result = await runBoundedCommand(
      [BUN, "-e", `process.stderr.write("BEGIN-" + "e".repeat(256_000) + "-END"); process.stdout.write("ok");`],
      {
        timeoutMs: 2_000,
        stdoutLimitBytes: 16,
        stderrLimitBytes: 64,
        totalLimitBytes: 80,
        outputLimitBehavior: "truncate",
        stderrCapture: "head-tail",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.text).toBe("ok");
    expect(result.stderr.text.startsWith("BEGIN-")).toBe(true);
    expect(result.stderr.text.endsWith("-END")).toBe(true);
    expect(result.stderr.receivedBytes).toBeGreaterThan(250_000);
    expect(result.stderr.capturedBytes).toBe(64);
    expect(result.stderr.truncated).toBe(true);
  });

  test("separate stream caps and the cumulative retained-byte cap are explicit", async () => {
    const separate = await runBoundedCommand(
      [BUN, "-e", `process.stdout.write("abcdefgh"); process.stderr.write("12345678");`],
      {
        timeoutMs: 2_000,
        stdoutLimitBytes: 4,
        stderrLimitBytes: 3,
        totalLimitBytes: 20,
        outputLimitBehavior: "truncate",
        stderrCapture: "tail",
      },
    );
    expect(separate.stdout).toMatchObject({ text: "abcd", receivedBytes: 8, capturedBytes: 4, truncated: true });
    expect(separate.stderr).toMatchObject({ text: "678", receivedBytes: 8, capturedBytes: 3, truncated: true });

    const cumulative = await runBoundedCommand(
      [BUN, "-e", `process.stdout.write("abcd"); setTimeout(() => process.stderr.write("wxyz"), 20);`],
      {
        timeoutMs: 2_000,
        stdoutLimitBytes: 8,
        stderrLimitBytes: 8,
        totalLimitBytes: 6,
        outputLimitBehavior: "truncate",
        stderrCapture: "tail",
      },
    );
    expect(cumulative.stdout.text).toBe("abcd");
    expect(cumulative.stderr.text).toBe("yz");
    expect(cumulative.stderr.truncated).toBe(true);
    expect(cumulative.combined).toMatchObject({ receivedBytes: 8, capturedBytes: 6, limitBytes: 6, truncated: true });

    const combinedError = await rejection(
      runBoundedCommand(
        [BUN, "-e", `process.stdout.write("abcd"); process.stderr.write("wxyz"); setInterval(() => {}, 1_000);`],
        {
          timeoutMs: 2_000,
          terminateGraceMs: 20,
          stdoutLimitBytes: 8,
          stderrLimitBytes: 8,
          totalLimitBytes: 6,
          outputLimitBehavior: "error",
        },
      ),
      CommandOutputLimitError,
    );
    expect(combinedError.scope).toBe("combined");
    expect(combinedError.result.combined.capturedBytes).toBe(6);
  });

  test("a never-exiting command hits one absolute wall deadline", async () => {
    const error = await rejection(
      runBoundedCommand([BUN, "-e", `setInterval(() => {}, 1_000);`], {
        timeoutMs: 80,
        terminateGraceMs: 20,
      }),
      CommandDeadlineError,
    );

    expect(error.result.exitCode).not.toBe(-1);
    expect(error.result.durationMs).toBeGreaterThanOrEqual(70);
    expect(error.result.durationMs).toBeLessThan(750);
  });

  test("AbortSignal cancels active work and waits for reaping", async () => {
    const controller = new AbortController();
    const running = runBoundedCommand([BUN, "-e", `setInterval(() => {}, 1_000);`], {
      signal: controller.signal,
      timeoutMs: 2_000,
      terminateGraceMs: 20,
    });
    setTimeout(() => controller.abort(new Error("test cancellation")), 50);

    const error = await rejection(running, CommandAbortError);
    expect(error.result.exitCode).not.toBe(-1);
    expect(error.result.durationMs).toBeLessThan(750);
  });

  test.skipIf(process.platform === "win32")("TERM-resistant descendants receive KILL and do not survive", async () => {
    const childSource = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);`;
    const parentSource = [
      `const child = Bun.spawn([${JSON.stringify(BUN)}, "-e", ${JSON.stringify(childSource)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
      `process.stdout.write(String(child.pid) + "\\n");`,
      `process.on("SIGTERM", () => {});`,
      `setInterval(() => {}, 1_000);`,
    ].join("\n");

    const error = await rejection(
      runBoundedCommand([BUN, "-e", parentSource], {
        timeoutMs: 120,
        terminateGraceMs: 40,
        stdoutLimitBytes: 128,
      }),
      CommandDeadlineError,
    );
    const childPid = Number.parseInt(error.result.stdout.text.trim(), 10);
    expect(Number.isInteger(childPid)).toBe(true);
    expect(processExists(childPid)).toBe(false);
    expect(error.result.durationMs).toBeGreaterThanOrEqual(150);
    expect(error.result.durationMs).toBeLessThan(1_000);
  });

  test.skipIf(process.platform === "win32")("deadline still owns descendants that hold pipes after the parent exits", async () => {
    const childSource = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);`;
    const parentSource = [
      `const child = Bun.spawn([${JSON.stringify(BUN)}, "-e", ${JSON.stringify(childSource)}], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });`,
      `process.stdout.write(String(child.pid) + "\\n");`,
    ].join("\n");

    const error = await rejection(
      runBoundedCommand([BUN, "-e", parentSource], {
        timeoutMs: 100,
        terminateGraceMs: 30,
        stdoutLimitBytes: 128,
      }),
      CommandDeadlineError,
    );
    const childPid = Number.parseInt(error.result.stdout.text.trim(), 10);
    expect(processExists(childPid)).toBe(false);
  });

  test.skipIf(process.platform === "win32")("successful root exit still reaps a stdio-detached background child", async () => {
    const result = await runBoundedCommand([
      "/bin/sh",
      "-c",
      "sleep 100 </dev/null >/dev/null 2>&1 & echo $!",
    ], {
      timeoutMs: 2_000,
      terminateGraceMs: 30,
      stdoutLimitBytes: 128,
    });
    const childPid = Number.parseInt(result.stdout.text.trim(), 10);
    expect(result.exitCode).toBe(0);
    expect(Number.isInteger(childPid)).toBe(true);
    expect(processExists(childPid)).toBe(false);
  });

  test.skipIf(process.platform === "win32")("the explicit launcher opt-out releases inherited pipes and preserves the child", async () => {
    const pidFile = join(tmpdir(), `cicero-background-${process.pid}-${crypto.randomUUID()}.pid`);
    let childPid = 0;
    try {
      const result = await runBoundedCommand([
        "/bin/sh",
        "-c",
        'sleep 100 & echo $! > "$PID_FILE"',
      ], {
        env: { ...process.env, PID_FILE: pidFile },
        timeoutMs: 500,
        allowBackgroundOnSuccess: true,
      });
      childPid = Number.parseInt(await Bun.file(pidFile).text(), 10);
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBeLessThan(400);
      expect(processExists(childPid)).toBe(true);
    } finally {
      if (childPid > 0) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already exited */ }
      }
      try { unlinkSync(pidFile); } catch { /* test cleanup */ }
    }
  });

  test.skipIf(process.platform === "win32")("a failed launcher still reaps its background child and retains diagnostics", async () => {
    let childPid = 0;
    try {
      const result = await runBoundedCommand([
        "/bin/sh",
        "-c",
        "sleep 100 & echo $!; echo launcher-failed >&2; exit 7",
      ], {
        timeoutMs: 2_000,
        terminateGraceMs: 30,
        allowBackgroundOnSuccess: true,
      });
      childPid = Number.parseInt(result.stdout.text.trim(), 10);
      expect(result.exitCode).toBe(7);
      expect(result.stderr.text).toContain("launcher-failed");
      expect(Number.isInteger(childPid)).toBe(true);
      expect(processExists(childPid)).toBe(false);
    } finally {
      if (childPid > 0) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already exited */ }
      }
    }
  });
});
