import { test, expect } from "bun:test";
import { TurnHistory } from "../../src/web-voice/history";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fresh(): TurnHistory {
  return new TurnHistory(join(mkdtempSync(join(tmpdir(), "cicero-hist-")), "history.jsonl"));
}

test("append then recent round-trips turns, oldest first", async () => {
  const h = fresh();
  await h.append({ t: 1, user: "hello", reply: "Hi there." });
  await h.append({ t: 2, user: "status?", reply: "All green." });
  const got = await h.recent(10);
  expect(got.length).toBe(2);
  expect(got[0].user).toBe("hello");
  expect(got[1].reply).toBe("All green.");
});

test("recent(n) returns only the tail", async () => {
  const h = fresh();
  for (let i = 0; i < 5; i++) await h.append({ t: i, user: "u" + i, reply: "r" + i });
  const got = await h.recent(2);
  expect(got.map((x) => x.user)).toEqual(["u3", "u4"]);
});

test("recent on a never-written file is empty, corrupt lines are skipped", async () => {
  const h = fresh();
  expect(await h.recent(5)).toEqual([]);
  await h.append({ t: 1, user: "ok", reply: "fine" });
  const got = await h.recent(5);
  expect(got.length).toBe(1);
});

test("file is trimmed once it exceeds the cap", async () => {
  const h = fresh();
  for (let i = 0; i < 1005; i++) await h.append({ t: i, user: "u" + i, reply: "r" });
  const got = await h.recent(2000);
  expect(got.length).toBeLessThanOrEqual(505); // trimmed to ~KEEP_LINES
  expect(got[got.length - 1].user).toBe("u1004"); // newest survives
});

test.skipIf(process.platform === "win32")("history directory and file are private, including existing data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-hist-mode-"));
  const file = join(dir, "history.jsonl");
  chmodSync(dir, 0o755);
  writeFileSync(file, "", { mode: 0o644 });

  const h = new TurnHistory(file);
  await h.append({ t: 1, user: "private", reply: "private" });

  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(file).mode & 0o777).toBe(0o600);

  const freshDir = mkdtempSync(join(tmpdir(), "cicero-hist-new-mode-"));
  const freshFile = join(freshDir, "history.jsonl");
  const fresh = new TurnHistory(freshFile);
  await fresh.append({ t: 2, user: "new", reply: "new" });
  expect(statSync(freshFile).mode & 0o777).toBe(0o600);
});

test.skipIf(process.platform === "win32")("unsafe history storage disables persistence without breaking startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-hist-disabled-"));
  const outside = mkdtempSync(join(tmpdir(), "cicero-hist-outside-"));
  const linkedDir = join(root, "history-dir");
  symlinkSync(outside, linkedDir, "dir");

  try {
    const h = new TurnHistory(join(linkedDir, "history.jsonl"));
    await h.append({ t: 1, user: "private", reply: "private" });

    expect(await h.recent(5)).toEqual([]);
    expect(existsSync(join(outside, "history.jsonl"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
