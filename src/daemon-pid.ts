import { constants, lstatSync } from "node:fs";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { ensurePrivateDirectorySync, PRIVATE_FILE_MODE } from "./platform/secure-storage";

const PID_RECORD_VERSION = 1 as const;
const MAX_PID_RECORD_BYTES = 4_096;
const PID_REUSE_RECHECK_DELAY_MS = 5;

export interface DaemonPidRecord {
  version: typeof PID_RECORD_VERSION;
  pid: number;
  identity: string;
  token: string;
  createdAt: string;
}

export type DaemonPidInspection =
  | { kind: "absent" }
  | { kind: "running"; record: DaemonPidRecord }
  | { kind: "stale"; record: DaemonPidRecord; reason: string }
  | { kind: "unsafe"; reason: string };

export type DaemonStopResult =
  | { kind: "signaled"; pid: number }
  | { kind: "not-running"; reason?: string }
  | { kind: "unsafe"; reason: string };

type ProcessIdentity =
  | { kind: "identified"; value: string }
  | { kind: "not-running" }
  | { kind: "unsupported"; reason: string };

export interface DaemonPidLease {
  readonly record: DaemonPidRecord;
  release(): Promise<void>;
}

interface StopDependencies {
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

function errno(error: unknown): NodeJS.ErrnoException {
  return error as NodeJS.ErrnoException;
}

function ensureSafePidParent(path: string): void {
  const parent = dirname(path);
  try {
    const info = lstatSync(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`refusing unsafe daemon marker directory '${parent}'`);
    }
    // Do not chmod an embedder-owned parent (which might be a project or shared
    // system directory). It only needs to reject directories where another
    // account could swap the marker path underneath this process.
    if (process.platform !== "win32" && (info.mode & 0o022) !== 0) {
      throw new Error(`refusing group/world-writable daemon marker directory '${parent}'`);
    }
  } catch (error) {
    if (errno(error).code !== "ENOENT") throw error;
    ensurePrivateDirectorySync(parent);
  }
}

function isPositivePid(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= 2_147_483_647;
}

function isPidRecord(value: unknown): value is DaemonPidRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === PID_RECORD_VERSION
    && isPositivePid(record.pid)
    && typeof record.identity === "string"
    && record.identity.length > 0
    && record.identity.length <= 1_024
    && typeof record.token === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.token)
    && typeof record.createdAt === "string"
    && Number.isFinite(Date.parse(record.createdAt));
}

