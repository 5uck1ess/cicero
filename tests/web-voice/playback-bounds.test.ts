import { describe, expect, test } from "bun:test";
import { encodeReplyAudioFrame, decodeReplyAudioFrame, decodeAudioAck, encodeTurnAudioFrame, decodeTurnAudioFrame } from "../../src/web-voice/protocol";
import { canQueueAudio, MAX_QUEUED_AUDIO_MS } from "../../src/web-voice/playback-policy";
import { MAX_OUTBOUND_AUDIO_BUFFER_BYTES, makeSink, sendAudioBounded } from "../../src/web-voice/server";
import { recoveryTail } from "../../src/speaker/recovery";
import { CAPTURE_WORKLET } from "../../src/web-voice/capture-worklet";
import { AudioPlaybackGate, waitForPlaybackCredit, type PacingClock } from "../../src/web-voice/audio-pacing";

class FakeClock implements PacingClock {
  time = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  next = 0;
  now(): number { return this.time; }
  setTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + ms, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimer(timer: ReturnType<typeof setTimeout>): void { this.timers.delete(timer as unknown as number); }
  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.time) { this.timers.delete(id); timer.callback(); }
  }
}

function oneSampleWav(): ArrayBuffer {
  const buf = new ArrayBuffer(46);
  const v = new DataView(buf);
  const tag = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) v.setUint8(offset + i, value.charCodeAt(i)); };
  tag(0, "RIFF"); v.setUint32(4, 38, true); tag(8, "WAVE");
  tag(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 24_000, true); v.setUint32(28, 48_000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, "data"); v.setUint32(40, 2, true);
  return buf;
}

