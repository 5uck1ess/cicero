import { test, expect } from "bun:test";
import { isStopCommand } from "../src/listener/conversational";
import { ConversationalListener } from "../src/listener/conversational";

test("isStopCommand recognizes verbal stop variants", () => {
  expect(isStopCommand("stop")).toBe(true);
  expect(isStopCommand("Stop.")).toBe(true);
  expect(isStopCommand("wait")).toBe(true);
  expect(isStopCommand("cancel")).toBe(true);
  expect(isStopCommand("hold on")).toBe(true);
  expect(isStopCommand("never mind")).toBe(true);
  expect(isStopCommand("nevermind")).toBe(true);
  expect(isStopCommand("stop talking")).toBe(true);
});

test("isStopCommand rejects unrelated text", () => {
  expect(isStopCommand("what time is it")).toBe(false);
  expect(isStopCommand("stop the deploy")).toBe(false); // not just "stop"
  expect(isStopCommand("")).toBe(false);
});

test("deactivation phrases are exact commands, not destructive prefixes", () => {
  const listener = new ConversationalListener({} as never, {} as never, { play: async () => {} } as never);
  expect(listener.isDeactivationPhrase("stop")).toBe(true);
  expect(listener.isDeactivationPhrase("Stop!")).toBe(true);
  expect(listener.isDeactivationPhrase("stop listening.")).toBe(true);
  expect(listener.isDeactivationPhrase("stop the deploy")).toBe(false);
  expect(listener.isDeactivationPhrase("goodbye message for the team")).toBe(false);
});
