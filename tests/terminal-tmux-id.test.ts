import { test, expect } from "bun:test";
import { TmuxAdapter } from "../src/terminal/tmux";

test("parseTmuxOutput exposes window id as a string without the @ prefix", () => {
  const raw = "@3\tcode\t1\t/home/user/project\n@5\tbrain\t0\t/home/user\n";
  const tabs = new TmuxAdapter().parseTmuxOutput(raw);
  expect(tabs[0].id).toBe("3");
  expect(typeof tabs[0].id).toBe("string");
  expect(tabs[1].id).toBe("5");
});
