import { test, expect } from "bun:test";
import { buildRecoveryContext } from "../src/speaker/recovery";

test("includes what was said and the interjection", () => {
  const ctx = buildRecoveryContext({
    spoken: ["I refactored the auth module.", "Tests are running now."],
    interjection: "wait, use JWT instead",
  });
  expect(ctx).toContain("I refactored the auth module. Tests are running now.");
  expect(ctx).toContain("wait, use JWT instead");
});

test("uses the no-speech variant when nothing was spoken yet", () => {
  const ctx = buildRecoveryContext({ spoken: [], interjection: "actually, hold on" });
  expect(ctx).toContain("actually, hold on");
  expect(ctx).not.toContain("You had already said");
});
