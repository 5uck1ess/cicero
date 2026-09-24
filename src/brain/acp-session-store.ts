import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { unlink } from "node:fs/promises";
import { ciceroPath } from "../platform/paths";
import { readPrivateJson, writePrivateJson } from "../platform/private-json";
import { ensurePrivateDirectorySync, ensurePrivateFileIfExistsSync } from "../platform/secure-storage";

const MAX_SESSION_ID = 512;

export function acpSessionFilePath(key: string): string {
  return join(ciceroPath("acp-sessions"), `${createHash("sha256").update(key).digest("hex")}.json`);
}

export interface StoredAcpSession { sessionId: string; lastUsedAt: number }

export async function readAcpSession(path: string, identity: string): Promise<StoredAcpSession | null> {
  let data: unknown;
  try { data = await readPrivateJson(path, 2048); }
  catch (error) {
    // A truncated write can be discarded; unsafe paths and over-limit data
    // remain errors so neither is silently replaced.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  return value.identity === identity && typeof value.sessionId === "string"
    && value.sessionId.length > 0 && value.sessionId.length <= MAX_SESSION_ID
    && typeof value.lastUsedAt === "number" && Number.isSafeInteger(value.lastUsedAt)
    && value.lastUsedAt >= 0
    ? { sessionId: value.sessionId, lastUsedAt: value.lastUsedAt } : null;
}

export async function writeAcpSession(path: string, identity: string, sessionId: string, lastUsedAt: number): Promise<void> {
  if (!sessionId || sessionId.length > MAX_SESSION_ID) throw new Error("invalid ACP session id");
  if (!Number.isSafeInteger(lastUsedAt) || lastUsedAt < 0) throw new Error("invalid ACP session timestamp");
  await writePrivateJson(path, { identity, sessionId, lastUsedAt });
}

/** Discard an explicit reset's pointer without following an unsafe path. */
export async function clearAcpSession(path: string): Promise<void> {
  ensurePrivateDirectorySync(dirname(path));
  if (ensurePrivateFileIfExistsSync(path)) await unlink(path);
}
