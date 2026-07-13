import { test, expect } from "bun:test";
import { NullTerminalAdapter } from "../src/terminal/null";

test("NullTerminalAdapter no-ops without throwing", async () => {
  const a = new NullTerminalAdapter();
  expect(await a.listTabs()).toEqual([]);
  expect(await a.getText()).toBe("");
  await a.focusTab();
  await a.sendText();
  await a.sendKey();
  await a.closeTab();
  const tab = await a.spawnTab({ title: "headless" });
  expect(tab.title).toBe("headless");
  expect(typeof tab.id).toBe("string");
  const h = await a.health();
  expect(h.ok).toBe(true);
});
