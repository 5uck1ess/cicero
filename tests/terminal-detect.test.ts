import { test, expect } from "bun:test";
import { detectTerminal } from "../src/terminal/detect";

test("auto-detect picks tmux when $TMUX set", () => {
  expect(detectTerminal({ TMUX: "/tmp/tmux-foo" })).toBe("tmux");
});

test("auto-detect picks kitty when KITTY_WINDOW_ID set", () => {
  expect(detectTerminal({ KITTY_WINDOW_ID: "1" })).toBe("kitty");
});

test("auto-detect picks wezterm when WEZTERM_PANE set", () => {
  expect(detectTerminal({ WEZTERM_PANE: "0" })).toBe("wezterm");
});

test("auto-detect falls back to none when nothing available", () => {
  expect(detectTerminal({})).toBe("none");
});

test("tmux wins over kitty when both env vars are present", () => {
  expect(detectTerminal({ TMUX: "x", KITTY_WINDOW_ID: "1" })).toBe("tmux");
});
