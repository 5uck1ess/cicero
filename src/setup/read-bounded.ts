import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/**
 * Read a regular file of at most `maxBytes` as UTF-8. The open never blocks on
 * a FIFO, anything but a regular file is refused, and a file that grows past
 * the limit after the size check still stops at `maxBytes + 1` bytes read.
 */
export function readBoundedText(path: string, maxBytes: number, label = "the file"): string {
  const nonBlock = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  const fd = openSync(path, constants.O_RDONLY | nonBlock);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`${label} is not a regular file`);
    const tooLarge = `${label} is larger than ${Math.round(maxBytes / 1024)} KB`;
    if (info.size > maxBytes) throw new Error(tooLarge);
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > maxBytes) throw new Error(tooLarge);
    return bytes.toString("utf8", 0, size);
  } finally { closeSync(fd); }
}
