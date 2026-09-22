import { describe, expect, test } from "bun:test";
import {
  posixProcessGroupExists,
  terminateOwnedProcessTree,
} from "../../src/process/owned-process";

/**
 * Regression: `kill(-1, sig)` is not "the group led by pid 1" — POSIX defines it
 * as every process the caller may signal. A probe that passed pid 1 through the
 * tree terminator once SIGTERM'd an entire logged-in user.
 */
describe("process-group targeting refuses pid 1", () => {
  function fakeProc(pid: number) {
    let killed: string | undefined;
    return {
      pid,
      exited: new Promise<number>(() => {}),
      kill(sig?: string) { killed = sig; },
      get killed() { return killed; },
    };
  }

  test("terminateOwnedProcessTree rejects pid 1 without signalling anything", async () => {
    const proc = fakeProc(1);
    await expect(terminateOwnedProcessTree(proc as never)).rejects.toThrow(RangeError);
    expect(proc.killed).toBeUndefined();
  });

  test("terminateOwnedProcessTree still rejects non-positive pids", async () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      await expect(terminateOwnedProcessTree(fakeProc(pid) as never)).rejects.toThrow(RangeError);
    }
  });

  test("posixProcessGroupExists never probes the kill(-1) wildcard", () => {
    for (const pid of [1, 0, -1, Number.NaN]) {
      expect(posixProcessGroupExists(pid)).toBe(false);
    }
  });
});