async function readLinuxIdentity(pid: number): Promise<ProcessIdentity> {
  try {
    const [stat, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    // The command name is parenthesized and may itself contain spaces or `)`.
    // Field 3 starts after the final `) `; process start ticks are field 22.
    const commandEnd = stat.lastIndexOf(") ");
    if (commandEnd < 0) return { kind: "unsupported", reason: "malformed /proc process metadata" };
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const state = fields[0];
    const startTicks = fields[19];
    if (state === "Z" || state === "X") return { kind: "not-running" };
    if (!startTicks || !/^\d+$/.test(startTicks)) {
      return { kind: "unsupported", reason: "missing /proc process start time" };
    }
    const boot = bootId.trim();
    if (!boot) return { kind: "unsupported", reason: "missing Linux boot identity" };
    return { kind: "identified", value: `linux:${boot}:${startTicks}` };
  } catch (error) {
    if (errno(error).code === "ENOENT" || errno(error).code === "ESRCH") return { kind: "not-running" };
    return {
      kind: "unsupported",
      reason: `cannot read Linux process identity: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function readPsIdentity(pid: number): Promise<ProcessIdentity> {
  try {
    // BSD/macOS expose start time at one-second resolution. Bind the identity
    // to the uid and full command as well so a rapid PID reuse by another Bun
    // process cannot match merely because its executable name is also `bun`.
    const proc = Bun.spawn([
      "ps",
      "-ww",
      "-p",
      String(pid),
      "-o",
      "lstart=",
      "-o",
      "uid=",
      "-o",
      "command=",
    ], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      if (exitCode === 1) return { kind: "not-running" };
      return { kind: "unsupported", reason: stderr.trim() || `ps exited with status ${exitCode}` };
    }
    const value = stdout.trim().replace(/\s+/g, " ");
    if (!value) return { kind: "not-running" };
    return { kind: "identified", value: `${process.platform}:${value}` };
  } catch (error) {
    return {
      kind: "unsupported",
      reason: `cannot query process start time: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function readWindowsIdentity(pid: number): Promise<ProcessIdentity> {
  try {
    const command = [
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
      "if ($null -eq $p) { exit 3 }",
      "$path = if ($null -eq $p.Path) { '' } else { $p.Path }",
      "Write-Output ($p.StartTime.ToUniversalTime().Ticks.ToString() + '|' + $path)",
    ].join("; ");
    const proc = Bun.spawn([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode === 3) return { kind: "not-running" };
    if (exitCode !== 0) {
      return { kind: "unsupported", reason: stderr.trim() || `PowerShell exited with status ${exitCode}` };
    }
    const value = stdout.trim();
    if (!value) return { kind: "unsupported", reason: "PowerShell returned no process identity" };
    return { kind: "identified", value: `win32:${value}` };
  } catch (error) {
    return {
      kind: "unsupported",
      reason: `cannot query Windows process start time: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function processIdentity(pid: number): Promise<ProcessIdentity> {
  try {
    if (!isPositivePid(pid)) return { kind: "not-running" };
    if (process.platform === "linux") return await readLinuxIdentity(pid);
    if (process.platform === "win32") return await readWindowsIdentity(pid);
    if (["darwin", "freebsd", "openbsd", "netbsd", "aix", "sunos"].includes(process.platform)) {
      return await readPsIdentity(pid);
    }
    return { kind: "unsupported", reason: `process identity is unsupported on ${process.platform}` };
  } catch (error) {
    return {
      kind: "unsupported",
      reason: `process identity lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function readRecord(path: string): Promise<{ record: DaemonPidRecord; dev: bigint; ino: bigint } | { error: string } | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) return { error: "marker is not a regular file" };
    if (info.size > BigInt(MAX_PID_RECORD_BYTES)) return { error: "marker is larger than 4 KiB" };
    if (process.platform !== "win32") {
      const getuid = process.getuid;
      if (getuid && info.uid !== BigInt(getuid())) return { error: "marker is owned by another user" };
      if ((info.mode & 0o077n) !== 0n) return { error: "marker permissions are not private (expected mode 0600)" };
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: "marker is not a versioned JSON record" };
    }
    if (!isPidRecord(parsed)) return { error: "marker has an invalid or legacy schema" };
    return { record: parsed, dev: info.dev, ino: info.ino };
  } catch (error) {
    if (errno(error).code === "ENOENT") return null;
    if (errno(error).code === "ELOOP") return { error: "marker is a symbolic link" };
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    await handle?.close().catch(() => { /* best-effort read handle cleanup */ });
  }
}

/** Inspect a marker without trusting the PID alone. */
export async function inspectDaemonPidFile(path: string): Promise<DaemonPidInspection> {
  try {
    const snapshot = await readRecord(path);
    if (snapshot === null) return { kind: "absent" };
    if ("error" in snapshot) return { kind: "unsafe", reason: snapshot.error };
    const identity = await processIdentity(snapshot.record.pid);
    if (identity.kind === "not-running") {
      return { kind: "stale", record: snapshot.record, reason: "recorded process no longer exists" };
    }
    if (identity.kind === "unsupported") return { kind: "unsafe", reason: identity.reason };
    if (identity.value !== snapshot.record.identity) {
      return { kind: "stale", record: snapshot.record, reason: "PID now belongs to a different process instance" };
    }
    return { kind: "running", record: snapshot.record };
  } catch (error) {
    return { kind: "unsafe", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function createPidRecord(path: string, record: DaemonPidRecord): Promise<boolean> {
  const pendingPath = `${path}.pending-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    handle = await open(
      pendingPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      PRIVATE_FILE_MODE,
    );
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    // Tighten the inode through the already-open handle. A pathname chmod here
    // would reintroduce a symlink-swap window after the exclusive open.
    if (process.platform !== "win32") await handle.chmod(PRIVATE_FILE_MODE);
    await handle.close();
    handle = undefined;

    // Publish a fully-written inode with an atomic hard link. A crash before
    // this point can leave only an irrelevant pending file, never a truncated
    // marker that blocks future recovery. link() also refuses an existing path.
    try {
      await link(pendingPath, path);
      return true;
    } catch (error) {
      if (errno(error).code === "EEXIST") return false;
      throw error;
    }
  } catch (error) {
    throw error;
  } finally {
    await handle?.close().catch(() => { /* best-effort write handle cleanup */ });
    await unlink(pendingPath).catch(() => { /* absent after cleanup or a failed open */ });
  }
}

async function unlinkSnapshot(path: string, expected: { dev: bigint; ino: bigint }): Promise<boolean> {
  const snapshotPath = `${path}.snapshot-${process.pid}-${randomUUID()}`;
  try {
    // A hard link pins the exact inode that was inspected. If another starter
    // replaces the path, the inode comparison fails and we leave its marker alone.
    await link(path, snapshotPath);
    const [current, snapshot] = await Promise.all([
      lstat(path, { bigint: true }),
      lstat(snapshotPath, { bigint: true }),
    ]);
    if (snapshot.dev !== expected.dev || snapshot.ino !== expected.ino) return false;
    if (current.dev !== snapshot.dev || current.ino !== snapshot.ino) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (["ENOENT", "EEXIST"].includes(errno(error).code ?? "")) return false;
    throw error;
  } finally {
    await unlink(snapshotPath).catch(() => { /* snapshot may never have been linked */ });
  }
}

async function retireStaleRecord(path: string, expectedToken: string): Promise<boolean> {
  try {
    const snapshot = await readRecord(path);
    if (!snapshot || "error" in snapshot || snapshot.record.token !== expectedToken) return false;
    const identity = await processIdentity(snapshot.record.pid);
    if (identity.kind === "identified" && identity.value === snapshot.record.identity) return false;
    if (identity.kind === "unsupported") return false;
    return await unlinkSnapshot(path, snapshot);
  } catch (error) {
    throw new Error(`failed to retire stale daemon marker: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Atomically claim the daemon marker and return an ownership-checked lease. */
export async function claimDaemonPidFile(path: string): Promise<DaemonPidLease> {
  try {
    ensureSafePidParent(path);
    const identity = await processIdentity(process.pid);
    if (identity.kind !== "identified") {
      const reason = identity.kind === "unsupported" ? identity.reason : "current process disappeared";
      throw new Error(`cannot establish daemon process identity: ${reason}`);
    }
    const record: DaemonPidRecord = {
      version: PID_RECORD_VERSION,
      pid: process.pid,
      identity: identity.value,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    };

    for (let attempt = 0; attempt < 8; attempt++) {
      if (await createPidRecord(path, record)) {
        let released = false;
        return {
          record,
          release: async () => {
            try {
              if (released) return;
              const snapshot = await readRecord(path);
              if (!snapshot || "error" in snapshot || snapshot.record.token !== record.token) {
                released = true;
                return;
              }
              await unlinkSnapshot(path, snapshot);
              released = true;
            } catch (error) {
              throw new Error(`failed to release daemon marker: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
            }
          },
        };
      }

      const inspection = await inspectDaemonPidFile(path);
      if (inspection.kind === "running") {
        throw new Error(`Cicero is already running (pid ${inspection.record.pid})`);
      }
      if (inspection.kind === "unsafe") {
        throw new Error(`refusing unsafe daemon marker '${path}': ${inspection.reason}`);
      }
      if (inspection.kind === "absent") continue;
      if (!await retireStaleRecord(path, inspection.record.token)) {
        await Bun.sleep(PID_REUSE_RECHECK_DELAY_MS);
      }
    }
    throw new Error(`could not claim daemon marker '${path}' because it changed repeatedly`);
  } catch (error) {
    throw new Error(`daemon PID claim failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Signal only the exact process instance named by a private, versioned marker. */
export async function stopDaemonFromPidFile(
  path: string,
  dependencies: StopDependencies = {},
): Promise<DaemonStopResult> {
  try {
    const first = await inspectDaemonPidFile(path);
    if (first.kind === "absent") return { kind: "not-running" };
    if (first.kind === "stale") return { kind: "not-running", reason: first.reason };
    if (first.kind === "unsafe") return { kind: "unsafe", reason: first.reason };

    // Re-read immediately before signaling. This closes the practical PID-reuse
    // window and, unlike the old integer marker, never trusts liveness alone.
    const second = await inspectDaemonPidFile(path);
    if (second.kind !== "running" || second.record.token !== first.record.token) {
      return second.kind === "unsafe"
        ? { kind: "unsafe", reason: second.reason }
        : { kind: "not-running", reason: "daemon identity changed before it could be stopped" };
    }
    try {
      (dependencies.kill ?? process.kill)(second.record.pid, "SIGTERM");
      return { kind: "signaled", pid: second.record.pid };
    } catch (error) {
      if (errno(error).code === "ESRCH") return { kind: "not-running", reason: "daemon exited before SIGTERM" };
      throw error;
    }
  } catch (error) {
    return { kind: "unsafe", reason: error instanceof Error ? error.message : String(error) };
  }
}
