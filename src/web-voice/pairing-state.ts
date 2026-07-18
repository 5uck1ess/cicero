import {
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ciceroHome } from "../platform/paths";
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDirectorySync,
  ensurePrivateFileIfExistsSync,
  ensurePrivateFileSync,
} from "../platform/secure-storage";
import type { TunnelProvider } from "./tunnel";

const MAX_PAIRING_STATE_BYTES = 8 * 1024;

export interface PairingState {
  scheme: "http" | "https";
  port: number;
  lanHost: string | null;
  tunnelProvider: TunnelProvider | null;
  /** Public origin only. This field can never contain a query credential. */
  tunnelUrl: string | null;
  startedAt: string;
  pid: number;
}

export interface PairingStateReadOptions {
  pidAlive?: (pid: number) => boolean;
}

export function webVoicePairingStatePath(home: string = ciceroHome()): string {
  return join(home, "web-voice", "pairing.json");
}

/** Best-effort, non-loopback IPv4 address for the phone-facing LAN URL. */
export function bestEffortLanIPv4(
  interfaces?: ReturnType<typeof networkInterfaces>,
): string | null {
  let available: ReturnType<typeof networkInterfaces>;
  try {
    available = interfaces ?? networkInterfaces();
  } catch {
    return null;
  }
  for (const entries of Object.values(available)) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === "IPv4" && isIPv4(entry.address)) return entry.address;
    }
  }
  return null;
}

function publicOrigin(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 2_048) throw new Error("invalid pairing tunnel URL");
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
  ) {
    throw new Error("invalid pairing tunnel URL");
  }
  return parsed.origin;
}

function normalizedState(value: unknown): PairingState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid pairing state");
  }
  const row = value as Record<string, unknown>;
  const scheme = row.scheme;
  const port = row.port;
  const lanHost = row.lanHost;
  const tunnelProvider = row.tunnelProvider;
  const startedAt = row.startedAt;
  const pid = row.pid;
  if (scheme !== "http" && scheme !== "https") throw new Error("invalid pairing scheme");
  if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    throw new Error("invalid pairing port");
  }
  if (lanHost !== null && (typeof lanHost !== "string" || !isIPv4(lanHost))) {
    throw new Error("invalid pairing LAN host");
  }
  if (
    tunnelProvider !== null
    && tunnelProvider !== "tailscale"
    && tunnelProvider !== "cloudflared"
  ) {
    throw new Error("invalid pairing tunnel provider");
  }
  if (
    typeof startedAt !== "string"
    || startedAt.length > 64
    || !Number.isFinite(Date.parse(startedAt))
  ) {
    throw new Error("invalid pairing start time");
  }
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) throw new Error("invalid pairing PID");
  return {
    scheme,
    port: port as number,
    lanHost,
    tunnelProvider,
    tunnelUrl: publicOrigin(row.tunnelUrl),
    startedAt,
    pid: pid as number,
  };
}

function readStoredState(path: string): PairingState | null {
  if (!ensurePrivateFileIfExistsSync(path)) return null;
  if (statSync(path).size > MAX_PAIRING_STATE_BYTES) throw new Error("pairing state exceeds size limit");
  const bytes = readFileSync(path, "utf8");
  return normalizedState(JSON.parse(bytes));
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read state only while the publishing daemon PID is alive. */
export function readPairingState(
  path: string = webVoicePairingStatePath(),
  options: PairingStateReadOptions = {},
): PairingState | null {
  const state = readStoredState(path);
  if (!state) return null;
  return (options.pidAlive ?? defaultPidAlive)(state.pid) ? state : null;
}

/** Atomically publish a credential-free owner-only state snapshot. */
export function writePairingState(
  state: PairingState,
  path: string = webVoicePairingStatePath(),
): void {
  const normalized = normalizedState(state);
  const bytes = `${JSON.stringify(normalized)}\n`;
  if (Buffer.byteLength(bytes) > MAX_PAIRING_STATE_BYTES) {
    throw new Error("pairing state exceeds size limit");
  }
  ensurePrivateDirectorySync(dirname(path));
  ensurePrivateFileIfExistsSync(path);
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, bytes, { flag: "wx", mode: PRIVATE_FILE_MODE });
    ensurePrivateFileSync(tmp);
    renameSync(tmp, path);
    ensurePrivateFileSync(path);
  } catch (error: unknown) {
    try { unlinkSync(tmp); } catch { /* absent after rename, or best-effort cleanup */ }
    throw error;
  }
}

/** Remove only this daemon's publication, leaving a newer owner's state intact. */
export function removePairingState(
  path: string = webVoicePairingStatePath(),
  ownerPid: number = process.pid,
): void {
  const state = readStoredState(path);
  if (state?.pid !== ownerPid) return;
  unlinkSync(path);
}
