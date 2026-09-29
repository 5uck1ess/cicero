import { expect, test } from "bun:test";
import { DraftChangedError, SetupSession } from "../../src/setup/session";
import { fixtureSystem } from "./fixtures";

test("revision bumps and the write gate needs a fresh Check", async () => {
  const s = new SetupSession(fixtureSystem("cuda24"));
  const before = s.revision;
  await s.choose("privacy", { mode: "local" }, { probe: false });
  expect(s.revision).toBe(before + 1);
  expect(s.writeGate(false)).toEqual({ ok: false, error: "Run Check again before writing" });
  await s.check(async () => [{ name: "config", level: "ok", detail: "fine" }]);
  expect(s.writeGate(false)).toEqual({ ok: true });
  await s.choose("privacy", { mode: "cloud" }, { probe: false });
  expect(s.writeGate(false)).toEqual({ ok: false, error: "Run Check again before writing" });
});

test("a choice made during Check makes that Check stale", async () => {
  const s = new SetupSession(fixtureSystem("cuda24"));
  let release!: () => void;
  const pending = s.check(() => new Promise((resolve) => { release = () => resolve([{ name: "config", level: "ok", detail: "old" }]); }));
  await s.choose("system", "local-cpu", { probe: false });
  release();
  await expect(pending).rejects.toBeInstanceOf(DraftChangedError);
  expect(s.currentChecks()).toBeNull();
});

test("write gate mirrors the page: blocking, then not-ready acknowledgement", async () => {
  const s = new SetupSession(fixtureSystem("cuda24"));
  await s.check(async () => [{ name: "config", level: "fail", detail: "bad" }]);
  expect(s.writeGate(true)).toEqual({ ok: false, error: "Resolve config validity failures before writing" });
  await s.check(async () => [{ name: "stt (audiocpp)", level: "fail", detail: "not running" }]);
  expect(s.writeGate(false)).toEqual({ ok: false, error: "Acknowledge that runtime components are not ready yet before writing" });
  expect(s.writeGate(true)).toEqual({ ok: true });
});

test("a failed probe does not store the choice", async () => {
  const s = new SetupSession(fixtureSystem("cuda24"));
  const result = await s.choose("board", { id: "hermes", allowBoard: true }, { probe: true, deps: { runCommand: async () => { throw new Error("no cli"); } } });
  expect(result.accepted).toBe(false);
  expect(s.choices.has("board")).toBe(false);
});

test("unknown and no-choice steps are rejected", async () => {
  const s = new SetupSession(fixtureSystem("cuda24"));
  for (const id of ["check", "write", "handoff", "channels", "nope"]) {
    await expect(s.choose(id, {}, { probe: false })).rejects.toThrow("Unknown setup choice");
  }
});

test("a later privacy flip invalidates a stored cloud agent", async () => {
  const s = new SetupSession(fixtureSystem("cuda24"), undefined, { env: {}, which: () => null, readFile: () => null, homeDir: () => "/fixture/home" });
  await s.choose("privacy", { mode: "cloud" }, { probe: false });
  await s.choose("frontdesk", { kind: "agent" }, { probe: false });
  await s.choose("brain", { id: "codex" }, { probe: false });
  expect(s.draft.brain.backend).toBe("codex");
  const flipped = await s.choose("privacy", { mode: "local" }, { probe: false });
  expect(flipped.invalidated).toEqual([{ id: "brain", reason: "Allow this agent to use the cloud first" }]);
  expect(s.choices.has("brain")).toBe(false);
  await s.choose("brain", { id: "codex", allowCloud: true }, { probe: false });
  expect(s.draft.privacy).toEqual({ mode: "local", allow: ["agent"] });
});
