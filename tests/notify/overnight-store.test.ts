import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OvernightStore } from "../../src/notify/overnight-store";

const roots: string[] = [];

function fresh(): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "cicero-overnight-"));
  roots.push(root);
  return { root, file: join(root, "overnight.json") };
}

function store(file: string): OvernightStore {
  let id = 0;
  return new OvernightStore(file, () => 1_700_000_000_000 + id, () => `item-${++id}`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("peek is non-consuming", async () => {
  const { file } = fresh();
  const queue = store(file);
  await queue.enqueue("one");
  expect((await queue.peek()).map((item) => item.text)).toEqual(["one"]);
  expect((await queue.peek()).map((item) => item.text)).toEqual(["one"]);
});

test("ack removes only the captured snapshot and preserves concurrent enqueue", async () => {
  const { file } = fresh();
  const queue = store(file);
  await queue.enqueue("one");
  const snapshot = await queue.peek();
  const adding = queue.enqueue("two");
  const acknowledging = queue.ack(snapshot.map((item) => item.id));
  await Promise.all([adding, acknowledging]);
  expect((await queue.peek()).map((item) => item.text)).toEqual(["two"]);
});

test("legacy string arrays migrate on read", async () => {
  const { file } = fresh();
  writeFileSync(file, JSON.stringify(["one", "two"]), { mode: 0o600 });
  const queue = store(file);
  const items = await queue.peek();
  expect(items.map((item) => item.text)).toEqual(["one", "two"]);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(items);
});

test("corrupt files are tolerated and the next enqueue recovers", async () => {
  const { file } = fresh();
  writeFileSync(file, "{broken", { mode: 0o600 });
  const queue = store(file);
  expect(await queue.peek()).toEqual([]);
  await queue.enqueue("recovered");
  expect((await queue.peek()).map((item) => item.text)).toEqual(["recovered"]);
});

test("oversized and structurally invalid files cannot wedge peek or ack", async () => {
  const { file } = fresh();
  writeFileSync(file, `"${"x".repeat(1_000_001)}"`, { mode: 0o600 });
  const queue = store(file);
  expect(await queue.peek()).toEqual([]);
  await queue.ack(["missing"]);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);

  writeFileSync(file, JSON.stringify({ items: "not-an-array" }), { mode: 0o600 });
  expect(await queue.peek()).toEqual([]);
  await queue.ack(["missing"]);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
});

test.skipIf(process.platform === "win32")("unsafe file and directory symlinks are rejected", () => {
  const { root, file } = fresh();
  const target = join(root, "target.json");
  writeFileSync(target, "[]", { mode: 0o600 });
  symlinkSync(target, file, "file");
  expect(() => store(file)).toThrow(/unsafe private file path/);

  const real = join(root, "real");
  const linked = join(root, "linked");
  mkdirSync(real);
  symlinkSync(real, linked, "dir");
  expect(() => store(join(linked, "overnight.json"))).toThrow(/unsafe private directory path/);
  expect(lstatSync(linked).isSymbolicLink()).toBe(true);
});

test.skipIf(process.platform === "win32")("writes remain private", async () => {
  const { file } = fresh();
  const queue = store(file);
  await queue.enqueue("one");
  expect(lstatSync(file).mode & 0o777).toBe(0o600);
});
