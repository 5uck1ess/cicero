import { expect, test } from "bun:test";
import { AudioPlaybackGate, type PacingClock } from "../../src/web-voice/audio-pacing";
import { makeSink } from "../../src/web-voice/server";
import { streamWebTextTurn, type WebReplySink, type WebStreamDeps } from "../../src/web-voice/turn";

class Clock implements PacingClock {
  time = 0;
  next = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + ms, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimer(timer: ReturnType<typeof setTimeout>): void { this.timers.delete(timer as unknown as number); }
  advance(ms: number): void {
    const target = this.time + ms;
    while (true) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = target;
  }
}

function wav(ms: number): ArrayBuffer {
  const sampleRate = 8_000;
  const frames = ms * sampleRate / 1_000;
  const buffer = new ArrayBuffer(44 + frames); // 8-bit mono PCM; 121 s stays under 4 MiB
  const view = new DataView(buffer);
  const tag = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  tag(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  tag(36, "data"); view.setUint32(40, frames, true);
  new Uint8Array(buffer).fill(128, 44);
  return buffer;
}

type WaitState = "available" | "behind short" | "behind long";
type Termination = "completes" | "operator abort" | "no-ack stall";

for (const clipMs of [1_000, 31_000, 121_000]) {
  for (const waitState of ["available", "behind short", "behind long"] as WaitState[]) {
    for (const termination of ["completes", "operator abort", "no-ack stall"] as Termination[]) {
      test(`pacing matrix: ${clipMs}ms / ${waitState} / ${termination}`, async () => {
        const clock = new Clock();
        const gate = new AudioPlaybackGate(clock);
        const controller = new AbortController();
        const frames: Array<string | ArrayBuffer> = [];
        const turn = { turnId: "turn", aborted: false, controller, signal: controller.signal,
          nextSequence: 0, delivered: new Map<number, string>(), played: ["Heard."], pacing: gate };
        const socket = { data: { protocol: 2, sessionId: "session", current: turn },
          getBufferedAmount: () => 0, send: (frame: string | ArrayBuffer) => { frames.push(frame); return 1; },
          close: () => {} };
        const base = makeSink(socket as never, turn as never);
        const prefilled: number[] = [];
        if (waitState === "behind short") {
          for (let i = 1; i <= 12; i++) { gate.track(100 + i, 1_000); prefilled.push(100 + i); }
        } else if (waitState === "behind long") {
          gate.track(100, 31_000); prefilled.push(100);
        }
        const target = wav(clipMs);
        if (termination === "completes") {
          const sent = base.audio(target, "Target.");
          if (prefilled.length) {
            expect(sent).toBeInstanceOf(Promise);
            clock.advance(gate.expectedPlaybackEndMs - clock.now());
            for (const sequence of prefilled) gate.acknowledge(sequence);
          } else expect(sent).toBeUndefined();
          await sent;
          expect(gate.acknowledge(turn.nextSequence)).toBe(true);
          base.done();
          expect(gate.pendingMs).toBe(0);
          expect(frames.filter((frame) => frame instanceof ArrayBuffer)).toHaveLength(1);
          expect(frames.some((frame) => typeof frame === "string" && JSON.parse(frame).type === "done")).toBe(true);
          return;
        }

        let resolveWaiting!: () => void;
        const waiting = new Promise<void>((resolve) => { resolveWaiting = resolve; });
        const sink: WebReplySink = { ...base, audio: (buffer, text) => {
          const result = base.audio(buffer, text);
          if (result instanceof Promise) resolveWaiting();
          return result;
        } };
        const recovered: string[] = [];
        const nextMs = clipMs === 1_000 ? 121_000 : 1_000;
        const deps: WebStreamDeps = {
          stt: { transcribe: async () => "" },
          brain: { send: async () => "Target. Next." },
          tts: { generateAudio: async (text) => text.startsWith("Target") ? target : wav(nextMs) },
          signal: controller.signal,
          recover: { store: (text) => recovered.push(text), pending: () => null },
        };
        const running = streamWebTextTurn("request", deps, sink);
        await waiting; // first target waits behind prefill, or Next waits behind target
        // The oracle comes from the clips and send time, not the gate's estimate.
        const expectedEnd = waitState === "behind short" ? 12_000
          : waitState === "behind long" ? 31_000 : clipMs;
        if (termination === "operator abort") {
          controller.abort();
          await running;
          expect(recovered).toEqual(["Heard."]);
          expect(clock.timers.size).toBe(0);
        } else {
          let finished = false;
          void running.finally(() => { finished = true; });
          if (expectedEnd >= 31_000) {
            clock.advance(30_001);
            await Promise.resolve();
            expect(finished).toBe(false); // a long clip is still playing
          }
          clock.advance(expectedEnd + 30_000 - clock.now());
          await Promise.resolve();
          expect(finished).toBe(false); // expected playback is not a stall
          clock.advance(1);
          await running;
          expect(recovered).toEqual(["Heard."]);
          expect(frames.some((frame) => typeof frame === "string" && JSON.parse(frame).type === "error")).toBe(true);
          expect(clock.timers.size).toBe(0);
        }
      });
    }
  }
}

test("pacing matrix: late ack rebases the remaining clip and stall deadline", async () => {
  const clock = new Clock();
  const gate = new AudioPlaybackGate(clock);
  const controller = new AbortController();
  gate.track(1, 31_000); // expected end at 31 s
  clock.advance(2_000);
  gate.track(2, 1_000); // queued behind the first; expected end at 32 s
  expect(gate.expectedPlaybackEndMs).toBe(32_000);

  const pending = gate.waitForCapacity(121_000, controller.signal);
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  clock.advance(38_000); // ack arrives late, at 40 s
  gate.acknowledge(1);
  expect(gate.expectedPlaybackEndMs).toBe(41_000); // remaining second starts at ack

  clock.advance(22_001); // past the original 32 s + 30 s deadline
  await Promise.resolve();
  expect(settled).toBe(false);
  clock.advance(8_999); // exactly the rebased 41 s + 30 s deadline
  await Promise.resolve();
  expect(settled).toBe(false);
  clock.advance(1);
  await expect(pending).rejects.toThrow("web voice audio acknowledgement timed out");
  expect(clock.timers.size).toBe(0);
});

test("pacing matrix: an unacked 31 s clip does not stall until playback end plus grace", async () => {
  const clock = new Clock();
  const gate = new AudioPlaybackGate(clock);
  gate.track(1, 31_000);
  const pending = gate.waitForCapacity(1_000, new AbortController().signal);
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });

  clock.advance(30_001); // beyond 30 s from the start, within playback
  await Promise.resolve();
  expect(settled).toBe(false);
  clock.advance(30_999); // exactly 31 s playback + 30 s grace
  await Promise.resolve();
  expect(settled).toBe(false);
  clock.advance(1);
  await expect(pending).rejects.toThrow("web voice audio acknowledgement timed out");
  expect(clock.timers.size).toBe(0);
});
