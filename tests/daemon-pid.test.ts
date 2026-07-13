import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimDaemonPidFile,
  inspectDaemonPidFile,
  stopDaemonFromPidFile,
  type DaemonPidLease,
  type DaemonPidRecord,
} from "../src/daemon-pid";

const DEAD_PID = 2_147_483_647;

function sandbox(name: string): { root: string; pidFile: string } {
  const root = mkdtempSync(join(tmpdir(), `cicero-${name}-`));
  return { root, pidFile: join(root, "cicero.pid") };
}

function record(overrides: Partial<DaemonPidRecord> = {}): DaemonPidRecord {
  return {
    version: 1,
    pid: DEAD_PID,
    identity: "test:dead-process",
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function writePrivateRecord(path: string, value: DaemonPidRecord | string): void {
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

describe("daemon PID ownership", () => {
  test("claims a private marker and releases only its own lease", async () => {
    const { root, pidFile } = sandbox("pid-lease");
    try {
      const lease = await claimDaemonPidFile(pidFile);
      const inspection = await inspectDaemonPidFile(pidFile);

      expect(inspection.kind).toBe("running");
      expect(JSON.parse(readFileSync(pidFile, "utf8"))).toEqual(lease.record);
      expect(lstatSync(pidFile).nlink).toBe(1);
      if (process.platform !== "win32") expect(lstatSync(pidFile).mode & 0o777).toBe(0o600);

      await lease.release();
      await lease.release();
      expect(await inspectDaemonPidFile(pidFile)).toEqual({ kind: "absent" });
    } catch (error) {
      throw new Error(`PID lease test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects duplicate starts while the first process lease is live", async () => {
    const { root, pidFile } = sandbox("pid-duplicate");
    let first: DaemonPidLease | undefined;
    try {
      first = await claimDaemonPidFile(pidFile);
      await expect(claimDaemonPidFile(pidFile)).rejects.toThrow(/already running/);
    } catch (error) {
      throw new Error(`duplicate PID claim test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      await first?.release().catch(() => { /* test cleanup */ });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows only one winner when starts race", async () => {
    const { root, pidFile } = sandbox("pid-race");
    const leases: DaemonPidLease[] = [];
    try {
      const results = await Promise.allSettled([
        claimDaemonPidFile(pidFile),
        claimDaemonPidFile(pidFile),
        claimDaemonPidFile(pidFile),
      ]);
      for (const result of results) {
        if (result.status === "fulfilled") leases.push(result.value);
      }
      expect(leases).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    } catch (error) {
      throw new Error(`racing PID claim test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      await Promise.allSettled(leases.map((lease) => lease.release()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replaces a dead process marker without trusting its stale PID", async () => {
    const { root, pidFile } = sandbox("pid-stale");
    let lease: DaemonPidLease | undefined;
    try {
      writePrivateRecord(pidFile, record());
      expect((await inspectDaemonPidFile(pidFile)).kind).toBe("stale");

      lease = await claimDaemonPidFile(pidFile);
      expect(lease.record.pid).toBe(process.pid);
      expect((await inspectDaemonPidFile(pidFile)).kind).toBe("running");
    } catch (error) {
      throw new Error(`stale PID replacement test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      await lease?.release().catch(() => { /* test cleanup */ });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never signals when a reused PID has a different process identity", async () => {
    const { root, pidFile } = sandbox("pid-reuse");
    let lease: DaemonPidLease | undefined;
    try {
      lease = await claimDaemonPidFile(pidFile);
      const reused = { ...lease.record, identity: `${lease.record.identity}:different`, token: crypto.randomUUID() };
      unlinkSync(pidFile);
      writePrivateRecord(pidFile, reused);
      let signals = 0;

      const result = await stopDaemonFromPidFile(pidFile, {
        kill: () => { signals += 1; },
      });

      expect(result.kind).toBe("not-running");
      expect(signals).toBe(0);
    } catch (error) {
      throw new Error(`PID reuse stop test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      await lease?.release().catch(() => { /* ownership mismatch intentionally leaves the fixture */ });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("signals an identity-matched process and reports its PID", async () => {
    const { root, pidFile } = sandbox("pid-stop");
    let lease: DaemonPidLease | undefined;
    try {
      lease = await claimDaemonPidFile(pidFile);
      const observed: Array<[number, NodeJS.Signals]> = [];
      const result = await stopDaemonFromPidFile(pidFile, {
        kill: (pid, signal) => { observed.push([pid, signal]); },
      });

      expect(result).toEqual({ kind: "signaled", pid: process.pid });
      expect(observed).toEqual([[process.pid, "SIGTERM"]]);
    } catch (error) {
      throw new Error(`matched PID stop test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      await lease?.release().catch(() => { /* test cleanup */ });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an old lease cannot remove a replacement marker", async () => {
    const { root, pidFile } = sandbox("pid-cleanup-race");
    let lease: DaemonPidLease | undefined;
    try {
      lease = await claimDaemonPidFile(pidFile);
      const replacement = { ...lease.record, token: crypto.randomUUID() };
      unlinkSync(pidFile);
      writePrivateRecord(pidFile, replacement);

      await lease.release();

      expect(existsSync(pidFile)).toBe(true);
      expect(JSON.parse(readFileSync(pidFile, "utf8"))).toEqual(replacement);
    } catch (error) {
      throw new Error(`PID cleanup ownership test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses legacy, permissive, and oversized markers", async () => {
    const fixtures: Array<{ name: string; write(path: string): void; expected: RegExp }> = [
      { name: "legacy", write: (path) => writePrivateRecord(path, `${process.pid}\n`), expected: /invalid or legacy schema/ },
      {
        name: "oversized",
        write: (path) => writePrivateRecord(path, "x".repeat(4_097)),
        expected: /larger than 4 KiB/,
      },
    ];
    if (process.platform !== "win32") {
      fixtures.push({
        name: "permissive",
        write: (path) => {
          writePrivateRecord(path, record());
          chmodSync(path, 0o644);
        },
        expected: /permissions are not private/,
      });
    }

    try {
      for (const fixture of fixtures) {
        const { root, pidFile } = sandbox(`pid-${fixture.name}`);
        try {
          fixture.write(pidFile);
          const inspection = await inspectDaemonPidFile(pidFile);
          expect(inspection.kind).toBe("unsafe");
          if (inspection.kind === "unsafe") expect(inspection.reason).toMatch(fixture.expected);
          await expect(claimDaemonPidFile(pidFile)).rejects.toThrow(/refusing unsafe daemon marker/);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    } catch (error) {
      throw new Error(`unsafe PID marker test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });

  test("refuses symlink and non-file markers without changing their targets", async () => {
    if (process.platform === "win32") return;
    const { root, pidFile } = sandbox("pid-symlink");
    const target = join(root, "target");
    try {
      writePrivateRecord(target, "do-not-touch");
      symlinkSync(target, pidFile);

      const inspection = await inspectDaemonPidFile(pidFile);
      expect(inspection.kind).toBe("unsafe");
      if (inspection.kind === "unsafe") expect(inspection.reason).toMatch(/symbolic link/);
      await expect(claimDaemonPidFile(pidFile)).rejects.toThrow(/unsafe daemon marker/);
      expect(readFileSync(target, "utf8")).toBe("do-not-touch");

      unlinkSync(pidFile);
      // A directory at the marker path is also rejected rather than removed.
      mkdirSync(pidFile);
      expect((await inspectDaemonPidFile(pidFile)).kind).toBe("unsafe");
      await expect(claimDaemonPidFile(pidFile)).rejects.toThrow(/unsafe daemon marker/);
      expect(lstatSync(pidFile).isDirectory()).toBe(true);
    } catch (error) {
      throw new Error(`symlink PID marker test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not chmod embedder-owned parents and rejects writable shared parents", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "cicero-pid-parent-"));
    const safeParent = join(root, "safe");
    const writableParent = join(root, "writable");
    let lease: DaemonPidLease | undefined;
    try {
      mkdirSync(safeParent, { mode: 0o755 });
      chmodSync(safeParent, 0o755);
      lease = await claimDaemonPidFile(join(safeParent, "cicero.pid"));
      expect(lstatSync(safeParent).mode & 0o777).toBe(0o755);
      await lease.release();
      lease = undefined;

      mkdirSync(writableParent, { mode: 0o777 });
      chmodSync(writableParent, 0o777);
      await expect(claimDaemonPidFile(join(writableParent, "cicero.pid"))).rejects.toThrow(/group\/world-writable/);
      expect(lstatSync(writableParent).mode & 0o777).toBe(0o777);
    } catch (error) {
      throw new Error(`PID parent safety test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      await lease?.release().catch(() => { /* test cleanup */ });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
