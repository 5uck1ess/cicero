import { test, expect, describe } from "bun:test";
import { stripFillers } from "../src/text-utils";

describe("stripFillers", () => {
  test("strips leading 'okay' filler", () => {
    expect(stripFillers("okay type ls")).toBe("type ls");
  });

  test("strips leading 'let's' filler", () => {
    expect(stripFillers("let's type ls")).toBe("type ls");
  });

  test("strips leading 'um' filler", () => {
    expect(stripFillers("um check my email")).toBe("check my email");
  });

  test("strips multiple leading fillers", () => {
    expect(stripFillers("okay so um type ls")).toBe("type ls");
  });

  test("strips trailing punctuation", () => {
    expect(stripFillers("type ls.")).toBe("type ls");
  });

  test("preserves meaningful content", () => {
    expect(stripFillers("switch to sales tab")).toBe("switch to sales tab");
  });

  test("handles 'go ahead and' prefix", () => {
    expect(stripFillers("go ahead and type ls")).toBe("type ls");
  });

  test("handles 'can you' prefix", () => {
    expect(stripFillers("can you check slack")).toBe("check slack");
  });

  test("handles 'could you please' prefix", () => {
    expect(stripFillers("could you please switch to sales")).toBe("switch to sales");
  });

  test("does not strip meaningful words mid-sentence", () => {
    expect(stripFillers("let's build a project")).toBe("build a project");
  });

  test("handles empty string", () => {
    expect(stripFillers("")).toBe("");
  });

  test("lowercases input", () => {
    expect(stripFillers("TYPE LS")).toBe("type ls");
  });
});
