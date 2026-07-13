import { test, expect } from "bun:test";
import { segmentSentences } from "../src/speaker/sentence-stream";

async function* fromArray(items: string[]): AsyncGenerator<string> {
  for (const item of items) yield item;
}
async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of gen) out.push(s);
  return out;
}

test("yields sentences as boundaries arrive across token chunks", async () => {
  const out = await collect(segmentSentences(fromArray(["Hello ", "there. How ", "are you?"])));
  expect(out).toEqual(["Hello there.", "How are you?"]);
});

test("splits multiple sentences contained in one chunk", async () => {
  const out = await collect(segmentSentences(fromArray(["One. Two. Three!"])));
  expect(out).toEqual(["One.", "Two.", "Three!"]);
});

test("flushes trailing text with no terminal punctuation", async () => {
  const out = await collect(segmentSentences(fromArray(["No period here"])));
  expect(out).toEqual(["No period here"]);
});

test("ignores an empty token stream", async () => {
  const out = await collect(segmentSentences(fromArray([])));
  expect(out).toEqual([]);
});

test("does not split after common abbreviations", async () => {
  const out = await collect(segmentSentences(fromArray(["Dr. Smith arrived. He sat down."])));
  expect(out).toEqual(["Dr. Smith arrived.", "He sat down."]);
});

test("does not split after e.g. / i.e. / a.m.", async () => {
  const out = await collect(segmentSentences(fromArray(["Use a fast model, e.g. gemma. It works. Meet at 9 a.m. tomorrow."])));
  expect(out).toEqual(["Use a fast model, e.g. gemma.", "It works.", "Meet at 9 a.m. tomorrow."]);
});

test("single-letter sentences still split (initials are not guarded)", async () => {
  const out = await collect(segmentSentences(fromArray(["A. ", "B. ", "C."])));
  expect(out).toEqual(["A.", "B.", "C."]);
});

test("abbreviation guard works across token chunk boundaries", async () => {
  const out = await collect(segmentSentences(fromArray(["Ask Dr", ". Smith today. Then rest."])));
  expect(out).toEqual(["Ask Dr. Smith today.", "Then rest."]);
});

test("still splits ellipses and exclamations normally", async () => {
  const out = await collect(segmentSentences(fromArray(["Wait... really? Yes! Done."])));
  expect(out).toEqual(["Wait...", "really?", "Yes!", "Done."]);
});
