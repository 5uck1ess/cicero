import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

test("index.ts health check uses the adapter, not a literal kitty command", () => {
  const src = readFileSync("src/index.ts", "utf8");
  expect(src.includes("kitty @ ls")).toBe(false);
  expect(src.includes('"kitty"')).toBe(false);
});
