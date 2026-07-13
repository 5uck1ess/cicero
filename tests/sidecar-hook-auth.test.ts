import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateHookToken } from "../src/sidecar/hook-auth";

test("creates one durable private token across concurrent callers", async () => {
  const home = mkdtempSync(join(tmpdir(), "cicero-hook-auth-"));
  const tokenPath = join(home, "hook-token");
  try {
    if (process.platform !== "win32") chmodSync(home, 0o755);
    const tokens = await Promise.all(
      Array.from({ length: 12 }, () => loadOrCreateHookToken(tokenPath)),
    );

    expect(new Set(tokens).size).toBe(1);
    expect(Buffer.byteLength(tokens[0] ?? "")).toBeGreaterThanOrEqual(32);
    expect(readdirSync(home)).toEqual(["hook-token"]);
    if (process.platform !== "win32") {
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
      expect(statSync(home).mode & 0o777).toBe(0o700);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("refuses malformed token files instead of silently rotating credentials", async () => {
  const home = mkdtempSync(join(tmpdir(), "cicero-hook-auth-"));
  const tokenPath = join(home, "hook-token");
  try {
    writeFileSync(tokenPath, "short\n", { mode: 0o644 });
    await expect(loadOrCreateHookToken(tokenPath)).rejects.toThrow("token is malformed");
    if (process.platform !== "win32") {
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "refuses a symlinked token file",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-hook-auth-"));
    const tokenPath = join(home, "hook-token");
    const target = join(home, "target");
    try {
      writeFileSync(target, "this-token-is-long-enough-to-look-valid-123456\n");
      symlinkSync(target, tokenPath);
      await expect(loadOrCreateHookToken(tokenPath)).rejects.toThrow(/symlinked|ELOOP|unsafe private file/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
