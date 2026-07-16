import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDirectorySync,
  ensurePrivateFileIfExistsSync,
  ensurePrivateFileSync,
} from "./secure-storage";

export const DEFAULT_PRIVATE_JSON_MAX_BYTES = 1_000_000;

export class PrivateJsonTooLargeError extends Error {
  constructor(path: string, maxBytes: number) {
    super(`private JSON file '${path}' exceeds the ${maxBytes}-byte limit`);
    this.name = "PrivateJsonTooLargeError";
  }
}

/** Read a Cicero-owned private JSON file without following file symlinks. */
export async function readPrivateJson(
  path: string,
  maxBytes = DEFAULT_PRIVATE_JSON_MAX_BYTES,
): Promise<unknown | undefined> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive integer");
  ensurePrivateDirectorySync(dirname(path));
  if (!ensurePrivateFileIfExistsSync(path)) return undefined;
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`refusing unsafe private file path '${path}'`);
    if (info.size > maxBytes) throw new PrivateJsonTooLargeError(path, maxBytes);

    // Do not use readFile() here: the inode can grow after stat(), and readFile()
    // would then retain the unbounded replacement contents.
    const bytes = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size > maxBytes) throw new PrivateJsonTooLargeError(path, maxBytes);
    return JSON.parse(bytes.subarray(0, offset).toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

/** Atomically replace a private JSON file through a fresh 0600 sibling inode. */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  ensurePrivateDirectorySync(directory);
  // Reject an existing link explicitly. rename() would not follow it, but
  // silently replacing an unsafe path would hide a storage-policy violation.
  ensurePrivateFileIfExistsSync(path);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    ensurePrivateFileSync(temporary);
    await rename(temporary, path);
    ensurePrivateFileSync(path);

    // Windows cannot open directories as file handles. POSIX directory fsync
    // makes the rename itself durable, rather than only the new inode contents.
    if (process.platform !== "win32") {
      const directoryHandle = await open(directory, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } catch (error: unknown) {
    try { await unlink(temporary); } catch { /* absent after rename, or best-effort cleanup */ }
    throw error;
  }
}
