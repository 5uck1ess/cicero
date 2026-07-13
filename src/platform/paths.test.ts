import { test, expect } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ciceroHome, ciceroPath, tempPath } from "./paths";

test("ciceroHome resolves to <home>/.cicero via os.homedir (cross-platform)", () => {
  expect(ciceroHome()).toBe(join(homedir(), ".cicero"));
});

test("ciceroPath joins segments under the cicero home", () => {
  expect(ciceroPath("voices", "alice")).toBe(join(homedir(), ".cicero", "voices", "alice"));
});

test("ciceroPath with no segments equals ciceroHome", () => {
  expect(ciceroPath()).toBe(ciceroHome());
});

test("tempPath joins under the OS temp dir, not a hardcoded /tmp", () => {
  expect(tempPath("cicero-tts-1.wav")).toBe(join(tmpdir(), "cicero-tts-1.wav"));
});
