import { test, expect } from "bun:test";
import { WezTermAdapter } from "../src/terminal/wezterm";

test("parseListOutput maps wezterm cli json to Tab[] with string ids", () => {
  const raw = JSON.stringify([
    { pane_id: 0, title: "editor", is_active: true, cwd: "file:///home/u/proj" },
    { pane_id: 7, tab_title: "brain", is_active: false },
  ]);
  const tabs = new WezTermAdapter().parseListOutput(raw);
  expect(tabs).toHaveLength(2);
  expect(tabs[0]).toEqual({ id: "0", title: "editor", is_focused: true, cwd: "file:///home/u/proj" });
  expect(tabs[1].id).toBe("7");
  expect(tabs[1].title).toBe("brain");
  expect(tabs[1].is_focused).toBe(false);
});

test("parseListOutput returns [] for malformed json", () => {
  expect(new WezTermAdapter().parseListOutput("not json")).toEqual([]);
});
