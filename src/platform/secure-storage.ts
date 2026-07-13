import { chmodSync, lstatSync, mkdirSync } from "node:fs";

/** Private modes used for Cicero's local configuration and speech-adjacent data. */
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function describe(path: string, kind: "directory" | "file"): Error {
  return new Error(`refusing unsafe private ${kind} path '${path}'`);
}

/**
 * Create a private directory, or tighten an existing directory in place.
 *
 * A symlink is rejected instead of chmodding the object it points at. This is
 * important for callers that subsequently write secrets or recursively delete
 * children beneath the directory.
 */
export function ensurePrivateDirectorySync(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw describe(path, "directory");

  // Windows does not implement POSIX ownership bits. The containing directory
  // is still created normally there; ACLs remain under the user's profile.
  if (process.platform !== "win32") chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

/** Tighten an existing private file without ever following a symlink. */
export function ensurePrivateFileSync(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw describe(path, "file");
  if (process.platform !== "win32" && (info.mode & 0o777) !== PRIVATE_FILE_MODE) {
    chmodSync(path, PRIVATE_FILE_MODE);
  }
}

/** Tighten a file when present, including rejecting dangling symlinks. */
export function ensurePrivateFileIfExistsSync(path: string): boolean {
  try {
    ensurePrivateFileSync(path);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
