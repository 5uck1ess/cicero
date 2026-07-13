import { test, expect } from "bun:test";
import { isSelfEcho, normalizeForEcho } from "../../src/listener/echo";

test("normalizeForEcho lowercases, strips punctuation, collapses whitespace", () => {
  expect(normalizeForEcho("Hello, How  are YOU?")).toBe("hello how are you");
});

test("rejects the mic capturing Cicero's own greeting (with Whisper repetition)", () => {
  const spoken = "Hello, how are you?";
  const echoed = "Hello, how are you? Hello? Hello? How are you? Hello?";
  expect(isSelfEcho(echoed, spoken)).toBe(true);
});

test("lets a genuine, different user utterance through", () => {
  const spoken = "Hello, how are you?";
  expect(isSelfEcho("what is the weather in Tokyo", spoken)).toBe(false);
});

test("never rejects a short command even if it overlaps", () => {
  // "hi"/"yes"/"stop" are single distinct words — always pass.
  expect(isSelfEcho("hi", "hi there, how are you")).toBe(false);
  expect(isSelfEcho("stop", "I will stop now")).toBe(false);
});

test("lets a short conversational reply through even if it fully overlaps", () => {
  // "how are you" (3 distinct words) is below the 4-word floor → never an echo,
  // even when Cicero just said the same words.
  expect(isSelfEcho("how are you", "I am doing well, how are you?")).toBe(false);
  expect(isSelfEcho("yes do that", "sure, should I do that for you?")).toBe(false);
});

test("empty strings are not echoes", () => {
  expect(isSelfEcho("", "hello there")).toBe(false);
  expect(isSelfEcho("hello there", "")).toBe(false);
});

test("partial overlap below threshold passes", () => {
  // Only "the" overlaps out of four distinct words → 0.25 < 0.6.
  expect(isSelfEcho("set the kitchen timer", "the answer is forty two")).toBe(false);
});
