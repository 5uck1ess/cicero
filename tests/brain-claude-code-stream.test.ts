import { test, expect } from "bun:test";
import { ClaudeCodeBrain } from "../src/brain/claude-code";

// This test starts the real Claude CLI and may use network/API credits. Bun
// automatically loads `.env`, so credentials alone must never opt the regular
// test suite into external work. Run it explicitly with:
//   CICERO_LIVE_TESTS=1 bun test tests/brain-claude-code-stream.test.ts
// Nested `claude --print` calls remain disabled inside a Claude Code session.
const canRunClaude = process.env.CICERO_LIVE_TESTS === "1"
  && Bun.which("claude") !== null
  && !process.env.CLAUDECODE;

test.skipIf(!canRunClaude)("live: sendStream yields text from the Claude CLI", async () => {
  const brain = new ClaudeCodeBrain();
  try {
    await brain.start();
    let streamed = "";
    for await (const piece of brain.sendStream!("Reply with exactly: pong")) {
      streamed += piece;
    }
    expect(streamed.toLowerCase()).toContain("pong");
  } catch (error) {
    throw new Error("Claude CLI live smoke test failed", { cause: error });
  } finally {
    await brain.stop();
  }
});

test("sendStream is advertised on the interface", () => {
  const brain = new ClaudeCodeBrain();
  expect(typeof brain.sendStream).toBe("function");
});
