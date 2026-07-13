import { test, expect } from "bun:test";
import type { Tab } from "../src/types";

test("Tab uses opaque string id, no terminal-specific fields", () => {
  const tab: Tab = {
    id: "any-string-handle",
    title: "test",
    is_focused: false,
    cwd: "/tmp",
  };
  expect(tab.id).toBe("any-string-handle");
  // @ts-expect-error window_id should no longer exist on Tab
  expect(tab.window_id).toBeUndefined();
});
