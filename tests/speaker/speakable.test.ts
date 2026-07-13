import { test, expect } from "bun:test";
import { speakable } from "../../src/speaker/speakable";

test("strips leading bullet markers so TTS never says 'dash'", () => {
  expect(speakable("- this input is trusted")).toBe("this input is trusted");
  expect(speakable("* a point")).toBe("a point");
  expect(speakable("1. first step")).toBe("first step");
  expect(speakable("2) second")).toBe("second");
});

test("flattens a multi-line bullet list", () => {
  const md = "Here's the map:\n- trust boundaries\n- data flow\n- shell access";
  const out = speakable(md);
  expect(out).not.toContain("-");
  expect(out).toContain("trust boundaries");
  expect(out).toContain("shell access");
});

test("em/en dashes become a comma pause, not a glitch", () => {
  expect(speakable("steady—like an old river")).toBe("steady, like an old river");
  expect(speakable("capes – it's about truth")).toBe("capes, it's about truth");
});

test("curly quotes and ellipsis normalize to spoken forms", () => {
  expect(speakable("“hacking,” he said")).toBe('"hacking," he said');
  expect(speakable("well… maybe")).toBe("well... maybe");
});

test("removes emphasis and code markers, keeps the words", () => {
  expect(speakable("this is **really** important")).toBe("this is really important");
  expect(speakable("run `bun test` now")).toBe("run bun test now");
  expect(speakable("# Heading")).toBe("Heading");
});

test("links keep their label, drop the URL", () => {
  expect(speakable("see [the docs](https://x.io/y)")).toBe("see the docs");
});

test("pure-markup input flattens to empty (caller skips it)", () => {
  expect(speakable("---")).toBe("");
  expect(speakable("*")).toBe("");
});

test("plain prose is untouched", () => {
  const s = "Verdict first, then the shortest honest reasoning.";
  expect(speakable(s)).toBe(s);
});

test("delivery tags are stripped whole — the engine never hears 'excited'", () => {
  expect(speakable("[excited] We got it working.")).toBe("We got it working.");
  expect(speakable("It's quiet in here. [whisper] Too quiet.")).toBe("It's quiet in here. Too quiet.");
  expect(speakable("Fixed it [laugh] on the first try.")).toBe("Fixed it on the first try.");
});

test("delivery tags survive in keep mode for engines that can act on them", () => {
  expect(speakable("[excited] We got it working.", "keep")).toBe("[excited] We got it working.");
});

test("bracketed non-tags lose only their brackets, never their content", () => {
  expect(speakable("[Note] the [2026] budget")).toBe("Note the 2026 budget");
});

test("repeated terminators collapse — one mark is emphasis enough", () => {
  expect(speakable("Whoa!!! That worked?!")).toBe("Whoa! That worked?!");
  expect(speakable("Really????")).toBe("Really?");
});

test("ALL-CAPS words flatten so the engine doesn't yell them", () => {
  expect(speakable("HIYA puddin'")).toBe("Hiya puddin'");
  expect(speakable("that is AMAZING news")).toBe("that is Amazing news");
});

test("acronyms keep their caps — flattening would change pronunciation", () => {
  expect(speakable("the HTTP JSON API returns YAML")).toBe("the HTTP JSON API returns YAML");
  expect(speakable("CUDA uses 15 gigs of VRAM")).toBe("CUDA uses 15 gigs of VRAM");
});
