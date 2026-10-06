import { test, expect } from "bun:test";
import { isBackchannel } from "../../src/listener/backchannel";
import { classifyBargeIn, isStopCommand } from "../../src/listener/conversational";

// A backchannel is "I'm following, keep going" said over Cicero's reply. It must
// never cut the reply off, and nothing with real content may be mistaken for one.

const SPEAKING = "the roman republic was founded in 509 BC after the overthrow of the monarchy";

test("STT spellings of common backchannels are recognized", () => {
  for (const text of [
    "Mm-hmm.", "mm hmm", "Mhm.", "Mmhmm", "mmm", "Hmm.", "Uh-huh.", "uh huh",
    "Yeah.", "Yeah, yeah.", "yep", "Right.", "Right, right.", "Okay.", "OK", "Sure.",
    "Oh, I see.", "I see.", "Got it.", "Makes sense.", "Go on.", "Oh really?", "Wow.", "Cool.",
    "Exactly.", "Okay, cool.",
  ]) {
    expect({ text, backchannel: isBackchannel(text) }).toEqual({ text, backchannel: true });
  }
});

test("anything with real content is not a backchannel", () => {
  for (const text of [
    "", "   ", null, undefined,
    "yeah but use the other one",
    "okay now check the weather",
    "right, what about Singapore",
    "I see a problem with that",
    "go on to the next step and deploy it",
    "yes", "no", "um", "uh", "huh?",
  ]) {
    expect({ text, backchannel: isBackchannel(text) }).toEqual({ text, backchannel: false });
  }
});

test("a long transcript is rejected without tokenizing it", () => {
  expect(isBackchannel("yeah ".repeat(10_000))).toBe(false);
});

test("stop-class words are never backchannels, so they always interrupt", () => {
  for (const text of ["stop", "wait", "cancel", "hold on", "never mind", "quiet", "be quiet", "shut up", "stop talking"]) {
    expect(isStopCommand(text)).toBe(true);
    expect({ text, backchannel: isBackchannel(text) }).toEqual({ text, backchannel: false });
  }
});

test("classifyBargeIn reports a backchannel over a reply instead of a command", () => {
  expect(classifyBargeIn("Mm-hmm.", SPEAKING)).toBe("backchannel");
  expect(classifyBargeIn("yeah, yeah", SPEAKING)).toBe("backchannel");
  expect(classifyBargeIn("wait", SPEAKING)).toBe("stop");
  expect(classifyBargeIn("yeah but tell me about the empire", SPEAKING)).toBe("command");
});

test("backchannel_enabled: false restores the old interrupt-on-anything behavior", () => {
  expect(classifyBargeIn("Mm-hmm.", SPEAKING, false)).toBe("command");
});
