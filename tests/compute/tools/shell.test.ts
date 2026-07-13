import { test, expect } from "bun:test";
import { shellTool } from "../../../src/compute/tools/shell";
import { CommandAbortError } from "../../../src/process/bounded-command";

test("shell runs a command and captures stdout", async () => {
  const result = await shellTool.run({ command: "echo cicero" });
  expect(result.ok).toBe(true);
  expect(result.output).toContain("cicero");
});

test("shell reports a non-zero exit as ok=false", async () => {
  const result = await shellTool.run({ command: "ls /definitely/not/here/cicero" });
  expect(result.ok).toBe(false);
});

test("shell bounds retained output and reports truncation", async () => {
  const result = await shellTool.run({
    command: `i=0; while [ "$i" -lt 1000 ]; do printf '0123456789'; i=$((i + 1)); done`,
  });
  expect(result.ok).toBe(true);
  expect(result.output).toEndWith("[output truncated]");
  expect(result.output.length).toBeLessThanOrEqual(4000);
});

test("shell passes cancellation through to the owned process tree", async () => {
  const controller = new AbortController();
  const running = shellTool.run(
    { command: `trap '' TERM; while :; do :; done` },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 50);
  await expect(running).rejects.toBeInstanceOf(CommandAbortError);
});
