import { test, expect } from "bun:test";
import { ToolRegistry } from "../../src/compute/registry";
import type { Tool } from "../../src/compute/tool";

const fakeTool = (name: string): Tool => ({
  name,
  description: `does ${name}`,
  parameters: { type: "object", properties: {} },
  async run() { return { ok: true, output: name }; },
});

test("registers, looks up, and lists tools", () => {
  const reg = new ToolRegistry();
  reg.register(fakeTool("alpha"));
  reg.register(fakeTool("beta"));
  expect(reg.get("alpha")?.name).toBe("alpha");
  expect(reg.get("missing")).toBeUndefined();
  expect(reg.names().sort()).toEqual(["alpha", "beta"]);
});

test("manifest lists each tool name and description on its own line", () => {
  const reg = new ToolRegistry();
  reg.register(fakeTool("alpha"));
  const manifest = reg.manifest();
  expect(manifest).toContain("alpha");
  expect(manifest).toContain("does alpha");
});

test("registering a duplicate name throws", () => {
  const reg = new ToolRegistry();
  reg.register(fakeTool("alpha"));
  expect(() => reg.register(fakeTool("alpha"))).toThrow("alpha");
});
