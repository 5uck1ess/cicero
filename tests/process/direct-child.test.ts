import { expect, test } from "bun:test";
import { terminateDirectChild, type DirectChildProcess } from "../../src/process/direct-child";

function fakeChild(ignoreTerm = false): {
  proc: DirectChildProcess;
  signals: Array<NodeJS.Signals | number | undefined>;
} {
  let resolveExit!: (code: number) => void;
  let settled = false;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  return {
    proc: {
      pid: 1234,
      exited,
      kill(signal) {
        signals.push(signal);
        if (settled || (ignoreTerm && signal === "SIGTERM")) return;
        settled = true;
        resolveExit(0);
      },
    },
    signals,
  };
}

test("terminateDirectChild reaps after TERM", async () => {
  const child = fakeChild();
  await terminateDirectChild(child.proc, { terminateGraceMs: 10, reapTimeoutMs: 20 });
  expect(child.signals).toEqual(["SIGTERM"]);
});

test("terminateDirectChild escalates a TERM-resistant child", async () => {
  const child = fakeChild(true);
  await terminateDirectChild(child.proc, { terminateGraceMs: 5, reapTimeoutMs: 20 });
  expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("concurrent terminateDirectChild calls coalesce shared cleanup", async () => {
  const child = fakeChild(true);
  await Promise.all([
    terminateDirectChild(child.proc, { terminateGraceMs: 5, reapTimeoutMs: 20 }),
    terminateDirectChild(child.proc, { terminateGraceMs: 5, reapTimeoutMs: 20 }),
  ]);
  expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("terminateDirectChild surfaces an exit-observation failure", async () => {
  const exited = Promise.reject<number>(new Error("fixture exit observation failed"));
  void exited.catch(() => { /* the helper observes the same rejection */ });
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const proc: DirectChildProcess = {
    pid: 1235,
    exited,
    kill(signal) { signals.push(signal); },
  };

  await expect(terminateDirectChild(proc, { terminateGraceMs: 5, reapTimeoutMs: 20 }))
    .rejects.toThrow("direct child 1235 exit observation failed: fixture exit observation failed");
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("terminateDirectChild preserves timeout and validation errors", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const proc: DirectChildProcess = {
    pid: 1236,
    exited: new Promise<number>(() => { /* deliberately never settles */ }),
    kill(signal) { signals.push(signal); },
  };

  await expect(terminateDirectChild(proc, { terminateGraceMs: 0, reapTimeoutMs: 5 }))
    .rejects.toThrow("direct child 1236 did not reap after SIGKILL");
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  await expect(terminateDirectChild(proc, { reapTimeoutMs: 0 }))
    .rejects.toBeInstanceOf(RangeError);
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});
