import { expect, test } from "bun:test";
import { DraftChangedError, SetupSession } from "../../src/setup/session";
import { fixtureSystem } from "./fixtures";
import { REQUIRED_ANSWERS, requiredDeps } from "./required";

async function complete(s: SetupSession): Promise<void> {
  for (const [id, choice] of REQUIRED_ANSWERS) expect((await s.choose(id, choice, { probe: false, deps: requiredDeps })).accepted).toBe(true);
}

test("the write gate names every required step still unchosen, even with a passing Check", async () => {
  const s = new SetupSession(fixtureSystem("cuda24"), undefined, requiredDeps);
  await s.choose("privacy", { mode: "cloud" }, { probe: false });
  await s.choose("frontdesk", { kind: "agent" }, { probe: false });
  await s.check(async () => [{ name: "config", level: "ok", detail: "fine" }]);
  expect(s.missingChoices()).toEqual(["Machine", "Helper", "Hear", "Speak", "Agent"]);
  expect(s.writeGate(true)).toEqual({ ok: false, error: "Choose Machine, Helper, Hear, Speak, Agent before writing" });
  await complete(s);
  await s.check(async () => [{ name: "config", level: "ok", detail: "fine" }]);
  expect(s.writeGate(false)).toEqual({ ok: true });
});

test("revision bumps and the write gate needs a fresh Check", async () => {
  const s = new SetupSession(fixtureSystem("cuda24"), undefined, requiredDeps);
  const before = s.revision;
  await s.choose("privacy", { mode: "local" }, { probe: false });
  expect(s.revision).toBe(before + 1);
  await complete(s);
  expect(s.writeGate(false)).toEqual({ ok: false, error: "Run Check again before writing" });
  await s.check(async () => [{ name: "config", level: "ok", detail: "fine" }]);
  expect(s.writeGate(false)).toEqual({ ok: true });
  await s.choose("system", "local-cuda", { probe: false });
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
  const s = new SetupSession(fixtureSystem("cuda24"), undefined, requiredDeps);
  await complete(s);
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

test("a board needs an explicit allowance: no probe runs without it, and the allowance lands in privacy.allow", async () => {
  let probes = 0;
  const runCommand = (async () => { probes += 1; const out = { text: "[]", receivedBytes: 2, capturedBytes: 2, limitBytes: 1024, truncated: false }; return { command: [], exitCode: 0, durationMs: 1, stdout: out, stderr: { ...out, text: "" }, combined: { receivedBytes: 2, capturedBytes: 2, limitBytes: 2048, truncated: false } }; }) as never;
  for (const mode of ["local", "cloud"] as const) {
    const s = new SetupSession(fixtureSystem("cuda24"), undefined, { runCommand });
    await s.choose("privacy", { mode }, { probe: false });
    await expect(s.choose("board", { id: "hermes" }, { probe: true })).rejects.toThrow("Allow task text to go to this board first");
    expect(probes).toBe(0);
    expect((await s.choose("board", { id: "hermes", allowBoard: true }, { probe: true })).accepted).toBe(true);
    expect(s.draft.privacy).toEqual({ mode, allow: ["board"] });
    probes = 0;
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
