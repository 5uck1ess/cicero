import { test, expect } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { readFileSync } from "node:fs";

test("DEFAULT_CONFIG.terminal is 'auto'", () => {
  expect(DEFAULT_CONFIG.terminal).toBe("auto");
});

test("config.ts contains no kitty CLI strings", () => {
  const src = readFileSync("src/config.ts", "utf8");
  expect(src.includes("kitty @")).toBe(false);
});
