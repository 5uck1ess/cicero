import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePrivateDirectorySync,
  ensurePrivateFileIfExistsSync,
  ensurePrivateFileSync,
} from "../../src/platform/secure-storage";

const posix = process.platform !== "win32";
const roots: string[] = [];

function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), "cicero-private-"));
  roots.push(root);
  return root;
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!posix)("private storage modes", () => {
  test("creates directories as 0700 and tightens existing directories", () => {
    const root = fresh();
    const dir = join(root, "data");
    ensurePrivateDirectorySync(dir);
    expect(mode(dir)).toBe(0o700);

    chmodSync(dir, 0o755);
    ensurePrivateDirectorySync(dir);
    expect(mode(dir)).toBe(0o700);
  });

  test("tightens existing files to 0600", () => {
    const root = fresh();
    const file = join(root, "private.jsonl");
    writeFileSync(file, "private", { mode: 0o644 });
    ensurePrivateFileSync(file);
    expect(mode(file)).toBe(0o600);
    expect(ensurePrivateFileIfExistsSync(join(root, "absent"))).toBe(false);
  });
});

test.skipIf(process.platform === "win32")("private storage rejects file and directory symlinks", () => {
  const root = fresh();
  const targetDir = join(root, "target");
  const targetFile = join(root, "target.txt");
  ensurePrivateDirectorySync(targetDir);
  writeFileSync(targetFile, "private");
  symlinkSync(targetDir, join(root, "dir-link"), "dir");
  symlinkSync(targetFile, join(root, "file-link"), "file");

  expect(() => ensurePrivateDirectorySync(join(root, "dir-link"))).toThrow(/unsafe/);
  expect(() => ensurePrivateFileSync(join(root, "file-link"))).toThrow(/unsafe/);
});
