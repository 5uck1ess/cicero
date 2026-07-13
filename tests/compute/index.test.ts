import { test, expect } from "bun:test";
import { buildDefaultRegistry } from "../../src/compute";

test("default registry contains the Tier A tools", () => {
  const reg = buildDefaultRegistry();
  expect(reg.names().sort()).toEqual(["list_dir", "open_app", "read_file", "shell", "write_file"]);
});

test("registry excludes the browser tool by default", () => {
  const reg = buildDefaultRegistry();
  expect(reg.names()).not.toContain("browser");
});

test("registry includes browser when web is enabled", () => {
  const reg = buildDefaultRegistry({ web: true });
  expect(reg.names()).toContain("browser");
});
