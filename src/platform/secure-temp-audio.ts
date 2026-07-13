import { randomUUID } from "node:crypto";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRIVATE_FILE_MODE } from "./secure-storage";

const MAX_CREATE_ATTEMPTS = 10;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SecureTempAudioOptions {
  /** Filename prefix only; path separators are rejected. */
  prefix?: string;
  /** Injectable location and randomness keep collision behavior testable. */
  directory?: string;
  randomId?: () => string;
}

function safeComponent(value: string, label: string): string {
  if (!SAFE_COMPONENT.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, dots, underscores, or hyphens`);
  }
  return value;
}

function audioBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/**
 * Write sensitive generated/captured audio to an unpredictable OS-temp path.
 *
 * Node's fs.open is intentional here: Bun.write does not offer atomic exclusive
 * creation plus a creation mode. `wx` prevents an existing file or symlink from
 * being followed/clobbered, and 0600 keeps speech private on POSIX systems.
 */
export async function writeSecureTempAudio(
  data: ArrayBuffer | ArrayBufferView,
  options: SecureTempAudioOptions = {},
): Promise<string> {
  const prefix = safeComponent(options.prefix ?? "cicero-audio", "temporary-audio prefix");
  const directory = options.directory ?? tmpdir();
  const makeId = options.randomId ?? randomUUID;
  const bytes = audioBytes(data);

  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    const id = safeComponent(makeId(), "temporary-audio random id");
    const path = join(directory, `${prefix}-${id}.wav`);
    let handle: FileHandle | undefined;

    try {
      handle = await open(path, "wx", PRIVATE_FILE_MODE);
    } catch (error: unknown) {
      if (isAlreadyExists(error)) continue;
      throw error;
    }

    let writeFailed = false;
    try {
      // open(2) applies the process umask to its creation mode. Repair the
      // descriptor itself so a restrictive service umask cannot leave mode
      // 000 and make the closed WAV unreadable by the spawned audio player.
      if (process.platform !== "win32") await handle.chmod(PRIVATE_FILE_MODE);
      await handle.writeFile(bytes);
      await handle.close();
      handle = undefined;
      return path;
    } catch (error: unknown) {
      writeFailed = true;
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => { /* best-effort close before cleanup */ });
      if (writeFailed) await unlink(path).catch(() => { /* best-effort partial-file cleanup */ });
    }
  }

  throw new Error(`could not create a unique temporary audio file after ${MAX_CREATE_ATTEMPTS} attempts`);
}
