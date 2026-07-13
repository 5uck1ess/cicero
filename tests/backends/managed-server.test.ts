import { test, expect, describe } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  startManagedServer,
  stopManagedServer,
  type ManagedProcess,
} from "../../src/backends/managed-server";

async function unusedPort(): Promise<number> {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  try {
    return reservation.port;
  } finally {
    await Promise.resolve(reservation.stop(true));
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await Bun.sleep(20);
    }
    return await predicate();
  } catch {
    return false;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("startManagedServer", () => {
  test("returns unmanaged process if port is already healthy", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = server.port;
    const result = await startManagedServer({
      name: "test", port, command: ["echo", "noop"],
      healthUrl: `http://localhost:${port}/`, timeoutMs: 5000,
    });
    expect(result).not.toBeNull();
    expect(result!.managed).toBe(false);
    expect(result!.proc).toBeNull();
    server.stop();
  });

  test("returns null if command binary does not exist", async () => {
    const result = await startManagedServer({
      name: "test", port: 19999, command: ["/nonexistent/binary", "--start"],
      healthUrl: "http://localhost:19999/", timeoutMs: 3000,
    });
    expect(result).toBeNull();
  });

  test("startup polling does not sleep beyond its absolute readiness budget", async () => {
    const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
    const port = reservation.port;
    await Promise.resolve(reservation.stop(true));
    const started = performance.now();

    const result = await startManagedServer({
      name: "deadline-test",
      port,
      command: [process.execPath, "-e", "await Bun.sleep(10000)"],
      healthUrl: `http://127.0.0.1:${port}/`,
      timeoutMs: 75,
      intervalMs: 1000,
    });

    expect(result).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });

  test.skipIf(process.platform === "win32")("startup failure escalates past ignored TERM and confirms the child was reaped", async () => {
    const root = mkdtempSync(join(tmpdir(), "cicero-managed-term-"));
    const pidPath = join(root, "child.pid");
    const port = await unusedPort();
    let childPid = 0;
    try {
      const started = performance.now();
      const result = await startManagedServer({
        name: "term-resistant-test",
        port,
        command: [
          process.execPath,
          "-e",
          `process.on("SIGTERM", () => {}); await Bun.write(process.argv[1], String(process.pid)); await new Promise(() => {});`,
          pidPath,
        ],
        healthUrl: `http://127.0.0.1:${port}/`,
        timeoutMs: 500,
        intervalMs: 25,
      });

      childPid = Number.parseInt(await Bun.file(pidPath).text(), 10);
      expect(result).toBeNull();
      expect(Number.isInteger(childPid)).toBe(true);
      expect(processExists(childPid)).toBe(false);
      expect(performance.now() - started).toBeGreaterThanOrEqual(600);
      expect(performance.now() - started).toBeLessThan(3_000);
    } finally {
      if (childPid > 0 && processExists(childPid)) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already exited */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 5_000);

  test("a no-newline stderr flood retains a bounded, useful diagnostic suffix", async () => {
    const port = await unusedPort();
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]): void => { output.push(values.map(String).join(" ")); };
    try {
      const result = await startManagedServer({
        name: "stderr-flood-test",
        port,
        command: [
          process.execPath,
          "-e",
          `await new Promise((resolve) => process.stderr.write("BEGIN-" + "x".repeat(2_000_000) + "-TAIL-MARKER", resolve));`,
        ],
        healthUrl: `http://127.0.0.1:${port}/`,
        timeoutMs: 5_000,
        intervalMs: 10,
      });
      expect(result).toBeNull();
    } finally {
      console.log = originalLog;
    }

    const diagnostic = output.join("\n");
    expect(diagnostic).toContain("...[truncated]");
    expect(diagnostic).toContain("-TAIL-MARKER");
    expect(diagnostic).not.toContain("BEGIN-");
    expect(diagnostic.length).toBeLessThan(20_000);
  }, 10_000);

  test.skipIf(process.platform === "win32")("docker launch failures clean a captured container ID with a bounded stop", async () => {
    const root = mkdtempSync(join(tmpdir(), "cicero-fake-docker-"));
    const dockerPath = join(root, "docker");
    const callLogPath = join(root, "calls.jsonl");
    const containerId = "a".repeat(64);
    const secondContainerId = "b".repeat(64);
    const originalPath = process.env.PATH;
    const originalLogPath = process.env.FAKE_DOCKER_LOG;
    const originalContainerId = process.env.FAKE_DOCKER_ID;
    const originalMode = process.env.FAKE_DOCKER_MODE;
    const fakeDockerSource = [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"`,
      `if [ "$1" = "run" ]; then`,
      `  printf '%s\\n' "$FAKE_DOCKER_ID"`,
      `  if [ "$FAKE_DOCKER_MODE" = "nonzero" ]; then exit 7; fi`,
      `  if [ "$FAKE_DOCKER_MODE" = "ambiguous" ]; then printf '%s\\n' "${secondContainerId}"; exit 7; fi`,
      `  trap 'exit 0' TERM INT`,
      `  while :; do sleep 1; done`,
      `fi`,
      `exit 0`,
    ].join("\n");

    try {
      writeFileSync(dockerPath, fakeDockerSource);
      chmodSync(dockerPath, 0o755);
      process.env.PATH = `${root}${delimiter}${originalPath ?? ""}`;
      process.env.FAKE_DOCKER_LOG = callLogPath;
      process.env.FAKE_DOCKER_ID = containerId;
      expect(Bun.which("docker", { PATH: process.env.PATH })).toBe(dockerPath);

      for (const mode of ["deadline", "nonzero"]) {
        writeFileSync(callLogPath, "");
        process.env.FAKE_DOCKER_MODE = mode;
        const port = await unusedPort();
        const result = await startManagedServer({
          name: `docker-${mode}-test`,
          port,
          command: ["fake-image"],
          healthUrl: `http://127.0.0.1:${port}/`,
          timeoutMs: 1_000,
          intervalMs: 10,
          mode: "docker",
        });

        expect(result).toBeNull();
        const calls = readFileSync(callLogPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean);
        expect(calls).toHaveLength(2);
        expect(calls[0]).toBe(`run -d -p ${port}:${port} fake-image`);
        expect(calls[1]).toBe(`stop --timeout=5 ${containerId}`);
      }

      writeFileSync(callLogPath, "");
      process.env.FAKE_DOCKER_MODE = "ambiguous";
      const ambiguousPort = await unusedPort();
      const ambiguous = await startManagedServer({
        name: "docker-ambiguous-id-test",
        port: ambiguousPort,
        command: ["fake-image"],
        healthUrl: `http://127.0.0.1:${ambiguousPort}/`,
        timeoutMs: 1_000,
        intervalMs: 10,
        mode: "docker",
      });
      expect(ambiguous).toBeNull();
      expect(readFileSync(callLogPath, "utf8").trim().split("\n")).toEqual([
        `run -d -p ${ambiguousPort}:${ambiguousPort} fake-image`,
      ]);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalLogPath === undefined) delete process.env.FAKE_DOCKER_LOG;
      else process.env.FAKE_DOCKER_LOG = originalLogPath;
      if (originalContainerId === undefined) delete process.env.FAKE_DOCKER_ID;
      else process.env.FAKE_DOCKER_ID = originalContainerId;
      if (originalMode === undefined) delete process.env.FAKE_DOCKER_MODE;
      else process.env.FAKE_DOCKER_MODE = originalMode;
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});

describe("stopManagedServer", () => {
  test("does nothing for unmanaged process", async () => {
    await stopManagedServer({ proc: null, port: 8080, managed: false, mode: "process" });
  });
});

describe("supervision", () => {
  // A tiny real server child: serves 200 on / until killed.
  const CHILD = [process.execPath, "-e", `Bun.serve({ port: Number(process.argv[1] ?? process.env.PORT), fetch: () => new Response("ok") }); await new Promise(() => {});`];

  const healthy = async (url: string) => {
    try { return (await fetch(url)).ok; } catch { return false; }
  };

  test("supervised child is revived after an unexpected death", async () => {
    const port = await unusedPort();
    const url = `http://127.0.0.1:${port}/`;
    const mp = await startManagedServer({
      name: "sup-test", port,
      command: [...CHILD.slice(0, 2), CHILD[2]!, String(port)],
      healthUrl: url, timeoutMs: 10000, intervalMs: 100,
      supervise: true,
    });
    expect(mp?.managed).toBe(true);
    const firstPid = mp!.proc!.pid;

    mp!.proc!.kill(); // simulate a crash (not via stopManagedServer)

    // revival: backoff 1s + health poll — allow up to 10s
    const deadline = Date.now() + 10_000;
    let revived = false;
    while (Date.now() < deadline) {
      if (mp!.proc && mp!.proc.pid !== firstPid && (await healthy(url))) { revived = true; break; }
      await Bun.sleep(200);
    }
    expect(revived).toBe(true);

    await stopManagedServer(mp!);
  }, 20_000);

  test.skipIf(process.platform === "win32")("supervision reaps a crashed launcher's surviving group before revival", async () => {
    const root = mkdtempSync(join(tmpdir(), "cicero-managed-orphan-"));
    const childPidPath = join(root, "child.pid");
    const port = await unusedPort();
    const url = `http://127.0.0.1:${port}/`;
    const childSource = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
    const parentSource = [
      `const child = Bun.spawn([${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(childSource)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
      `await Bun.write(process.argv[1], String(child.pid));`,
      `Bun.serve({ port: Number(process.argv[2]), fetch: () => new Response("ok") });`,
      `await new Promise(() => {});`,
    ].join("\n");
    let mp: ManagedProcess | null = null;
    let childPid = 0;
    try {
      mp = await startManagedServer({
        name: "supervisor-orphan-test",
        port,
        command: [process.execPath, "-e", parentSource, childPidPath, String(port)],
        healthUrl: url,
        timeoutMs: 10_000,
        intervalMs: 25,
        supervise: true,
      });
      expect(mp?.managed).toBe(true);
      expect(await waitUntil(() => Bun.file(childPidPath).exists(), 1_000)).toBe(true);
      childPid = Number.parseInt(await Bun.file(childPidPath).text(), 10);
      expect(processExists(childPid)).toBe(true);

      mp!.proc!.kill("SIGKILL");

      expect(await waitUntil(() => !processExists(childPid), 2_000)).toBe(true);
    } finally {
      if (mp) await stopManagedServer(mp).catch(() => { /* test cleanup */ });
      if (childPid > 0 && processExists(childPid)) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already exited */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("stopManagedServer does not trigger revival", async () => {
    const port = await unusedPort();
    const url = `http://127.0.0.1:${port}/`;
    const mp = await startManagedServer({
      name: "sup-stop-test", port,
      command: [...CHILD.slice(0, 2), CHILD[2]!, String(port)],
      healthUrl: url, timeoutMs: 10000, intervalMs: 100,
      supervise: true,
    });
    expect(mp?.managed).toBe(true);
    const childPid = mp!.proc!.pid;
    await stopManagedServer(mp!);
    expect(processExists(childPid)).toBe(false);
    expect(mp!.proc).toBeNull();
    await Bun.sleep(1500); // longer than the first backoff step
    expect(await healthy(url)).toBe(false); // stayed down — no zombie revival
  }, 20_000);

  test("stop during revival backoff aborts and drains the supervisor task", async () => {
    const port = await unusedPort();
    const url = `http://127.0.0.1:${port}/`;
    const output: string[] = [];
    const originalLog = console.log;
    let mp: ManagedProcess | null = null;
    try {
      mp = await startManagedServer({
        name: "supervisor-backoff-test",
        port,
        command: [...CHILD.slice(0, 2), CHILD[2]!, String(port)],
        healthUrl: url,
        timeoutMs: 10_000,
        intervalMs: 25,
        supervise: true,
      });
      expect(mp?.managed).toBe(true);
      const supervisorTask = mp!.supervisorTask;
      const supervisorAbort = mp!.supervisorAbort;
      expect(supervisorTask).toBeDefined();
      expect(supervisorAbort).toBeDefined();

      console.log = (...values: unknown[]): void => { output.push(values.map(String).join(" ")); };
      mp!.proc!.kill("SIGKILL");
      expect(await waitUntil(
        () => output.some((line) => line.includes("reviving in 1s")),
        2_000,
      )).toBe(true);
      expect(mp!.proc).toBeNull();

      let taskSettled = false;
      const observedTask = supervisorTask!.then(
        () => { taskSettled = true; },
        () => { taskSettled = true; },
      );
      const stoppingAt = performance.now();
      await stopManagedServer(mp!);
      await observedTask;

      expect(performance.now() - stoppingAt).toBeLessThan(500);
      expect(supervisorAbort!.signal.aborted).toBe(true);
      expect(taskSettled).toBe(true);
      expect(mp!.supervisorTask).toBeNull();
      expect(mp!.supervisorAbort).toBeNull();
    } finally {
      console.log = originalLog;
      if (mp) await stopManagedServer(mp).catch(() => { /* test cleanup */ });
    }
  }, 10_000);

  test("stop during revival readiness owns and reaps the replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "cicero-managed-revival-"));
    const statePath = join(root, "started");
    const revivalPidPath = join(root, "revival.pid");
    const readinessGatePath = join(root, "ready");
    const port = await unusedPort();
    const url = `http://127.0.0.1:${port}/`;
    const childSource = [
      `const [statePath, revivalPidPath, readinessGatePath, rawPort] = process.argv.slice(1);`,
      `if (!(await Bun.file(statePath).exists())) {`,
      `  await Bun.write(statePath, "started");`,
      `  Bun.serve({ port: Number(rawPort), fetch: () => new Response("ok") });`,
      `} else {`,
      `  await Bun.write(revivalPidPath, String(process.pid));`,
      `  while (!(await Bun.file(readinessGatePath).exists())) await Bun.sleep(10);`,
      `  Bun.serve({ port: Number(rawPort), fetch: () => new Response("ok") });`,
      `}`,
      `await new Promise(() => {});`,
    ].join("\n");
    let mp: ManagedProcess | null = null;
    let revivalPid = 0;

    try {
      mp = await startManagedServer({
        name: "revival-readiness-test",
        port,
        command: [
          process.execPath,
          "-e",
          childSource,
          statePath,
          revivalPidPath,
          readinessGatePath,
          String(port),
        ],
        healthUrl: url,
        timeoutMs: 10_000,
        intervalMs: 1_000,
        supervise: true,
      });
      expect(mp?.managed).toBe(true);

      const first = mp!.proc!;
      first.kill("SIGKILL");
      expect(await waitUntil(() => Bun.file(revivalPidPath).exists(), 5_000)).toBe(true);
      revivalPid = Number.parseInt(await Bun.file(revivalPidPath).text(), 10);
      expect(mp!.proc!.pid).toBe(revivalPid);
      expect(processExists(revivalPid)).toBe(true);

      const stoppingAt = performance.now();
      await stopManagedServer(mp!);
      expect(performance.now() - stoppingAt).toBeLessThan(500);
      expect(mp!.proc).toBeNull();
      await Bun.write(readinessGatePath, "ready");
      await Bun.sleep(300);

      expect(processExists(revivalPid)).toBe(false);
      expect(await healthy(url)).toBe(false);
    } finally {
      if (mp) await stopManagedServer(mp).catch(() => { /* test cleanup */ });
      if (revivalPid > 0 && processExists(revivalPid)) {
        try { process.kill(revivalPid, "SIGKILL"); } catch { /* already exited */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
