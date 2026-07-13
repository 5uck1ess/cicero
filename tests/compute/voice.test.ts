import { test, expect } from "bun:test";
import { parseAffirmative, makeVoiceConfirm, makeVoiceNarrator } from "../../src/compute/voice";

test("parseAffirmative recognizes common yes/no phrasings", () => {
  for (const yes of ["yes", "Yeah", "do it", "go ahead", "sure", "confirm", "yep", "okay"]) {
    expect(parseAffirmative(yes)).toBe(true);
  }
  for (const no of ["no", "stop", "cancel", "nah", ""]) {
    expect(parseAffirmative(no)).toBe(false);
  }
});

test("parseAffirmative refuses negations that embed an affirmative word", () => {
  // These used to falsely approve because they contain "ok"/"do it"/"yes" substrings.
  for (const tricky of ["not ok", "no, that's okay don't", "don't do it", "no don't", "yes but actually no", "nope"]) {
    expect(parseAffirmative(tricky)).toBe(false);
  }
});

test("makeVoiceConfirm speaks a prompt then resolves true from an affirmative reply", async () => {
  const spoken: string[] = [];
  const confirm = makeVoiceConfirm({
    speak: async (text) => { spoken.push(text); },
    listenOnce: async () => "yes do it",
  });
  const allowed = await confirm({ tool: "open_app", args: { name: "Safari" } });
  expect(allowed).toBe(true);
  expect(spoken.join(" ")).toContain("open_app");
});

test("makeVoiceConfirm resolves false when the spoken reply is not affirmative", async () => {
  const confirm = makeVoiceConfirm({
    speak: async () => {},
    listenOnce: async () => "no, cancel that",
  });
  const allowed = await confirm({ tool: "shell", args: { command: "rm file" } });
  expect(allowed).toBe(false);
});

test("makeVoiceConfirm speaks a trusted URL-aware confirmation summary", async () => {
  const spoken: string[] = [];
  const confirm = makeVoiceConfirm({
    speak: async (text) => { spoken.push(text); },
    listenOnce: async () => "no",
  });
  await confirm({
    tool: "browser",
    args: { action: "read" },
    confirmation: "read browser page at https://example.com/account",
  });
  expect(spoken[0]).toContain("https://example.com/account");
});

test("makeVoiceNarrator speaks each message it is given", () => {
  const spoken: string[] = [];
  const narrate = makeVoiceNarrator({ speak: async (text) => { spoken.push(text); } });
  narrate("step 1: listing the directory");
  expect(spoken).toEqual(["step 1: listing the directory"]);
});
