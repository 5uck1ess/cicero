import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeClientMetric } from "../src/web-voice/protocol";
import { LatencyTurn, LatencyStore, recordAudioStart, percentile, summarizeLatency, formatLatency } from "../src/latency";

test("v2 metric frames admit only bounded identities and durations; unrelated v1 controls stay untouched", () => {
  expect(decodeClientMetric({ type: "client_metric", sessionId: "s", turnId: "t", event: "audio_started", sequence: 1, sinceSpeechEndMs: 123 })).toMatchObject({ sequence: 1, sinceSpeechEndMs: 123 });
  expect(decodeClientMetric({ type: "client_metric", sessionId: "s", turnId: "t", event: "speech_end", sinceSpeechEndMs: 0 }, 1)).toBeNull();
  expect(decodeClientMetric({ type: "client_metric", sessionId: "s", turnId: "t", event: "audio_started", sequence: 1, sinceSpeechEndMs: -1 })).toBeNull();
  expect(decodeClientMetric({ type: "client_metric", sessionId: "s", turnId: "t", event: "audio_started", sequence: 1, sinceSpeechEndMs: Infinity })).toBeNull();
  expect(decodeClientMetric({ type: "client_metric", sessionId: "s", turnId: "t", event: "audio_started", sequence: 1, sinceSpeechEndMs: 1e9 })).toBeNull();
  expect(decodeClientMetric({ type: "client_metric", sessionId: "s", turnId: "t", event: "audio_started", sinceSpeechEndMs: 123 })).toBeNull();
  expect(decodeClientMetric({ type: "client_metric", sessionId: "s", turnId: "t", event: "audio_started", sequence: 0, sinceSpeechEndMs: 123 })).toBeNull();
  expect(decodeClientMetric({ type: "client_metric", sessionId: "s", turnId: "bad id", event: "speech_end", sinceSpeechEndMs: 0 })).toBeNull();
  expect(decodeClientMetric({ type: "abort", sessionId: "s", turnId: "t" })).toBeNull();
});

test("record assembles browser durations and server spans with injected clock", () => {
  let now = 100;
  const t = new LatencyTurn("s", "t", "web_voice", 1000, () => now);
  t.client({ type: "client_metric", sessionId: "s", turnId: "t", event: "speech_end", sinceSpeechEndMs: 0 });
  t.mark("stt", 120);
  t.mark("brain_start", 120);
  t.mark("brain_first_token", 360);
  t.mark("first_sentence", 360);
  t.mark("first_audio", 410);
  t.mark("parked", 500);
  const kinds = new Map<number, "reply" | "filler">([[1, "filler"], [2, "reply"]]);
  expect(recordAudioStart(t, kinds, 1, 300)).toBe(true);
  expect(recordAudioStart(t, kinds, 1, 301)).toBe(false);
  expect(recordAudioStart(t, kinds, 2, 520)).toBe(true);
  now = 550; t.abort(); now = 610;
  expect(t.finish()).toMatchObject({ speechEndToReplyMs: 520, speechEndToFillerMs: 300, sttMs: 120, brainFirstTokenMs: 240, ttsFirstAudioMs: 50, cancellationSettlementMs: 60, interrupted: true, parked: true });
});

test("record ignores playback before speech end and mismatched turn identities", () => {
  const t = new LatencyTurn("s", "t", "web_voice", 1, () => 0);
  t.started("reply", 99);
  t.client({ type: "client_metric", sessionId: "s", turnId: "other", event: "speech_end", sinceSpeechEndMs: 0 });
  expect(t.finish().speechEndToReplyMs).toBeUndefined();
});

test("percentile math and report formatting omit unavailable metrics", () => {
  expect(percentile([10, 20, 30, 40], 0.5)).toBe(20);
  expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
  const rows = [{ sessionId: "s", turnId: "t", surface: "web_voice" as const, at: 1, interrupted: false, parked: false, speechEndToReplyMs: 120 }];
  const summary = summarizeLatency(rows);
  expect(summary.web_voice.speechEndToReplyMs).toEqual({ count: 1, p50: 120, p95: 120 });
  expect(formatLatency(summary)).toContain("web_voice  speech_end→reply  1  120  120");
});

test("private JSONL ring rotates under count and byte caps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-latency-"));
  try {
    const store = new LatencyStore(dir, { segmentCount: 2, rowsPerSegment: 2, bytesPerSegment: 450 });
    for (let i = 0; i < 7; i++) await store.append({ sessionId: "s", turnId: `t${i}`, surface: "web_voice", at: i, interrupted: false, parked: false, speechEndToReplyMs: i });
    const rows = await store.read(100);
    expect(rows.length).toBeLessThanOrEqual(4);
    expect(rows.at(-1)?.turnId).toBe("t6");
    expect(readdirSync(dir).length).toBeLessThanOrEqual(2);
    for (const file of readdirSync(dir)) expect(readFileSync(join(dir, file)).byteLength).toBeLessThanOrEqual(450);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI table is formatted from a private fixture file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-latency-fixture-"));
  try {
    const store = new LatencyStore(dir);
    await store.append({ sessionId: "fixture", turnId: "one", surface: "web_voice", at: 1, interrupted: false, parked: false, speechEndToReplyMs: 240 });
    await store.append({ sessionId: "fixture", turnId: "two", surface: "web_voice", at: 2, interrupted: false, parked: false, speechEndToReplyMs: 440 });
    expect(formatLatency(summarizeLatency(await store.read(2)))).toContain("web_voice  speech_end→reply  2  240  440");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
