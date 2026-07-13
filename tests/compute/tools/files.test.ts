import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createFileTools, type FileTools } from "../../../src/compute/tools/files";
import { classifyAction } from "../../../src/compute/policy";

let dir: string;
let outside: string;
let tools: FileTools;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cicero-files-"));
  outside = mkdtempSync(join(tmpdir(), "cicero-outside-"));
  tools = createFileTools({ root: dir, maxReadBytes: 5 });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("write_file then read_file round-trips", async () => {
  const path = join(dir, "note.txt");
  const w = await tools.writeFileTool.run({ path, content: "hello" });
  expect(w.ok).toBe(true);
  const r = await tools.readFileTool.run({ path });
  expect(r.ok).toBe(true);
  expect(r.output).toBe("hello");
});

test("list_dir reports entries", async () => {
  await tools.writeFileTool.run({ path: join(dir, "a.txt"), content: "x" });
  const result = await tools.listDirTool.run({ path: dir });
  expect(result.ok).toBe(true);
  expect(result.output).toContain("a.txt");
});

test("read_file on a missing path returns ok=false", async () => {
  const result = await tools.readFileTool.run({ path: join(dir, "nope.txt") });
  expect(result.ok).toBe(false);
  expect(result.output.toLowerCase()).toContain("no such");
});

test("rejects absolute, traversal, and symlink escapes from the workspace", async () => {
  const secret = join(outside, "secret.txt");
  writeFileSync(secret, "shh");
  symlinkSync(secret, join(dir, "linked-secret"));

  for (const path of [secret, join(dir, "..", secret.split("/").at(-2)!, "secret.txt"), join(dir, "linked-secret")]) {
    const read = await tools.readFileTool.run({ path });
    expect(read.ok).toBe(false);
    expect(read.output).toContain("outside the compute workspace");
  }

  const write = await tools.writeFileTool.run({ path: secret, content: "overwrite" });
  expect(write.ok).toBe(false);
  expect(Bun.file(secret).text()).resolves.toBe("shh");
});

test("caps file observations before contents reach the model", async () => {
  const path = join(dir, "large.txt");
  writeFileSync(path, "123456");
  const result = await tools.readFileTool.run({ path });
  expect(result.ok).toBe(false);
  expect(result.output).toContain("read limit is 5 bytes");
  expect(result.output).not.toContain("123456");
});

test("canonicalizes an in-root symlink before policy and confirms sensitive aliases", async () => {
  const env = join(dir, ".env");
  const alias = join(dir, "notes");
  writeFileSync(env, "K=x");
  symlinkSync(env, alias);

  const prepared = await tools.readFileTool.prepare?.({ path: alias });
  expect(prepared).toBeDefined();
  expect(prepared!.args.path).toBe(realpathSync(env));
  expect(prepared!.confirmation).toContain(alias);
  expect(prepared!.confirmation).toContain(env);
  expect(prepared!.security?.sensitiveRead).toBe(true);
  expect(classifyAction({ tool: "read_file", ...prepared! })).toBe("confirm");
});

test("file preflight fails closed for symlinks that escape the workspace", async () => {
  const secret = join(outside, ".env");
  const alias = join(dir, "notes");
  writeFileSync(secret, "K=x");
  symlinkSync(secret, alias);
  await expect(Promise.resolve().then(() => tools.readFileTool.prepare?.({ path: alias })))
    .rejects.toThrow("outside the compute workspace");
});
