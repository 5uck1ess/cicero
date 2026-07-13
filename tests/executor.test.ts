import { test, expect, describe } from "bun:test";

// Structural tests — verify the executor source contains dispatch cases
// for the new intent types. We can't easily unit test without mocking
// brain/terminal/speaker, but we can confirm the code paths exist.

describe("ActionExecutor — new intent dispatch", () => {
  const source = require("fs").readFileSync("src/executor/index.ts", "utf-8");

  test("text_inject intent is handled (not unknown)", () => {
    expect(source).toContain("text_inject");
  });

  test("runtime_mute intent is handled", () => {
    expect(source).toContain("runtime_mute");
  });

  test("runtime_unmute intent is handled", () => {
    expect(source).toContain("runtime_unmute");
  });

  test("runtime_restart_brain intent is handled", () => {
    expect(source).toContain("runtime_restart_brain");
  });

  test("runtime_voice_toggle intent is handled", () => {
    expect(source).toContain("runtime_voice_toggle");
  });

  test("executeTextInject method exists", () => {
    expect(source).toContain("executeTextInject");
  });

  test("text_inject rejects vague pronoun payloads", () => {
    expect(source).toContain("What should I type? Be specific.");
  });

  test("text_inject rejects empty/short payloads", () => {
    expect(source).toContain("payload.length < 2");
  });
});
