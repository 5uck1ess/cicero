import { describe, expect, test } from "bun:test";
import {
  OwnedProcessReapError,
  windowsForcedKillNeeded,
  windowsTreeAccountedFor,
  processExitWithin,
  spawnOwnedProcess,
  terminateOwnedDirectProcess,
  terminateOwnedProcessTree,
} from "../../src/process/owned-process";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("processExitWithin distinguishes exit, rejection, and timeout", async () => {
  await expect(processExitWithin(Promise.resolve(7), 50)).resolves.toEqual({ kind: "exited", code: 7 });
  const failure = new Error("waitpid failed");
  await expect(processExitWithin(Promise.reject(failure), 50)).resolves.toEqual({ kind: "rejected", error: failure });
  await expect(processExitWithin(Promise.reject(failure), 0)).resolves.toEqual({ kind: "timeout" });
  await Bun.sleep(0); // the zero-length poll must still have observed rejection
  await expect(processExitWithin(new Promise<number>(() => {}), 5)).resolves.toEqual({ kind: "timeout" });
});

test.skipIf(process.platform === "win32")(
  "concurrent tree termination shares one signal/reap operation",
  async () => {
    let resolveExit!: (code: number) => void;
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const proc = {
      pid: 987_654_320,
      exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
      kill(signal?: NodeJS.Signals | number) {
        signals.push(signal);
        resolveExit(0);
      },
    };

    const first = terminateOwnedProcessTree(proc, { terminateGraceMs: 10, reapTimeoutMs: 20 });
    const second = terminateOwnedProcessTree(proc, { terminateGraceMs: 10, reapTimeoutMs: 20 });

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(signals).toEqual(["SIGTERM"]);
    expect(terminateOwnedProcessTree(proc)).toBe(first);
    await terminateOwnedProcessTree(proc);
    expect(signals).toEqual(["SIGTERM"]);
  },
);

test("concurrent direct termination shares one signal/reap operation", async () => {
  let resolveExit!: (code: number) => void;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const proc = {
    pid: 987_654_319,
    exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
    kill(signal?: NodeJS.Signals | number) {
      signals.push(signal);
      resolveExit(0);
    },
  };

  const first = terminateOwnedDirectProcess(proc, { terminateGraceMs: 10, reapTimeoutMs: 20 });
  const second = terminateOwnedDirectProcess(proc, { terminateGraceMs: 10, reapTimeoutMs: 20 });

  expect(second).toBe(first);
  await Promise.all([first, second]);
  expect(signals).toEqual(["SIGTERM"]);
  expect(terminateOwnedDirectProcess(proc)).toBe(first);
  await terminateOwnedDirectProcess(proc);
  expect(signals).toEqual(["SIGTERM"]);
});

test("tree termination rejects invalid process-group identifiers before signalling", async () => {
  let signals = 0;
  const proc = {
    pid: 0,
    exited: Promise.resolve(0),
    kill() { signals++; },
  };

  await expect(terminateOwnedProcessTree(proc)).rejects.toThrow("pid must be a positive integer");
  expect(signals).toBe(0);
});

test.skipIf(process.platform === "win32")(
  "shared tree termination escalates TERM-resistant leaders and descendants",
  async () => {
    // The PID line doubles as a readiness handshake: the child reports its own
    // pid only after installing its SIGTERM handler (stdout inherited through
    // the parent), and the parent installs its handler before spawning — so by
    // the time the line arrives, both processes are provably TERM-resistant.
    // Printing the pid before the handlers exist let SIGTERM land in the gap
    // on slow CI runners, and the tree died fast enough to fail the >=30ms
    // escalation floor below.
    const childSource = `process.on("SIGTERM", () => {}); process.stdout.write(String(process.pid) + "\\n"); setInterval(() => {}, 1000);`;
    const parentSource = [
      `process.on("SIGTERM", () => {});`,
      `Bun.spawn([${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(childSource)}], { stdin: "ignore", stdout: "inherit", stderr: "ignore" });`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const proc = spawnOwnedProcess([process.execPath, "-e", parentSource], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = proc.stdout.getReader();
    let pidLine = "";
    while (!pidLine.includes("\n") && pidLine.length < 128) {
      const item = await reader.read();
      if (item.done) break;
      pidLine += new TextDecoder().decode(item.value);
    }
    reader.releaseLock();
    const childPid = Number.parseInt(pidLine.trim(), 10);
    const started = performance.now();

    await terminateOwnedProcessTree(proc, { terminateGraceMs: 40, reapTimeoutMs: 1_000 });

    expect(performance.now() - started).toBeGreaterThanOrEqual(30);
    expect(processExists(proc.pid)).toBe(false);
    expect(processExists(childPid)).toBe(false);
  },
);

test.skipIf(process.platform === "win32")(
  "failed tree reap proof does not latch: a live retry can succeed",
  async () => {
    let resolveExit!: (code: number) => void;
    let resistant = true;
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const proc = {
      pid: 987_654_318,
      exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
      kill(signal?: NodeJS.Signals | number) {
        signals.push(signal);
        if (!resistant) resolveExit(0);
      },
    };

    // First attempt: the leader survives TERM and KILL, so the reap proof fails.
    await expect(terminateOwnedProcessTree(proc, { terminateGraceMs: 5, reapTimeoutMs: 10 }))
      .rejects.toBeInstanceOf(OwnedProcessReapError);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);

    // The failure cleared its cache entry, so with the cause removed a retry
    // against the same process object signals live and proves the reap.
    resistant = false;
    await terminateOwnedProcessTree(proc, { terminateGraceMs: 5, reapTimeoutMs: 10 });
    expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM"]);

    // The retry's success is cached: a duplicate must not re-signal the pid.
    await terminateOwnedProcessTree(proc);
    expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM"]);
  },
);

test("failed direct reap proof does not latch: a live retry can succeed", async () => {
  let resolveExit!: (code: number) => void;
  let resistant = true;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const proc = {
    pid: 987_654_317,
    exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
    kill(signal?: NodeJS.Signals | number) {
      signals.push(signal);
      if (!resistant) resolveExit(0);
    },
  };

  // First attempt: the child survives TERM and KILL, so the reap proof fails.
  await expect(terminateOwnedDirectProcess(proc, { terminateGraceMs: 5, reapTimeoutMs: 10 }))
    .rejects.toBeInstanceOf(OwnedProcessReapError);
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);

  // The failure cleared its cache entry, so with the cause removed a retry
  // against the same process object signals live and proves the reap.
  resistant = false;
  await terminateOwnedDirectProcess(proc, { terminateGraceMs: 5, reapTimeoutMs: 10 });
  expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM"]);

  // The retry's success is cached: a duplicate must not re-signal the pid.
  await terminateOwnedDirectProcess(proc);
  expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM"]);
});

