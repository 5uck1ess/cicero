import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup } from "../../src/cli/setup";
import { detectAccounts } from "../../src/setup/accounts";
import { readBoundedText } from "../../src/setup/read-bounded";

function withDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cicero-bounded-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("a bounded read returns a small file and refuses a large one or a directory", () => withDir((dir) => {
  writeFileSync(join(dir, "small"), "hello");
  writeFileSync(join(dir, "big"), "x".repeat(2048));
  expect(readBoundedText(join(dir, "small"), 1024)).toBe("hello");
  expect(() => readBoundedText(join(dir, "big"), 1024, "the answers file")).toThrow("the answers file is larger than 1 KB");
  expect(() => readBoundedText(dir, 1024)).toThrow();
}));

test.skipIf(process.platform === "win32")("a FIFO is refused without blocking", () => withDir((dir) => {
  const fifo = join(dir, "pipe");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  expect(() => readBoundedText(fifo, 1024, "the answers file")).toThrow("the answers file is not a regular file");
}));

test("setup --apply refuses an oversized answers file before parsing it", () => withDir(async (dir) => {
  const path = join(dir, "answers.json");
  writeFileSync(path, `{"pad":"${"x".repeat(300 * 1024)}"}`);
  await expect(runSetup({ apply: path })).rejects.toThrow("larger than 256 KB");
}));

test("setup --apply never echoes answers-file text from a JSON syntax error", () => withDir(async (dir) => {
  const path = join(dir, "answers.json");
  writeFileSync(path, '{"version": 1, "steps": SYNTHETIC_KEY_12345678901234567890}');
  const error = await runSetup({ apply: path }).then(() => null, (e: unknown) => e as Error);
  expect(error?.message).toContain("is not valid JSON");
  expect(error?.message).not.toContain("SYNTHETIC_KEY");
}));

test.skipIf(process.platform === "win32")("a credential path that is a FIFO reads as not found instead of hanging", () => withDir(async (dir) => {
  const claude = join(dir, ".claude");
  Bun.spawnSync(["mkdir", claude]);
  expect(Bun.spawnSync(["mkfifo", join(claude, ".credentials.json")]).exitCode).toBe(0);
  const accounts = await detectAccounts({ env: {}, homeDir: () => dir, which: () => null, platform: "linux" });
  expect(accounts.agents.find((a) => a.provider === "claude")?.login).toBe("not found");
}));
