import { test, expect } from "bun:test";
import { CodexBrain } from "../src/brain/codex";

test("CodexBrain spawns 'codex' binary in non-interactive exec mode (current flags)", async () => {
  const brain = new CodexBrain();
  await brain.start();
  const cfg = (brain as unknown as { config: { binary: string; args: string[] } }).config;
  expect(cfg.binary).toBe("codex");
  expect(cfg.args).toEqual(["exec", "--color", "never", "--skip-git-repo-check"]);
});

test("CodexBrain forwards extra args after the base flags", () => {
  const brain = new CodexBrain("codex", ["-s", "workspace-write"]);
  const cfg = (brain as unknown as { config: { args: string[] } }).config;
  expect(cfg.args).toEqual(["exec", "--color", "never", "--skip-git-repo-check", "-s", "workspace-write"]);
});

test("CodexBrain health checks for codex on PATH", async () => {
  const brain = new CodexBrain();
  expect(typeof await brain.health()).toBe("boolean");
});
