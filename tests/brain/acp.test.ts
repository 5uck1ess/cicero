import { test, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { readFileSync, unlinkSync } from "fs";
import {
  AcpBrain,
  AcpQueueOverflowError,
  AcpResponseLimitError,
  AcpTurnAdmissionError,
  type AcpBrainConfig,
} from "../../src/brain/acp";

// Drive the brain against a real ACP agent (the mock fixture), spawned with this
// same Bun runtime. Deterministic: no network, no API keys.
const MOCK_AGENT = join(import.meta.dir, "fixtures", "mock-acp-agent.ts");
const CANCEL_EXIT_FIXTURE = join(import.meta.dir, "fixtures", "acp-cancel-exit.ts");

function makeBrain(
  autoApproveTools = false,
  overrides: Partial<AcpBrainConfig> = {},
): AcpBrain {
  return new AcpBrain({
    binary: process.execPath, // the bun binary running these tests
    args: [MOCK_AGENT],
    autoApproveTools,
    startTimeoutMs: 15000,
    terminateGraceMs: 100,
    ...overrides,
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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

async function readPidManifest(path: string): Promise<{ rootPid: number; childPid: number }> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      if (await Bun.file(path).exists()) {
        return JSON.parse(await Bun.file(path).text()) as { rootPid: number; childPid: number };
      }
    } catch { /* writer has not atomically completed yet */ }
    await Bun.sleep(10);
  }
  throw new Error("stubborn ACP fixture did not publish its PID manifest");
}

function readSpawnPids(path: string): number[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((value) => Number.parseInt(value, 10))
      .filter(Number.isFinite);
  } catch {
    return [];
  }
}

async function waitForSpawnCount(path: string, count: number): Promise<void> {
  try {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      if (readSpawnPids(path).length >= count) return;
      await Bun.sleep(5);
    }
    throw new Error(`ACP fixture did not record ${count} process spawn(s)`);
  } catch (error: unknown) {
    throw error;
  }
}

let brain: AcpBrain | undefined;
afterEach(async () => {
  await brain?.stop();
  brain = undefined;
});

test("send() returns the agent's reply over a real ACP turn", async () => {
  brain = makeBrain();
  await brain.start();
  expect(await brain.send("hello")).toBe("echo:hello");
});

test("sendStream() yields incremental chunks", async () => {
  brain = makeBrain();
  await brain.start();
  const chunks: string[] = [];
  for await (const c of brain.sendStream("world")) chunks.push(c);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.join("")).toBe("echo:world");
});

test("AbortSignal cancels a silent turn and holds the next turn until settlement", async () => {
  brain = makeBrain();
  await brain.start();

  const controller = new AbortController();
  const silent = brain.sendStream("wait for cancel", { signal: controller.signal });
  const pendingToken = silent.next();
  await Bun.sleep(40); // let the mock enter its deliberately silent prompt

  let nextFinished = false;
  const nextTurn = brain.send("after cancel").then((reply) => {
    nextFinished = true;
    return reply;
  });
  await Bun.sleep(20);
  expect(nextFinished).toBe(false);

  const abortedAt = performance.now();
  controller.abort();
  expect(await pendingToken).toEqual({ value: undefined, done: true });
  expect(performance.now() - abortedAt).toBeLessThan(500);

  // The interrupted consumer is free, but the session lock remains held for
  // the mock's delayed cancellation settlement.
  await Bun.sleep(60);
  expect(nextFinished).toBe(false);
  expect(await nextTurn).toBe("echo:after cancel");
});

test("aborting a queued turn settles it without letting its successor bypass the active turn", async () => {
  brain = makeBrain();
  await brain.start();

  const activeAbort = new AbortController();
  const active = brain.sendStream("wait for cancel", { signal: activeAbort.signal })[Symbol.asyncIterator]();
  const activeNext = active.next();
  await Bun.sleep(40);

  const queuedAbort = new AbortController();
  const queued = brain.sendStream("skip queued", { signal: queuedAbort.signal })[Symbol.asyncIterator]();
  const queuedNext = queued.next();
  let successorFinished = false;
  const successor = brain.send("queued successor").then((reply) => {
    successorFinished = true;
    return reply;
  });

  queuedAbort.abort();
  expect(await withTimeout(queuedNext, 300, "queued ACP abort")).toEqual({ value: undefined, done: true });
  await Bun.sleep(30);
  expect(successorFinished).toBe(false);

  activeAbort.abort();
  expect(await activeNext).toEqual({ value: undefined, done: true });
  expect(await successor).toBe("echo:queued successor");
});

