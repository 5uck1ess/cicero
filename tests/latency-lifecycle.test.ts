import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitLatencyOwner, dropPendingLatencyOwner, LatencyRecordOwner, LatencyStore, LatencyTurn, type LatencyRecord } from "../src/latency";
import { speechEndOrigin } from "../src/web-voice/speech-end";
import { PAGE } from "../src/web-voice/page";

class FakeScheduler {
  now = 0;
  tasks = new Map<number, { at: number; run: () => void }>();
  next = 1;
  setTimeout = (run: () => void, ms: number): number => {
    const id = this.next++;
    this.tasks.set(id, { at: this.now + ms, run });
    return id;
  };
  clearTimeout = (id: number): void => { this.tasks.delete(id); };
  advance(ms: number): void {
    this.now += ms;
    for (const [id, task] of [...this.tasks]) if (task.at <= this.now) { this.tasks.delete(id); task.run(); }
  }
}
function metric(event: "speech_end" | "barge_in" | "audio_started", sinceSpeechEndMs: number, sequence?: number) {
  return { type: "client_metric" as const, sessionId: "s", turnId: "t", event, sinceSpeechEndMs, ...(sequence ? { sequence } : {}) };
}

test("pending turn retains speech_end before dispatch and records reply playback", async () => {
  const clock = new FakeScheduler();
  const rows: LatencyRecord[] = [];
  const owners = new Map<string, LatencyRecordOwner<number>>();
  const owner = admitLatencyOwner(owners, new LatencyTurn("s", "t", "web_voice", 1, () => clock.now), async (snapshot) => { rows.push(snapshot()); }, clock);
  owner.client(metric("speech_end", 0)); // arrives while the prior handler settles
  owner.delivered(1, "reply");
  owner.client(metric("audio_started", 1200, 1));
  owner.serverSettled();
  owner.ack(1, "played");
  await owner.flush();
  expect(rows[0]?.speechEndToReplyMs).toBe(1200);
  expect(owners.size).toBe(0);
  const server = readFileSync(new URL("../src/web-voice/server.ts", import.meta.url), "utf8");
  const admittedAt = server.indexOf("admitLatencyOwner(ws.data.latencyTurns");
  expect(admittedAt).toBeGreaterThan(-1);
  expect(admittedAt).toBeLessThan(server.indexOf("ws.data.pending = { input, turnId, lease"));
});

test("pending turn dropped before dispatch finalizes and releases its owner", async () => {
  const clock = new FakeScheduler();
  const rows: LatencyRecord[] = [];
  const owners = new Map<string, LatencyRecordOwner<number>>();
  const owner = admitLatencyOwner(owners, new LatencyTurn("s", "t", "web_voice", 1, () => clock.now), async (snapshot) => { rows.push(snapshot()); }, clock);
  dropPendingLatencyOwner(owners, "t", owner);
  await owner.flush();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.interrupted).toBe(true);
  expect(owner.finalized).toBe(true);
  expect(owners.size).toBe(0);
  expect(clock.tasks.size).toBe(0);
  const server = readFileSync(new URL("../src/web-voice/server.ts", import.meta.url), "utf8");
  expect(server.match(/dropPendingLatencyOwner\(ws\.data\.latencyTurns/g)?.length).toBe(4);
});

test("admission keeps at most 32 turn owners", () => {
  const clock = new FakeScheduler();
  const owners = new Map<string, LatencyRecordOwner<number>>();
  for (let i = 0; i < 33; i++) {
    admitLatencyOwner(owners, new LatencyTurn("s", `t${i}`, "web_voice", 1, () => clock.now), async () => {}, clock);
  }
  expect(owners.size).toBe(32);
  expect(owners.has("t0")).toBe(false);
});

test("VAD hangover is included in speech end to playback duration", () => {
  expect(speechEndOrigin(0, 700, false)).toBe(0);
  expect(1200 - speechEndOrigin(0, 700, false)).toBe(1200);
  expect(speechEndOrigin(0, 700, true)).toBe(700);
  expect(PAGE).toContain("speechEndOrigin(lastVoicedAt, endedAt, ptt)");
  expect(() => new Function(PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "")).not.toThrow();
});

test("metric arriving while persistence is pending enters the single stored snapshot", async () => {
  const clock = new FakeScheduler();
  const dir = mkdtempSync(join(tmpdir(), "cicero-latency-pending-"));
  try {
    const store = new LatencyStore(dir);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const owner = new LatencyRecordOwner(new LatencyTurn("s", "t", "web_voice", 1, () => clock.now), async (snapshot) => {
      await gate;
      await store.appendLazy(snapshot);
    }, clock);
    owner.client(metric("speech_end", 0));
    owner.delivered(1, "reply");
    owner.serverSettled();
    owner.ack(1, "played");
    owner.client(metric("audio_started", 1200, 1));
    release();
    await owner.flush();
    const rows = await store.read(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.speechEndToReplyMs).toBe(1200);
    expect(owner.finalized).toBe(true);
    owner.client(metric("barge_in", 1400));
    expect(rows[0]?.bargeInCount).toBeUndefined();
    expect(readFileSync(join(dir, "turns.0.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("post-done barge and interrupted ack mark the still-playing turn", async () => {
  const clock = new FakeScheduler();
  const rows: LatencyRecord[] = [];
  const owner = new LatencyRecordOwner(new LatencyTurn("s", "t", "web_voice", 1, () => clock.now), async (snapshot) => { rows.push(snapshot()); }, clock);
  owner.client(metric("speech_end", 0));
  owner.delivered(1, "reply");
  owner.serverSettled();
  expect(rows).toHaveLength(0);
  owner.client(metric("barge_in", 500));
  owner.ack(1, "interrupted");
  await owner.flush();
  expect(rows[0]).toMatchObject({ interrupted: true, bargeInCount: 1 });
  expect(PAGE).toContain('else if (msg.type === "done") { turnDone = true; if (!playing) { activeTurnId = null; resumeListening(); } }');
  expect(PAGE).toContain('const turnId = activeTurnId || currentAudioItem?.turnId');
});

test("interrupted acknowledgement alone marks the record interrupted", async () => {
  const clock = new FakeScheduler();
  const rows: LatencyRecord[] = [];
  const owner = new LatencyRecordOwner(new LatencyTurn("s", "t", "web_voice", 1, () => clock.now), async (snapshot) => { rows.push(snapshot()); }, clock);
  owner.client(metric("speech_end", 0));
  owner.delivered(1, "reply");
  owner.serverSettled();
  owner.ack(1, "interrupted");
  await owner.flush();
  expect(rows[0]).toMatchObject({ interrupted: true });
  expect(rows[0]?.bargeInCount).toBeUndefined();
});

test("settle deadline writes once when acks never arrive", async () => {
  const clock = new FakeScheduler();
  const rows: LatencyRecord[] = [];
  const owner = new LatencyRecordOwner(new LatencyTurn("s", "t", "web_voice", 1, () => clock.now), async (snapshot) => { rows.push(snapshot()); }, clock, 30_000);
  owner.client(metric("speech_end", 0));
  owner.delivered(1, "reply");
  owner.serverSettled();
  clock.advance(29_999);
  expect(rows).toHaveLength(0);
  clock.advance(1);
  await owner.flush();
  expect(rows).toHaveLength(1);
  owner.ack(1, "interrupted");
  clock.advance(30_000);
  expect(rows).toHaveLength(1);
  expect(clock.tasks.size).toBe(0);
});
