import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("headless quickstarts cannot copy a public token or an impossible tab brain", () => {
  const readme = readFileSync("README.md", "utf8");
  const setupGuide = readFileSync("docs/setup.md", "utf8");
  const webGuide = readFileSync("docs/web-voice.md", "utf8");
  const configExample = readFileSync("config.yaml.example", "utf8");

  expect(readme).not.toContain("token: <generate-a-secret>");
  expect(setupGuide).not.toContain("token: <generate-a-secret>");
  expect(webGuide).not.toContain("token: <generate-a-secret>");
  expect(configExample).not.toContain("token: <generate-a-secret>");
  // The copyable quickstart config lives in README and its canonical home,
  // docs/setup.md; web-voice.md intentionally links there instead of
  // carrying its own copy.
  expect(readme).toMatch(/brain: \{ backend: claude-code, mode: subprocess \}/);
  expect(setupGuide).toMatch(/brain: \{ backend: claude-code, mode: subprocess \}/);
  expect(configExample).toMatch(/brain: \{ backend: claude-code, mode: subprocess \}/);
});