test("pending-turn admission is bounded while an ACP session is stalled", async () => {
  brain = makeBrain(false, { maxPendingTurns: 2 });
  await brain.start();

  const active = brain.sendStream("ignore cancellation until stopped")[Symbol.asyncIterator]();
  const activeOutcome = active.next().then(
    (item) => item,
    (error: unknown) => error,
  );
  await Bun.sleep(40);
  const queued = brain.sendStream("queued within cap")[Symbol.asyncIterator]();
  const queuedOutcome = queued.next().then(
    (item) => item,
    (error: unknown) => error,
  );

  const rejected = brain.sendStream("one too many")[Symbol.asyncIterator]().next();
  await expect(rejected).rejects.toBeInstanceOf(AcpTurnAdmissionError);
  await brain.stop();
  expect(await activeOutcome).toBeInstanceOf(Error);
  expect(await queuedOutcome).toBeInstanceOf(Error);
});

test("aborted queued reservations cannot grow an unbounded hidden lock chain", async () => {
  brain = makeBrain(false, { maxPendingTurns: 2 });
  await brain.start();
  const active = brain.sendStream("ignore cancellation until stopped")[Symbol.asyncIterator]();
  const activeOutcome = active.next().catch((error: unknown) => error);
  await Bun.sleep(40);

  const queuedAbort = new AbortController();
  const queued = brain.sendStream("abort this queued turn", {
    signal: queuedAbort.signal,
  })[Symbol.asyncIterator]();
  const queuedNext = queued.next();
  queuedAbort.abort();
  expect(await queuedNext).toEqual({ value: undefined, done: true });

  await expect(brain.sendStream("still over cap")[Symbol.asyncIterator]().next())
    .rejects.toBeInstanceOf(AcpTurnAdmissionError);
  await brain.stop();
  expect(await activeOutcome).toBeInstanceOf(Error);
});

test("stop cancels and settles a silent active protocol turn", async () => {
  brain = makeBrain();
  await brain.start();
  const iterator = brain.sendStream("ignore cancellation until stopped")[Symbol.asyncIterator]();
  const pending = iterator.next();
  await Bun.sleep(40);

  const stopping = brain.stop();
  await expect(pending).rejects.toThrow("ACP brain stopped");
  await withTimeout(stopping, 1_000, "silent ACP stop");
  expect(await brain.health()).toBe(false);
});

test("a paused consumer overflow cancels the ACP turn and the session remains usable", async () => {
  brain = makeBrain(false, { maxQueuedBytes: 64 });
  await brain.start();
  const iterator = brain.sendStream("flood paused consumer")[Symbol.asyncIterator]();
  expect(await iterator.next()).toEqual({ value: "0123456789", done: false });
  await Bun.sleep(60);

  await expect(iterator.next()).rejects.toBeInstanceOf(AcpQueueOverflowError);
  // Full-suite CI runs many real child-process fixtures concurrently. This is a
  // liveness assertion, not a latency benchmark, so leave enough headroom for
  // the cancelled mock process to be scheduled and report settlement.
  expect(await withTimeout(brain.send("after queue overflow"), 3_000, "post-overflow ACP turn"))
    .toBe("echo:after queue overflow");
});

test("real ACP streaming handles many tiny chunks incrementally", async () => {
  brain = makeBrain(false, { maxQueuedBytes: 128 * 1024 });
  await brain.start();
  let chunks = 0;
  for await (const chunk of brain.sendStream("many tiny chunks")) {
    expect(chunk).toBe("x");
    chunks++;
  }
  expect(chunks).toBe(20_000);
});

test("send aggregation overflow cancels the live turn without capping sendStream", async () => {
  brain = makeBrain(false, { maxResponseBytes: 64 });
  await brain.start();
  await expect(brain.send("endless aggregation")).rejects.toBeInstanceOf(AcpResponseLimitError);
  expect(await withTimeout(brain.send("after aggregation overflow"), 1_000, "post-aggregation ACP turn"))
    .toBe("echo:after aggregation overflow");
});

test("health() reflects connection lifecycle", async () => {
  brain = makeBrain();
  expect(await brain.health()).toBe(false);
  await brain.start();
  expect(await brain.health()).toBe(true);
  await brain.stop();
  expect(await brain.health()).toBe(false);
});

test("injectContext() is prepended to the prompt", async () => {
  brain = makeBrain();
  await brain.start();
  brain.injectContext("ran: ls");
  expect(await brain.send("what did I run")).toContain("ran: ls");
  expect(await brain.send("next turn")).toBe("echo:next turn");
});

test("auto-approves a tool permission when enabled (the 'do stuff' gate)", async () => {
  brain = makeBrain(true);
  await brain.start();
  expect(await brain.send("use tool")).toBe("perm:allow");
});

test("rejects a tool permission when auto-approve is off", async () => {
  brain = makeBrain(false);
  await brain.start();
  expect(await brain.send("use tool")).toBe("perm:reject");
});

