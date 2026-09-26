import { expect, test } from "bun:test";
import { PAGE } from "../../src/web-voice/page";
import { canQueueAudio } from "../../src/web-voice/playback-policy";
import { inspectTurnAudio } from "../../src/web-voice/protocol";
import { createRecordedWebTurn } from "../../src/daemon";
import { CONTROL_FRAME_RESERVE_BYTES, MAX_OUTBOUND_AUDIO_BUFFER_BYTES, makeSink, sendAudioBounded, streamCapabilityEvent } from "../../src/web-voice/server";
import { ProviderSlot, SwappableSTTProvider } from "../../src/backends/hot-swap";
import type { STTProvider } from "../../src/backends/stt/provider";
import { AudioPlaybackGate } from "../../src/web-voice/audio-pacing";
import { streamWebTextTurn, type WebReplySink, type WebStreamDeps } from "../../src/web-voice/turn";

const script = PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";

test("handshake follows the swappable STT provider on each cutover", async () => {
  const streaming: STTProvider = {
    name: "streaming", transcribe: async () => "hello", health: async () => true,
    openStream: () => ({ push() {}, end: async () => "hello", abort() {}, final: Promise.resolve("hello"),
      partials: { async *[Symbol.asyncIterator]() {} }, released: true }),
  };
  const batch: STTProvider = { name: "batch", transcribe: async () => "hello", health: async () => true };
  const slot = new ProviderSlot<STTProvider>(streaming);
  const provider = new SwappableSTTProvider(slot);
  let prior = false;
  const events: string[] = [];
  const refresh = () => {
    const available = typeof provider.openStream === "function";
    const event = streamCapabilityEvent(prior, available);
    if (event) events.push(event);
    prior = available;
  };
  refresh();
  await slot.swap(batch, () => {});
  expect(provider.openStream).toBeUndefined();
  refresh();
  await slot.swap(streaming, () => {});
  refresh();
  expect(events).toEqual(["stream_on", "stream_off", "stream_on"]);
  await slot.stop();
});

test("browser stream_off stops CVS2 immediately and the next stream_on arms the next turn", () => {
  const context = { streamOn: true, streamCaptureEnabled: true, streamCaptureFailed: false, aborts: 0,
    abortLiveCapture() { this.aborts++; } };
  const apply = new Function("context", `with (context) { ${pageFunction("applyStreamCapability", "sendLiveFrame")}; return applyStreamCapability; }`)(context) as (available: boolean) => void;
  apply(false);
  expect(context).toMatchObject({ streamOn: false, streamCaptureEnabled: false, streamCaptureFailed: true, aborts: 1 });
  apply(true);
  expect(context.streamOn).toBe(true);
  expect(context.streamCaptureEnabled).toBe(false);
});
test("early PCM stays in the page capture buffer until the minimum duration commits it", () => {
  const sent: Float32Array[] = [];
  const first = new Float32Array(2_000);
  const second = new Float32Array(2_000);
  const context = { streamCaptureEnabled: true, streamCaptureCommitted: false, pendingBargeAbort: false,
    audioCtx: { sampleRate: 16_000 }, speechLen: first.length, speechFrames: [first],
    MIN_UTTER_MS: 250, ptt: true, state: "speech", sendLiveFrame: (frame: Float32Array) => sent.push(frame) };
  const commit = new Function("context", `with (context) { ${pageFunction("commitLiveCapture", "encodeTurnFrame")}; return commitLiveCapture; }`)(context) as () => void;
  commit();
  expect(sent).toEqual([]); // a stray tap never creates a CVS2 stream
  context.speechFrames.push(second);
  context.speechLen += second.length;
  context.state = "thinking";
  commit();
  expect(sent).toEqual([]); // a hold during thinking waits for the barge threshold too
  context.state = "speech";
  commit();
  expect(sent).toEqual([first, second]);
  expect(context.streamCaptureCommitted).toBe(true);
  commit();
  expect(sent).toHaveLength(2);
});
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

