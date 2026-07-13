import { test, expect } from "bun:test";
import { parseActionRequest } from "../../src/compute/intent";

test("recognizes explicit action triggers and extracts the goal", () => {
  expect(parseActionRequest("computer, open Safari")).toEqual({ isAction: true, goal: "open Safari" });
  expect(parseActionRequest("Computer open my downloads folder")).toEqual({ isAction: true, goal: "open my downloads folder" });
  expect(parseActionRequest("hey computer, summarize the files here")).toEqual({ isAction: true, goal: "summarize the files here" });
  expect(parseActionRequest("use the computer to list my projects")).toEqual({ isAction: true, goal: "list my projects" });
  expect(parseActionRequest("take action and delete temp.txt")).toEqual({ isAction: true, goal: "delete temp.txt" });
  expect(parseActionRequest("go ahead and run the build")).toEqual({ isAction: true, goal: "run the build" });
});

test("does not hijack ordinary questions or existing routing", () => {
  for (const utterance of [
    "what's the weather today",
    "do you know the time",
    "open the sales tab",        // existing tab routing — must NOT be an action
    "summarize this article",    // brain query — must NOT be an action
    "tell me a joke",
  ]) {
    expect(parseActionRequest(utterance).isAction).toBe(false);
  }
});

test("a trigger with no goal is not an action", () => {
  expect(parseActionRequest("computer")).toEqual({ isAction: false, goal: "" });
  expect(parseActionRequest("computer, ")).toEqual({ isAction: false, goal: "" });
});
