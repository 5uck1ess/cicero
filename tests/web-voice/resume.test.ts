import { test, expect } from "bun:test";
import { buildResumePrimer, type ResumeTurn, buildRosterNote } from "../../src/web-voice/resume";

const turn = (user: string, reply: string): ResumeTurn => ({ t: 1, user, reply });

test("no history → null (plain warmup)", () => {
  expect(buildResumePrimer([])).toBeNull();
  expect(buildResumePrimer([turn("", "")])).toBeNull();
});

test("formats turns oldest-first with User/You labels and the ok instruction", () => {
  const p = buildResumePrimer([turn("how are the tests?", "All green."), turn("ship it", "Pushed to main.")]);
  expect(p).toContain("User: how are the tests?");
  expect(p).toContain("You: All green.");
  expect(p).toContain("with exactly: ok");
  // Order preserved: first turn appears before the second.
  expect(p!.indexOf("how are the tests?")).toBeLessThan(p!.indexOf("ship it"));
});

test("long replies are clipped per side", () => {
  const p = buildResumePrimer([turn("q", "x".repeat(1000))]);
  expect(p!.length).toBeLessThan(700);
  expect(p).toContain("…");
});

test("budget keeps the newest turns and drops the oldest", () => {
  const items = Array.from({ length: 60 }, (_, i) => turn(`question ${i} ${"pad".repeat(40)}`, `answer ${i}`));
  const p = buildResumePrimer(items)!;
  expect(p).toContain("question 59");
  expect(p).not.toContain("question 0 ");
  expect(p.length).toBeLessThan(4600);
});

test("one-sided turns (notify-era rows) still render", () => {
  const p = buildResumePrimer([turn("", "I spoke up about a finished task.")]);
  expect(p).toContain("You: I spoke up about a finished task.");
  expect(p).not.toContain("User:");
});

test("roster note lists lanes with aliases and the escalation trigger", () => {
  const note = buildRosterNote(
    { coder: { aliases: ["the coder", "codex"] }, qa: {} },
    ["think hard"],
  )!;
  expect(note).toContain("The Coder (the coder lane; also answers to: codex)");
  expect(note).toContain("qa");
  expect(note).toContain('"think hard');
  expect(note).toContain("back to Cicero");
});

test("roster note is null with no lanes", () => {
  expect(buildRosterNote(undefined)).toBeNull();
  expect(buildRosterNote({})).toBeNull();
});

test("primer attributes colleague turns, never labels them 'You'", () => {
  const primer = buildResumePrimer([
    { t: 1, user: "hey", reply: "At your service, sir." },
    { t: 2, user: "review this", reply: "Oooh, broken in three places, puddin'.", lane: "qa" },
  ])!;
  expect(primer).toContain('Colleague "qa" (user was transferred): Oooh');
  expect(primer).not.toContain("You: Oooh");
  expect(primer).toContain("never adopt their personality");
  expect(primer).toContain("The restart ended any transfer");
});

test("primer without colleague turns skips the colleague warning", () => {
  const primer = buildResumePrimer([{ t: 1, user: "hey", reply: "Hello, sir." }])!;
  expect(primer).not.toContain("never adopt their personality");
});