test("held voice turn captures hands-free continuation and aborts the old response", () => {
  let aborts = 0;
  const context = {
    state: "held", rms: 0, micLevel: 0, ptt: false,
    preRoll: [] as Float32Array[], onsetFrames: 0, noiseFloor: 0.01,
    ABS_OPEN: 0.01, OPEN_FACTOR: 2, MIN_ONSET_MS: 1, PREROLL_MS: 1, VAD_POS: 0.5,
    speechFrames: [] as Float32Array[], speechLen: 0, silenceFrames: 0, lastVoicedAt: 0,
    rmsOf: () => 0.2, speechGateFeed() {}, speechConfirmed: () => true,
    frameCount: () => 1, beginCaptureIdentity() {}, commitLiveCapture() {}, updateDebug() {},
    abortActiveTurn() { aborts++; },
    setState(value: string) { this.state = value; },
  };
  const frame = new Function("context", `with (context) { ${pageFunction("onFrame", "finalizeUtterance")}; return onFrame; }`)(context);
  frame(new Float32Array([0.2, 0.2]));
  expect(context.state).toBe("speech");
  expect(context.speechLen).toBe(2);
  expect(aborts).toBe(1);
});

test("hold control reopens capture but accepts the deadline reply for the same turn", () => {
  const audio: unknown[] = [];
  const context = {
    state: "thinking", wsSessionId: "s", activeTurnId: "t", turnDone: false, playing: false,
    playbackPaused: false, captureTurnId: null, tentativeBarge: null,
    preRoll: [], onsetFrames: 0, orbLabel: { textContent: "" }, hintEl: { textContent: "" },
    setState(value: string) { this.state = value; }, setStatus() {},
    resumeListening() { this.state = "listening"; },
    decodeReplyFrame: () => ({ sessionId: "s", turnId: "t", payload: "audio" }),
    enqueueAudio: (value: unknown) => audio.push(value),
  };
  const receive = new Function("context", `with (context) { ${pageFunction("onWsMessage", "scheduleReconnect")}; return onWsMessage; }`)(context);
  const send = (type: string, turnId = "t") => receive({ data: JSON.stringify({ type, sessionId: "s", turnId, text: "combined" }) });
  send("hold");
  expect(context.state).toBe("held");
  expect(context.activeTurnId).toBe("t");
  send("done", "old");
  expect(context.state).toBe("held");
  receive({ data: new ArrayBuffer(1) });
  expect(audio).toEqual(["audio"]);
  send("transcript");
  expect(context.state).toBe("thinking");
  expect(context.hintEl.textContent).toContain("combined");
  send("done");
  expect(context.state).toBe("listening");
});

test("a short PTT tap during a hold preserves its pending deadline reply", () => {
  let aborts = 0;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const context = {
    state: "held", ptt: true, convOn: true, ready: true, holding: false,
    pttBargeTimer: null as number | null, MIN_UTTER_MS: 250,
    activeTurnId: "original", captureTurnId: null as string | null,
    speechFrames: [], speechLen: 0, silenceFrames: 0, onsetFrames: 0,
    audioCtx: { sampleRate: 16000 }, orbLabel: { textContent: "" },
    beginCaptureIdentity() { this.captureTurnId = "continuation"; },
    abortActiveTurn() { aborts++; this.activeTurnId = ""; }, abortLiveCapture() {},
    setStatus() {}, setState(value: string) { this.state = value; },
    resumeListening() { this.state = "listening"; },
    setTimeout(fn: () => void) { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout(id: number) { timers.delete(id); },
  };
  const methods = new Function("context", `with (context) {
    ${pageFunction("beginPtt", "endPtt")}
    ${pageFunction("endPtt", "resumeListening")}
    return { beginPtt, endPtt };
  }`)(context);
  methods.beginPtt();
  methods.endPtt();
  expect(aborts).toBe(0);
  expect(context.state).toBe("held");
  expect(context.activeTurnId).toBe("original");
  expect(context.captureTurnId).toBeNull();
  expect(timers.size).toBe(0);
});
