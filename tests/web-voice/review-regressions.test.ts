import { expect, test } from "bun:test";
import { PAGE } from "../../src/web-voice/page";
import { canQueueAudio } from "../../src/web-voice/playback-policy";
import { inspectTurnAudio } from "../../src/web-voice/protocol";
import { createRecordedWebTurn } from "../../src/daemon";
import { CONTROL_FRAME_RESERVE_BYTES, MAX_OUTBOUND_AUDIO_BUFFER_BYTES, makeSink, sendAudioBounded } from "../../src/web-voice/server";
import { AudioPlaybackGate } from "../../src/web-voice/audio-pacing";
import { streamWebTextTurn, type WebReplySink, type WebStreamDeps } from "../../src/web-voice/turn";

const script = PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
function pageFunction(name: string, next: string): string {
  const start = script.indexOf(`function ${name}(`);
  const end = script.indexOf(`\nfunction ${next}(`, start);
  if (start < 0 || end < 0) throw new Error(`page function ${name} not found`);
  return script.slice(start, end);
}
function wav31sStereoFloat(): ArrayBuffer {
  const dataBytes = 31 * 8_000 * 2 * 4;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const tag = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  tag(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 2, true);
  view.setUint32(24, 8_000, true); view.setUint32(28, 64_000, true); view.setUint16(32, 8, true); view.setUint16(34, 32, true);
  tag(36, "data"); view.setUint32(40, dataBytes, true);
  return buffer;
}
function oneSampleWav(): ArrayBuffer {
  const buffer = new ArrayBuffer(46);
  const view = new DataView(buffer);
  const tag = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  tag(0, "RIFF"); view.setUint32(4, 38, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true); view.setUint32(28, 16_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, 2, true);
  return buffer;
}

test("frame-less immediate and parked notifications enter the page queue", () => {
  const queue: unknown[] = [];
  const context = { audioQueue: queue, queuedAudioMs: 0, playing: true,
    wavEnvelope: () => ({ env: [1], rate: 20, durationMs: 1_000 }), canQueueAudio,
    abortActiveTurn: () => { throw new Error("unexpected abort"); }, stopPlayback: () => {}, setStatus: () => {}, playNext: () => {} };
  const enqueue = new Function("context", `with (context) { ${pageFunction("enqueueAudio", "playNext")}; return enqueueAudio; }`)(context) as (buf: ArrayBuffer) => void;
  enqueue(new ArrayBuffer(1)); // immediate notify
  enqueue(new ArrayBuffer(1)); // parked notify drain
  expect(queue).toHaveLength(2);
});

test("recorded turn forwards chunk text and acknowledged playback capability", () => {
  let audioText: string | undefined;
  const sink: WebReplySink = { transcript: () => {}, sentence: () => {},
    audio: (_buf, text) => { audioText = text; }, control: () => {}, done: () => {}, error: () => {},
    aborted: () => true, playedText: () => [] };
  const recorded = createRecordedWebTurn(sink, { append: async () => {} });
  recorded.sink.audio(new ArrayBuffer(0), "heard sentence");
  expect(audioText).toBe("heard sentence");
  expect(recorded.sink.playedText?.()).toEqual([]);
});

test("recorded text turn recovers only acknowledged playback after barge-in", async () => {
  let aborted = false;
  const audioTexts: string[] = [];
  const recovered: string[] = [];
  const sink: WebReplySink = { transcript: () => {}, sentence: () => {},
    audio: (_buf, text) => { audioTexts.push(text ?? ""); aborted = true; },
    control: () => {}, done: () => {}, error: () => {}, aborted: () => aborted, playedText: () => [] };
  const recorded = createRecordedWebTurn(sink, { append: async () => {} });
  const deps: WebStreamDeps = { stt: { transcribe: async () => "" },
    brain: { send: async () => "First. Second." }, tts: { generateAudio: async () => oneSampleWav() },
    recover: { store: (text) => recovered.push(text), pending: () => null } };
  await streamWebTextTurn("go", deps, recorded.sink);
  expect(audioTexts).toEqual(["First."]);
  expect(recovered).toEqual([]);
});

test("page duration matches admitted 31-second 8 kHz stereo float WAV", () => {
  const wav = wav31sStereoFloat();
  expect(inspectTurnAudio(wav)?.durationMs).toBe(31_000);
  const envelope = new Function("buf", `${pageFunction("wavEnvelope", "sendAudioAck")}; return wavEnvelope(buf);`)(wav) as { durationMs: number };
  expect(envelope.durationMs).toBe(31_000);
  expect(canQueueAudio(0, envelope.durationMs)).toBe(true);
});

test("terminal frame failure closes socket instead of silently dropping done", () => {
  const controller = new AbortController();
  const turn = { turnId: "turn", aborted: false, controller, signal: controller.signal,
    nextSequence: 0, delivered: new Map(), played: [], pacing: new AudioPlaybackGate() };
  const closes: number[] = [];
  const socket = { data: { protocol: 2, sessionId: "session", current: turn },
    getBufferedAmount: () => MAX_OUTBOUND_AUDIO_BUFFER_BYTES - 32,
    send: (_frame: string | ArrayBuffer) => 1,
    close: (code: number) => { closes.push(code); } };
  makeSink(socket as never, turn as never).done();
  expect(closes).toEqual([1011]);
});

test("all turn control sends close visibly when the socket cannot accept them", () => {
  const controller = new AbortController();
  const turn = { turnId: "turn", aborted: false, controller, signal: controller.signal,
    nextSequence: 0, delivered: new Map(), played: [], pacing: new AudioPlaybackGate() };
  const closes: number[] = [];
  const socket = { data: { protocol: 2, sessionId: "session", current: turn },
    getBufferedAmount: () => MAX_OUTBOUND_AUDIO_BUFFER_BYTES - 1,
    send: (_frame: string | ArrayBuffer) => 1,
    close: (code: number) => { closes.push(code); } };
  const sink = makeSink(socket as never, turn as never);
  sink.transcript("heard"); sink.sentence("reply"); sink.control({ type: "rate", rate: 1 });
  sink.error("failed"); sink.done();
  expect(closes).toEqual([1011, 1011, 1011, 1011, 1011]);
});

test("audio admission preserves headroom for a terminal frame", () => {
  let buffered = 0;
  const socket = { getBufferedAmount: () => buffered,
    send: (frame: ArrayBuffer) => { buffered += frame.byteLength; return frame.byteLength; } };
  const clipBytes = Math.floor((MAX_OUTBOUND_AUDIO_BUFFER_BYTES - 32) / 2);
  sendAudioBounded(socket as never, new ArrayBuffer(clipBytes));
  expect(() => sendAudioBounded(socket as never, new ArrayBuffer(clipBytes))).toThrow("backpressure");
  expect(MAX_OUTBOUND_AUDIO_BUFFER_BYTES - buffered).toBeGreaterThanOrEqual(CONTROL_FRAME_RESERVE_BYTES);
});
