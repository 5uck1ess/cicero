import { test, expect } from "bun:test";
import { THINKING_FILLERS, classifyFillerBucket, pickThinkingFiller } from "../../src/speaker/thinking-filler";

test("pickThinkingFiller always returns a known filler", () => {
  for (let i = 0; i < 200; i++) {
    expect(THINKING_FILLERS).toContain(pickThinkingFiller());
  }
});

test("pickThinkingFiller never repeats the previous one back-to-back", () => {
  let last = pickThinkingFiller();
  for (let i = 0; i < 500; i++) {
    const next = pickThinkingFiller(last);
    expect(next).not.toBe(last);
    expect(THINKING_FILLERS).toContain(next);
    last = next;
  }
});

test("varies across a run (not stuck on one phrase)", () => {
  const seen = new Set<string>();
  let last: string | undefined;
  // Rotate through utterance kinds — picks are per-bucket now, so variety
  // means covering each bucket's lines, not the whole flat list at once.
  const utterances = ["Fix the bug.", "Check the status.", "Why is it slow?", "Tell me a story."];
  for (let i = 0; i < 200; i++) {
    last = pickThinkingFiller(last, utterances[i % utterances.length]);
    seen.add(last);
  }
  expect(seen.size).toBeGreaterThan(THINKING_FILLERS.length / 2);
});

// --- per-lane-voice filler clips ---

import { FillerBank } from "../../src/speaker/filler-bank";
import { encodeWav } from "../../src/platform/wav";

test("primeVoice renders clips in the lane's voice and pick(voice) uses only them", async () => {
  const voicesAsked: Array<string | undefined> = [];
  const bank = new FillerBank({
    generateAudio: (_text: string, voice?: string) => {
      voicesAsked.push(voice);
      return Promise.resolve(encodeWav(new Int16Array([1])).buffer as ArrayBuffer);
    },
  });
  await bank.prime();
  expect(voicesAsked.every((v) => v === undefined)).toBe(true);

  voicesAsked.length = 0;
  const n = await bank.primeVoice("nova", 1);
  expect(n).toBeGreaterThan(0);
  expect(voicesAsked.every((v) => v === "nova")).toBe(true);

  expect(bank.pick("check the tests", "nova")).toBeDefined();
  // an unprimed voice yields silence, never the wrong voice's clip
  expect(bank.pick("check the tests", "remy")).toBeUndefined();
});

test("bare acknowledgments classify as 'none' — no filler for 'sounds good'", () => {
  for (const t of ["sounds good", "Sounds good!", "ok cool", "yeah, thanks.", "got it", "perfect", "okay sounds good thanks"]) {
    expect(classifyFillerBucket(t)).toBe("none");
  }
  // real turns still get their buckets — an ack word INSIDE a sentence doesn't silence it
  expect(classifyFillerBucket("sounds good but can you also update the docs")).not.toBe("none");
  expect(classifyFillerBucket("good question, what's the status of the build")).not.toBe("none");
});
