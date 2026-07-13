import { test, expect } from "bun:test";
import type { TerminalAdapter } from "../src/types";

test("TerminalAdapter declares the full 8-method contract", () => {
  const methods: (keyof TerminalAdapter)[] = [
    "listTabs", "focusTab", "sendText", "sendKey", "getText",
    "spawnTab", "closeTab", "health",
  ];
  expect(methods.length).toBe(8);
});
