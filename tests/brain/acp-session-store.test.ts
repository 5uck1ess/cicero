import { test, expect } from "bun:test";
import { mkdtempSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAcpSession, writeAcpSession } from "../../src/brain/acp-session-store";

test("ACP session pointers are private, identity-scoped, and symlink-safe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-acp-store-"));
  const file = join(dir, "session.json");
  await writeAcpSession(file, "agent-a", "session-a", 1_000);
  expect(await readAcpSession(file, "agent-a")).toEqual({ sessionId: "session-a", lastUsedAt: 1_000 });
  expect(await readAcpSession(file, "agent-b")).toBeNull();
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  const link = join(dir, "link.json");
  symlinkSync(file, link);
  await expect(readAcpSession(link, "agent-a")).rejects.toThrow(/unsafe private file/);
  await expect(writeAcpSession(link, "agent-a", "session-b", 2_000)).rejects.toThrow(/unsafe private file/);
});

test("ACP session pointers without a valid last-used time expire", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-acp-legacy-"));
  const file = join(dir, "session.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, JSON.stringify({ identity: "agent-a", sessionId: "legacy" }), { mode: 0o600 });
  expect(await readAcpSession(file, "agent-a")).toBeNull();
  await writeAcpSession(file, "agent-a", "current", 2_000);
  expect(await readAcpSession(file, "agent-a")).toEqual({ sessionId: "current", lastUsedAt: 2_000 });
});
