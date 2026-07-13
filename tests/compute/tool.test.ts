import { test, expect } from "bun:test";
import type { Tool, ToolResult } from "../../src/compute/tool";

test("a Tool can be implemented and run, returning a ToolResult", async () => {
  const echo: Tool = {
    name: "echo",
    description: "echoes its text arg",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async run(args) {
      return { ok: true, output: String(args.text) };
    },
  };
  const result: ToolResult = await echo.run({ text: "hi" });
  expect(result).toEqual({ ok: true, output: "hi" });
});

test("a Tool can report failure via ok:false with an error message", async () => {
  const failing: Tool = {
    name: "boom",
    description: "always fails",
    parameters: { type: "object", properties: {} },
    async run() {
      return { ok: false, output: "something went wrong" };
    },
  };
  const result: ToolResult = await failing.run({});
  expect(result.ok).toBe(false);
  expect(result.output).toContain("went wrong");
});