test("restart() re-establishes a working session", async () => {
  brain = makeBrain();
  await brain.start();
  await brain.restart();
  expect(await brain.send("again")).toBe("echo:again");
});

test("restart() after an explicit stop starts a fresh usable process", async () => {
  brain = makeBrain();
  await brain.start();
  await brain.stop();
  await brain.restart();
  expect(await brain.send("after stopped restart")).toBe("echo:after stopped restart");
});

test("a later stop intent prevents an in-flight restart from resurrecting ACP", async () => {
  brain = makeBrain();
  await brain.start();

  const restarting = brain.restart();
  const stopping = brain.stop();
  await Promise.all([restarting, stopping]);

  expect(await brain.health()).toBe(false);
  await expect(brain.send("must stay stopped")).rejects.toThrow("not started");
});

test("stop during startup reaps the partial runtime and permits a later clean start", async () => {
  brain = makeBrain(false, {
    env: { CICERO_TEST_ACP_INITIALIZE_DELAY_MS: "200" },
  });
  const starting = brain.start();
  const startOutcome = starting.then(
    () => ({ error: null as Error | null }),
    (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
  );
  await Bun.sleep(40);

  await withTimeout(brain.stop(), 1_000, "startup-interrupted ACP stop");
  expect((await startOutcome).error?.message).toMatch(/interrupted because the ACP agent stopped/);
  await withTimeout(brain.start(), 1_000, "ACP restart after interrupted startup");
  expect(await brain.send("after startup stop")).toBe("echo:after startup stop");
});

test("concurrent starts released by lifecycle cleanup spawn only one replacement", async () => {
  const pidLog = join(tmpdir(), `cicero-acp-start-race-${process.pid}-${crypto.randomUUID()}.log`);
  try {
    brain = makeBrain(false, {
      env: {
        CICERO_TEST_ACP_INITIALIZE_DELAY_MS: "300",
        CICERO_TEST_ACP_SPAWN_PID_LOG: pidLog,
      },
    });
    const interruptedStart = brain.start().catch(() => undefined);
    await waitForSpawnCount(pidLog, 1);

    const stopping = brain.stop();
    const replacementStarts = Array.from({ length: 8 }, () => brain!.start());
    await Promise.all([interruptedStart, stopping, ...replacementStarts]);

    expect(await brain.health()).toBe(true);
    expect(readSpawnPids(pidLog)).toHaveLength(2);
    expect(await brain.send("after concurrent starts")).toBe("echo:after concurrent starts");
  } finally {
    await brain?.stop();
    for (const pid of readSpawnPids(pidLog)) {
      if (processExists(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
      }
    }
    try { unlinkSync(pidLog); } catch { /* test cleanup */ }
  }
});

test.skipIf(process.platform === "win32")("stop escalates TERM-resistant ACP roots and descendants and confirms group exit", async () => {
  const pidFile = join(tmpdir(), `cicero-acp-stubborn-${process.pid}-${crypto.randomUUID()}.json`);
  let pids: { rootPid: number; childPid: number } | null = null;
  try {
    brain = makeBrain(false, {
      env: { CICERO_TEST_ACP_STUBBORN_PID_FILE: pidFile },
      terminateGraceMs: 40,
    });
    await brain.start();
    pids = await readPidManifest(pidFile);
    expect(processExists(pids.rootPid)).toBe(true);
    expect(processExists(pids.childPid)).toBe(true);

    const stoppedAt = performance.now();
    await withTimeout(brain.stop(), 1_000, "stubborn ACP process-group stop");
    expect(performance.now() - stoppedAt).toBeGreaterThanOrEqual(30);
    expect(processExists(pids.rootPid)).toBe(false);
    expect(processExists(pids.childPid)).toBe(false);
  } finally {
    if (pids) {
      try { process.kill(-pids.rootPid, "SIGKILL"); } catch { /* already reaped */ }
      try { process.kill(pids.childPid, "SIGKILL"); } catch { /* already reaped */ }
    }
    try { unlinkSync(pidFile); } catch { /* test cleanup */ }
  }
});

test.skipIf(process.platform === "win32")("a later stop intent wins over timed-out cancellation recovery", async () => {
  const pidFile = join(tmpdir(), `cicero-acp-recovery-race-${process.pid}-${crypto.randomUUID()}.json`);
  let pids: { rootPid: number; childPid: number } | null = null;
  try {
    brain = makeBrain(false, {
      env: { CICERO_TEST_ACP_STUBBORN_PID_FILE: pidFile },
      cancelSettleMs: 30,
      terminateGraceMs: 250,
    });
    await brain.start();
    pids = await readPidManifest(pidFile);

    const controller = new AbortController();
    const active = brain.sendStream("ignore cancellation until stopped", {
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const pending = active.next();
    await Bun.sleep(30);
    controller.abort();
    expect(await pending).toEqual({ value: undefined, done: true });

    await withTimeout((async () => {
      try {
        while (await brain!.health()) await Bun.sleep(5);
      } catch (error: unknown) {
        throw error;
      }
    })(), 500, "ACP cancellation recovery start");
    await brain.stop();
    await Bun.sleep(50);

    expect(await brain.health()).toBe(false);
    await expect(brain.send("must remain stopped")).rejects.toThrow("not started");
  } finally {
    if (pids) {
      try { process.kill(-pids.rootPid, "SIGKILL"); } catch { /* already reaped */ }
      try { process.kill(pids.childPid, "SIGKILL"); } catch { /* already reaped */ }
    }
    try { unlinkSync(pidFile); } catch { /* test cleanup */ }
  }
});

test("a non-settling protocol cancel write cannot hold the ACP turn lock", async () => {
  brain = makeBrain(false, { cancelSettleMs: 30 });
  await brain.start();
  const state = brain as unknown as {
    runtime: { conn: { cancel: (params: unknown) => Promise<void> } | null } | null;
  };
  if (!state.runtime?.conn) throw new Error("ACP test runtime did not start");
  state.runtime.conn.cancel = () => new Promise<void>(() => { /* deliberately never settles */ });

  const controller = new AbortController();
  const active = brain.sendStream("ignore cancellation until stopped", {
    signal: controller.signal,
  })[Symbol.asyncIterator]();
  const pending = active.next();
  await Bun.sleep(30);
  const queuedOutcome = brain.send("queued across blocked cancel recovery").catch((error: unknown) => error);
  controller.abort();
  expect(await pending).toEqual({ value: undefined, done: true });

  const queuedError = await withTimeout(queuedOutcome, 1_500, "blocked ACP cancel recovery");
  expect(queuedError).toBeInstanceOf(Error);
  expect((queuedError as Error).message).toContain("stopped while waiting for turn");
  await withTimeout(brain.start(), 1_500, "blocked ACP cancel restart");
  expect(await brain.send("after blocked cancel write"))
    .toBe("echo:after blocked cancel write");
});

test("settled ACP cancellation does not keep a child process alive for five seconds", async () => {
  const startedAt = performance.now();
  const proc = Bun.spawn([process.execPath, CANCEL_EXIT_FIXTURE], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  let code: number;
  try {
    code = await withTimeout(proc.exited, 3_000, "ACP cancellation fixture exit");
  } finally {
    if (proc.exitCode === null) {
      try { proc.kill("SIGKILL"); } catch { /* already exited */ }
      await proc.exited.catch(() => -1);
    }
  }
  expect(code).toBe(0);
  expect(await stderr).toBe("");
  expect(performance.now() - startedAt).toBeLessThan(3_000);
});

test("rejects unsafe internal ACP lifecycle and admission limits", () => {
  expect(() => makeBrain(false, { terminateGraceMs: Number.POSITIVE_INFINITY })).toThrow("finite non-negative");
  expect(() => makeBrain(false, { terminateGraceMs: -1 })).toThrow("finite non-negative");
  expect(() => makeBrain(false, { terminateGraceMs: 60_001 })).toThrow("no greater than 60000");
  expect(() => makeBrain(false, { cancelSettleMs: Number.NaN })).toThrow("finite non-negative");
  expect(() => makeBrain(false, { cancelSettleMs: 60_001 })).toThrow("no greater than 60000");
  expect(() => makeBrain(false, { startTimeoutMs: 300_001 })).toThrow("no greater than 300000");
  expect(() => makeBrain(false, { maxPendingTurns: 0 })).toThrow("maxPendingTurns");
});

test("restart invalidates a pending approval capability from the old ACP session", async () => {
  brain = new AcpBrain({
    binary: process.execPath,
    args: [MOCK_AGENT],
    autoApproveTools: true,
    confirmTools: ["mock-tool-1"],
    confirmRetry: false,
    startTimeoutMs: 15_000,
  });
  await brain.start();
  expect(await brain.send("use tool")).toBe("perm:reject");
  const oldNonce = brain.pendingConfirmations()[0]!.nonce;

  await brain.restart();
  expect(brain.resolvePendingConfirmation(true, oldNonce)).toBe(false);
  expect(await brain.send("use tool")).toBe("perm:reject");
  const newNonce = brain.pendingConfirmations()[0]!.nonce;
  expect(newNonce).not.toBe(oldNonce);
  expect(brain.resolvePendingConfirmation(true, oldNonce)).toBe(false);
  expect(brain.pendingConfirmations()[0]!.nonce).toBe(newNonce);
});