test("unconfirmed leader exit is a typed ownership failure", async () => {
  const fake = {
    pid: 987_654_321,
    exited: Promise.reject(new Error("waitpid failed")),
    kill() {},
  };

  await expect(terminateOwnedProcessTree(fake, {
    terminateGraceMs: 0,
    reapTimeoutMs: 5,
  })).rejects.toBeInstanceOf(OwnedProcessReapError);
});

// terminateWindowsTree itself is unreachable off win32 (the platform check is
// inline), so this covers the decision; real taskkill behavior is covered by the
// Windows CI job.
describe("windows forced-kill fallback", () => {
  // Separate from the accounting matrix on purpose: main gated this on taskkill's
  // exit code being non-zero, so a missing PID (128) reached the SIGKILL too. An
  // earlier revision of this branch narrowed it to a refused kill only, which
  // silently diverged from main for exit 128 — and `proc.kill()` is also what
  // reaps Bun's child handle, so skipping it can leave `proc.exited` pending.
  // A line-count comparison against main cannot catch a changed condition; this
  // can.
  test("every outcome but a pass that reached the tree still needs SIGKILL", () => {
    expect(windowsForcedKillNeeded("targeted")).toBe(false);
    expect(windowsForcedKillNeeded("absent")).toBe(true);
    expect(windowsForcedKillNeeded("failed")).toBe(true);
  });

  // The two decisions genuinely disagree for absent/absent and absent/failed:
  // the leader must still be killed, yet the tree is NOT accounted for. Pinning
  // that keeps a future simplification from collapsing them back together.
  test("needing a SIGKILL is not the same question as the tree being accounted for", () => {
    expect(windowsForcedKillNeeded("absent")).toBe(true);
    expect(windowsTreeAccountedFor("absent", "absent")).toBe(false);
    expect(windowsTreeAccountedFor("absent", "failed")).toBe(false);
  });
});

describe("windows tree accounting", () => {
  test("a forced pass that reached the tree is conclusive on its own", () => {
    for (const graceful of ["targeted", "absent", "failed"] as const) {
      expect(windowsTreeAccountedFor(graceful, "targeted")).toBe(true);
    }
  });

  // The regression: graceful reached the whole tree, the leader ignored TERM
  // past the grace window, then exited just before the forced pass ran.
  test("an absent PID after a graceful pass that reached the tree is accounted for", () => {
    expect(windowsTreeAccountedFor("targeted", "absent")).toBe(true);
  });

  // A vanished leader cannot be used to rediscover or signal its descendants.
  test("a leader absent before the graceful pass is not accounted for", () => {
    expect(windowsTreeAccountedFor("absent", "failed")).toBe(false);
    expect(windowsTreeAccountedFor("absent", "absent")).toBe(false);
  });

  // With no grace window the graceful pass never runs, so the forced pass is the
  // only thing that could have signalled the descendants. If it found no PID,
  // nothing did, and a vanished leader proves nothing about them.
  test("an absent PID after no graceful pass at all is not enough", () => {
    expect(windowsTreeAccountedFor("failed", "absent")).toBe(false);
  });

  // Everything else keeps the conservative verdict this reaper already had: a
  // graceful pass that reached the tree and then a forced pass that could not is
  // a genuine targeting failure, because processes that ignore the graceful
  // signal may still be running.
  test("a forced failure after a graceful pass that reached the tree still fails closed", () => {
    expect(windowsTreeAccountedFor("targeted", "failed")).toBe(false);
    expect(windowsTreeAccountedFor("failed", "failed")).toBe(false);
  });

  // Sanity bound on the whole matrix: only a forced pass that reached the tree,
  // or an absent PID after a targeted graceful pass, is accounted for.
  test("no other outcome pair is accounted for", () => {
    const outcomes = ["targeted", "absent", "failed"] as const;
    const accounted = outcomes.flatMap((graceful) =>
      outcomes.filter((forced) => windowsTreeAccountedFor(graceful, forced)).map((forced) => `${graceful}/${forced}`),
    );
    expect(accounted.sort()).toEqual([
      "absent/targeted", "failed/targeted",
      "targeted/absent", "targeted/targeted",
    ]);
  });
});