describe("web voice playback accounting", () => {
  test("worklet batches 128-frame quanta into bounded 2048-frame copies", () => {
    let Capture: new () => { port: { postMessage: (frame: Float32Array) => void }; process: (inputs: Float32Array[][], outputs: unknown[]) => boolean };
    class Base { port = { postMessage: (_frame: Float32Array) => {} }; }
    new Function("AudioWorkletProcessor", "registerProcessor", CAPTURE_WORKLET)(Base, (_name: string, ctor: typeof Capture) => { Capture = ctor; });
    const node = new Capture!();
    const messages: Float32Array[] = [];
    node.port.postMessage = (frame) => messages.push(frame);
    for (let i = 0; i < 16; i++) expect(node.process([[new Float32Array(128).fill(i)]], [])).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.length).toBe(2048);
    expect(messages[0]?.[0]).toBe(0);
    expect(messages[0]?.[2047]).toBe(15);
  });
  test("v2 reply sequence round trips and v1 payload remains unchanged", () => {
    const payload = new Uint8Array([1, 2, 3]).buffer;
    const sequenced = new Uint8Array(encodeReplyAudioFrame("session", "turn", 7, payload));
    expect(decodeTurnAudioFrame(sequenced)).toMatchObject({ sessionId: "session", turnId: "turn", sequence: 7 });
    expect(new Uint8Array(decodeTurnAudioFrame(sequenced)!.payload)).toEqual(new Uint8Array(payload));
    expect(decodeReplyAudioFrame(new Uint8Array(encodeReplyAudioFrame("session", "turn", 7, payload)))?.sequence).toBe(7);
    expect(new Uint8Array(decodeReplyAudioFrame(new Uint8Array(encodeReplyAudioFrame("session", "turn", 7, payload)))!.payload)).toEqual(new Uint8Array(payload));
    expect(decodeTurnAudioFrame(new Uint8Array(encodeTurnAudioFrame("session", "turn", payload)))?.turnId).toBe("turn");
    expect(decodeReplyAudioFrame(new Uint8Array(payload))).toBeNull();
  });
  test("acks reject invalid sequence and interruption time", () => {
    const base = { type: "audio_ack", sessionId: "session", turnId: "turn", sequence: 1 };
    expect(decodeAudioAck({ ...base, status: "played" })?.status).toBe("played");
    expect(decodeAudioAck({ ...base, status: "interrupted", atMs: 123 })?.atMs).toBe(123);
    expect(decodeAudioAck({ ...base, sequence: 0, status: "played" })).toBeNull();
    expect(decodeAudioAck({ ...base, status: "interrupted", atMs: -1 })).toBeNull();
  });
  test("recovery uses played text and legacy falls back to delivered", () => {
    expect(recoveryTail(["first", "second"], ["first"])).toBe("first");
    expect(recoveryTail(["first"], [])).toBe("");
    expect(recoveryTail(["first"], null)).toBe("first");
  });
  test("queue cap aborts overflow instead of dropping a pending clip", () => {
    expect(canQueueAudio(MAX_QUEUED_AUDIO_MS - 1, 1)).toBe(true);
    expect(canQueueAudio(MAX_QUEUED_AUDIO_MS - 1, 2)).toBe(false);
    expect(canQueueAudio(0, Number.NaN)).toBe(false);
    // An admitted clip longer than the backlog cap still plays on an empty queue
    // (review: 121 s 8 kHz mono clip was aborted with nothing queued).
    expect(canQueueAudio(0, 121_000)).toBe(true);
    expect(canQueueAudio(1, 121_000)).toBe(false);
  });
  test("socket bound rejects before enqueue and detects dropped sends", () => {
    let sent = 0;
    const socket = { getBufferedAmount: () => MAX_OUTBOUND_AUDIO_BUFFER_BYTES - 2, send: () => { sent++; return -1; } };
    expect(() => sendAudioBounded(socket as never, new ArrayBuffer(3))).toThrow("backpressure");
    expect(sent).toBe(0);
    expect(() => sendAudioBounded({ getBufferedAmount: () => 0, send: () => 0 } as never, new ArrayBuffer(1))).toThrow("delivery failed");
  });
  test("v1 and v2 sinks emit audio synchronously before a following done", () => {
    for (const protocol of [1, 2] as const) {
      const sent: Array<string | ArrayBuffer> = [];
      const controller = new AbortController();
      const turn = { turnId: "turn", aborted: false, controller, signal: controller.signal,
        nextSequence: 0, delivered: new Map<number, string>(), played: [], pacing: new AudioPlaybackGate() };
      const socket = { data: { protocol, sessionId: "session", current: turn },
        getBufferedAmount: () => 0, send: (frame: string | ArrayBuffer) => { sent.push(frame); return 1; } };
      const sink = makeSink(socket as never, turn as never);
      expect(sink.audio(oneSampleWav(), "hello")).toBeUndefined();
      sink.done();
      expect(sent).toHaveLength(2);
      expect(sent[0]).toBeInstanceOf(ArrayBuffer);
      expect(JSON.parse(sent[1] as string).type).toBe("done");
      if (protocol === 2) expect(decodeTurnAudioFrame(new Uint8Array(sent[0] as ArrayBuffer))?.sequence).toBe(1);
    }
  });
  test("sink reports invalid audio synchronously before done", () => {
    const sent: string[] = [];
    const controller = new AbortController();
    const turn = { turnId: "turn", aborted: false, controller, signal: controller.signal,
      nextSequence: 0, delivered: new Map<number, string>(), played: [], pacing: new AudioPlaybackGate() };
    const socket = { data: { protocol: 1, sessionId: "session", current: turn },
      getBufferedAmount: () => 0, send: (frame: string) => { sent.push(frame); return 1; } };
    const sink = makeSink(socket as never, turn as never);
    expect(sink.audio(new ArrayBuffer(8))).toBeUndefined();
    sink.done();
    expect(sent.map((frame) => JSON.parse(frame).type)).toEqual(["error", "done"]);
  });
  test("done waits behind an audio frame blocked on v2 credit", async () => {
    const sent: Array<string | ArrayBuffer> = [];
    const controller = new AbortController();
    const pacing = new AudioPlaybackGate();
    pacing.track(1, 12_000);
    const turn = { turnId: "turn", aborted: false, controller, signal: controller.signal,
      nextSequence: 1, delivered: new Map<number, string>(), played: [], pacing };
    const socket = { data: { protocol: 2, sessionId: "session", current: turn },
      getBufferedAmount: () => 0, send: (frame: string | ArrayBuffer) => { sent.push(frame); return 1; } };
    const sink = makeSink(socket as never, turn as never);
    const pending = sink.audio(oneSampleWav(), "hello");
    sink.done();
    expect(sent).toHaveLength(0);
    pacing.acknowledge(1);
    await pending;
    await Promise.resolve();
    expect(sent[0]).toBeInstanceOf(ArrayBuffer);
    expect(JSON.parse(sent[1] as string).type).toBe("done");
  });
  test("40 one-second clips finish as played acks return credit", async () => {
    const gate = new AudioPlaybackGate(new FakeClock());
    const signal = new AbortController().signal;
    let sent = 0;
    let oldest = 1;
    const socket = { getBufferedAmount: () => 0, send: () => { sent++; return 1; } };
    for (let sequence = 1; sequence <= 40; sequence++) {
      if (gate.pendingMs === 12_000) expect(gate.acknowledge(oldest++)).toBe(true);
      await waitForPlaybackCredit(2, gate, 1_000, signal);
      sendAudioBounded(socket as never, new ArrayBuffer(1));
      gate.track(sequence, 1_000);
    }
    expect(sent).toBe(40);
    expect(gate.pendingMs).toBe(12_000);
  });
  test("production waits at the duration cap and resumes on played or interrupted ack", async () => {
    const gate = new AudioPlaybackGate(new FakeClock());
    const signal = new AbortController().signal;
    for (let i = 1; i <= 12; i++) gate.track(i, 1_000);
    let resumed = false;
    const pending = waitForPlaybackCredit(2, gate, 1_000, signal).then(() => { resumed = true; });
    await Promise.resolve();
    expect(resumed).toBe(false);
    expect(gate.acknowledge(1)).toBe(true);
    await pending;
    expect(resumed).toBe(true);
    expect(gate.pendingMs).toBe(11_000);
  });
  test("abort releases a blocked producer immediately", async () => {
    const clock = new FakeClock();
    const gate = new AudioPlaybackGate(clock);
    gate.track(1, 12_000);
    const controller = new AbortController();
    const pending = waitForPlaybackCredit(2, gate, 1_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(clock.timers.size).toBe(0);
  });
  test("no-ack stall fails at the injected absolute deadline", async () => {
    const clock = new FakeClock();
    const gate = new AudioPlaybackGate(clock);
    gate.track(1, 12_000);
    const pending = waitForPlaybackCredit(2, gate, 1_000, new AbortController().signal);
    clock.advance(42_001);
    await expect(pending).rejects.toThrow("acknowledgement timed out");
    expect(clock.timers.size).toBe(0);
  });
  test("sequential expected end uses send times and re-bases after ack progress", async () => {
    const clock = new FakeClock();
    const gate = new AudioPlaybackGate(clock);
    gate.track(1, 31_000);
    clock.advance(2_000);
    gate.track(2, 1_000);
    expect(gate.expectedPlaybackEndMs).toBe(32_000);
    const pending = gate.waitForCapacity(121_000, new AbortController().signal);
    clock.advance(38_000); // now 40s; first clip's ack is late but valid progress
    gate.acknowledge(1);
    expect(gate.expectedPlaybackEndMs).toBe(41_000);
    clock.advance(22_001); // old 32s + 30s deadline has passed
    expect(clock.timers.size).toBe(1);
    clock.advance(8_000); // now 70.001s, still before new 71s deadline
    expect(clock.timers.size).toBe(1);
    clock.advance(1_000);
    await expect(pending).rejects.toThrow("acknowledgement timed out");
  });
  test("v1 delivery is unpaced even with full outstanding credit", async () => {
    const gate = new AudioPlaybackGate(new FakeClock());
    gate.track(1, 12_000);
    await waitForPlaybackCredit(1, gate, 1_000, new AbortController().signal);
    expect(gate.pendingMs).toBe(12_000);
  });
});
