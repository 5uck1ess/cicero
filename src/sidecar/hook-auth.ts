import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { ciceroPath } from "../platform/paths";
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
} from "../platform/secure-storage";

const TOKEN_MIN_BYTES = 32;
const TOKEN_MAX_BYTES = 256;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readToken(tokenPath: string): Promise<string> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(tokenPath, constants.O_RDONLY | noFollow);
  } catch (error: unknown) {
    if (hasCode(error, "ELOOP")) {
      throw new Error(`Refusing symlinked Cicero hook token: ${tokenPath}`);
    }
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`Cicero hook token is not a regular file: ${tokenPath}`);
    }
    if (stat.size > TOKEN_MAX_BYTES + 1) {
      throw new Error(`Cicero hook token is unexpectedly large: ${tokenPath}`);
    }
    const token = (await handle.readFile("utf8")).trim();
    const bytes = Buffer.byteLength(token);
    if (bytes < TOKEN_MIN_BYTES || bytes > TOKEN_MAX_BYTES || /\s/.test(token)) {
      throw new Error(`Cicero hook token is malformed: ${tokenPath}`);
    }
    return token;
  } finally {
    await handle.close();
  }
}

/**
 * Load the shared Claude Code hook credential, creating it atomically on first
 * use. Both `cicero hook install` and `cicero hook start` call this function,
 * so their Authorization values cannot silently drift apart.
 */
export async function loadOrCreateHookToken(
  tokenPath = ciceroPath("hook-token"),
): Promise<string> {
  const parent = dirname(tokenPath);
  ensurePrivateDirectorySync(parent);

  const token = randomBytes(32).toString("base64url");
  const temporaryPath = `${tokenPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | null = null;
  try {
    handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    try {
      // A hard-link publishes the fully written inode without replacing an
      // existing token created by a concurrent installer/receiver process.
      await link(temporaryPath, tokenPath);
    } catch (error: unknown) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  } finally {
    await handle?.close();
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) throw error;
    });
  }

  // Reuse the shared Cicero-owned storage policy for mode/symlink checks.
  // readToken still opens O_NOFOLLOW so a same-user path swap cannot redirect
  // the credential read after this structural validation.
  ensurePrivateFileSync(tokenPath);
  return readToken(tokenPath);
}
