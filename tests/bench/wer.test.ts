import { test, expect } from "bun:test";
import { normalizeForWer, wordErrorRate } from "../../bench/stt/wer";

test("normalizeForWer lowercases, strips punctuation, keeps apostrophes", () => {
  expect(normalizeForWer("Hello, World!  It's fine.")).toEqual(["hello", "world", "it's", "fine"]);
});

test("identical transcripts score 0 WER", () => {
  const r = wordErrorRate("the quick brown fox", "the quick brown fox");
  expect(r.wer).toBe(0);
  expect(r.hits).toBe(4);
});

test("casing and punctuation differences do not count as errors", () => {
  expect(wordErrorRate("The quick brown fox.", "the quick brown fox").wer).toBe(0);
});

test("one substitution in four words is 0.25 WER", () => {
  const r = wordErrorRate("the quick brown fox", "the quick green fox");
  expect(r.wer).toBeCloseTo(0.25, 5);
  expect(r.substitutions).toBe(1);
  expect(r.deletions).toBe(0);
  expect(r.insertions).toBe(0);
});

test("a missing word is a deletion", () => {
  const r = wordErrorRate("the quick brown fox", "the quick fox");
  expect(r.deletions).toBe(1);
  expect(r.wer).toBeCloseTo(0.25, 5);
});

test("an extra word is an insertion", () => {
  const r = wordErrorRate("the quick brown fox", "the quick brown red fox");
  expect(r.insertions).toBe(1);
  expect(r.wer).toBeCloseTo(0.25, 5);
});

test("empty reference: any output is pure insertion (WER 1), empty matches empty (WER 0)", () => {
  expect(wordErrorRate("", "hello there").wer).toBe(1);
  expect(wordErrorRate("", "").wer).toBe(0);
});

test("empty hypothesis against a reference is all deletions (WER 1)", () => {
  const r = wordErrorRate("one two three", "");
  expect(r.deletions).toBe(3);
  expect(r.wer).toBe(1);
});
