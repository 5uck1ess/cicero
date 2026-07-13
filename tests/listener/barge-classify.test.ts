import { test, expect } from "bun:test";
import { classifyBargeIn } from "../../src/listener/conversational";

// classifyBargeIn is the full-duplex policy: while Cicero is speaking, the mic
// stays open and captures audio. We must decide what that audio IS before acting,
// because on open speakers the mic hears Cicero's own TTS. The four outcomes:
//   "empty"   — nothing intelligible; keep speaking, re-arm detection
//   "echo"    — the mic caught Cicero's own voice; keep speaking, do NOT interrupt
//   "stop"    — a bare "stop"-class command; interrupt TTS, dispatch nothing
//   "command" — genuine user speech; interrupt TTS and process it as a new turn

test("empty / whitespace transcript is 'empty'", () => {
  expect(classifyBargeIn("", "anything Cicero is saying")).toBe("empty");
  expect(classifyBargeIn("   ", "anything Cicero is saying")).toBe("empty");
  expect(classifyBargeIn(null, "anything Cicero is saying")).toBe("empty");
  expect(classifyBargeIn(undefined, "anything Cicero is saying")).toBe("empty");
});

test("mic catching Cicero's own TTS is 'echo' — the key full-duplex guard", () => {
  const speaking = "The Roman Republic was founded in 509 BC after the overthrow of the monarchy.";
  // Whisper transcribing the speaker bleed: near-verbatim, often with repetition.
  const echoed = "the roman republic was founded in 509 BC after the overthrow of the monarchy";
  expect(classifyBargeIn(echoed, speaking)).toBe("echo");
});

test("a bare stop command while speaking is 'stop'", () => {
  expect(classifyBargeIn("stop", "I am explaining the Roman Republic")).toBe("stop");
  expect(classifyBargeIn("wait.", "I am explaining the Roman Republic")).toBe("stop");
  expect(classifyBargeIn("shut up", "I am explaining the Roman Republic")).toBe("stop");
});

test("genuine new user speech is 'command' even while Cicero talks", () => {
  const speaking = "The Roman Republic was founded in 509 BC after the overthrow of the monarchy.";
  expect(classifyBargeIn("actually tell me about the empire instead", speaking)).toBe("command");
});

test("a stop phrase still counts as 'stop' even when echo would also match", () => {
  // "stop" is a single word — never an echo (below the echo word floor) — and must
  // be classified as a stop command, not swallowed as echo, so the user can always
  // halt playback by saying stop.
  expect(classifyBargeIn("stop", "please stop the music")).toBe("stop");
});

test("no speaking reference (Cicero silent) → echo is impossible, real speech passes", () => {
  expect(classifyBargeIn("tell me a joke please", "")).toBe("command");
});
