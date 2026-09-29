import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TRIGGERS } from "../src/brain/routing";
import { loadConfig } from "../src/config";
import { SETUP_STEPS } from "../src/setup/steps";

const read = (p: string) => readFileSync(p, "utf8");
const fences = (text: string, info: string) => [...text.matchAll(new RegExp("```" + info + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1]!);
/** Loads text as ~/.cicero/config.yaml in a scratch home: defaults merged, full runtime validation. */
function loads(text: string): void {
  const home = mkdtempSync(join(tmpdir(), "cicero-docs-config-"));
  try { writeFileSync(join(home, "config.yaml"), text); loadConfig({}, { home }); }
  finally { rmSync(home, { recursive: true, force: true }); }
}
const titles = SETUP_STEPS.filter((s) => s.available).map((s) => s.title);

test("headless quickstarts cannot copy a public token", () => {
  expect(read("README.md")).not.toContain("token: <generate-a-secret>");
  expect(read("docs/setup.md")).not.toContain("token: <generate-a-secret>");
  expect(read("docs/web-voice.md")).not.toContain("token: <generate-a-secret>");
  expect(read("config.yaml.example")).not.toContain("token: <generate-a-secret>");
});

test("README links the setup guide and carries no config or step list", () => {
  const readme = read("README.md");
  expect(readme).toContain("docs/setup.md");
  expect(fences(readme, "yaml cicero-config")).toEqual([]);
  expect(readme).not.toMatch(/brain: \{ backend: claude-code, mode: subprocess \}/);
});

test.each(["docs/setup.md", "INSTALL.md"])("%s: every cicero-config block is a complete valid config", (path) => {
  const blocks = fences(read(path), "yaml cicero-config");
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) expect(() => loads(block)).not.toThrow();
});

test("config.yaml.example is validated as a whole file", () => {
  expect(() => loads(read("config.yaml.example"))).not.toThrow();
});

test.each(["docs/setup.md", "INSTALL.md"])("%s lists the available step titles in order", (path) => {
  const text = read(path);
  let at = -1;
  for (const title of titles) {
    const i = text.indexOf(title, at + 1);
    expect(`${title}@${i}`).not.toBe(`${title}@-1`);
    expect(i).toBeGreaterThan(at);
    at = i;
  }
});

test("setup guide and example keep the headless Claude Code line", () => {
  expect(read("docs/setup.md")).toMatch(/brain: \{ backend: claude-code, mode: subprocess \}/);
  expect(read("config.yaml.example")).toMatch(/brain: \{ backend: claude-code, mode: subprocess \}/);
});

test("concepts page exists and is linked from README, setup guide, INSTALL and llms.txt", () => {
  expect(read("docs/concepts.md")).toContain("```mermaid");
  expect(read("README.md")).toContain("docs/concepts.md");
  // Right after the pitch: before the first section heading.
  const readme = read("README.md");
  expect(readme.indexOf("docs/concepts.md")).toBeLessThan(readme.indexOf("\n## "));
  expect(read("docs/setup.md")).toMatch(/\]\((\.\/)?concepts\.md/);
  expect(read("INSTALL.md")).toContain("docs/concepts.md");
  expect(read("llms.txt")).toContain("docs/concepts.md");
});

test("using.md lists the real escalation triggers", () => {
  const using = read("docs/using.md");
  for (const t of DEFAULT_TRIGGERS) expect(using).toContain(t);
});

test("agents can find INSTALL.md from AGENTS.md and llms.txt", () => {
  expect(read("AGENTS.md")).toContain("INSTALL.md");
  expect(read("llms.txt")).toContain("INSTALL.md");
});
