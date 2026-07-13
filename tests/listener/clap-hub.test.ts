import { test, expect } from "bun:test";
import { VadRecorder } from "../../src/listener/vad-recorder";
import { ClapListener } from "../../src/listener/clap-listener";
import type { AecAudioHub } from "../../src/platform/aec-hub";

/**
 * A stand-in for AecAudioHub that only implements the mic-sink contract the
 * recorder/clap-listener use. `push` simulates the helper emitting PCM frames.
 */
class FakeHub {
  running = true;
  sink: ((chunk: Uint8Array) => void) | null = null;
  ended: (() => void) | null = null;
  isRunning(): boolean { return this.running; }
  waitForRelease(): Promise<void> { return Promise.resolve(); }
  setMicSink(fn: ((chunk: Uint8Array) => void) | null, onEnd?: () => void): void {
    if (fn && !this.running) {
      this.sink = null;
      this.ended = null;
      onEnd?.();
      return;
    }
    this.sink = fn;
    this.ended = fn ? (onEnd ?? null) : null;
  }
  push(bytes: Uint8Array): void {
    this.sink?.(bytes);
  }
  end(): void {
    this.running = false;
    this.sink = null;
    const ended = this.ended;
    this.ended = null;
    ended?.();
  }
}

/** Build s16le PCM for `peaks.length` frames; each frame's first sample is set to
 *  `peak × full-scale` so framePeak/RMS see that amplitude. */
function pcmFrames(frameSamples: number, peaks: number[]): Uint8Array {
  const out = new Uint8Array(peaks.length * frameSamples * 2);
  const dv = new DataView(out.buffer);
  for (let f = 0; f < peaks.length; f++) {
    dv.setInt16(f * frameSamples * 2, Math.round((peaks[f] ?? 0) * 32767), true);
  }
  return out;
}

function pcmLevelFrames(frameSamples: number, levels: number[]): Uint8Array {
  const out = new Uint8Array(levels.length * frameSamples * 2);
  const dv = new DataView(out.buffer);
  for (let f = 0; f < levels.length; f++) {
    const sample = Math.round((levels[f] ?? 0) * 32767);
    for (let i = 0; i < frameSamples; i++) dv.setInt16((f * frameSamples + i) * 2, sample, true);
  }
  return out;
}

test("VadRecorder cancels capture on a double-clap when clap is armed", async () => {
  const hub = new FakeHub();
  const rec = new VadRecorder({
    micHub: hub as unknown as AecAudioHub,
    clapGesture: { threshold: 0.5, minGapMs: 80, maxGapMs: 600, onDoubleClap: () => {} },
    frameMs: 30,
    onsetTimeoutMs: 5000,
    maxDurationMs: 240,
    prerollMs: 0,
  });
  rec.setClapEnabled(true);

  // 480 samples/frame @ 16kHz; claps at frame 3 (90ms) and 7 (210ms) → gap 120ms.
  const buf = pcmFrames(480, [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]);
  const p = rec.capture("/tmp/cicero-clap-armed.wav");
  hub.push(buf);
  const result = await p;

  expect(result.status).toBe("cancelled");
});

test("VadRecorder ignores the same double-clap when clap is disarmed", async () => {
  const hub = new FakeHub();
  const rec = new VadRecorder({
    micHub: hub as unknown as AecAudioHub,
    clapGesture: { threshold: 0.5, minGapMs: 80, maxGapMs: 600, onDoubleClap: () => {} },
    frameMs: 30,
    onsetTimeoutMs: 5000,
    maxDurationMs: 240,
    prerollMs: 0,
  });
  rec.setClapEnabled(false); // the plain-listen state — a clap must not cancel

  const buf = pcmFrames(480, [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]);
  const p = rec.capture("/tmp/cicero-clap-disarmed.wav");
  hub.push(buf);
  const result = await p;

  // Terminates on the max-duration cap, not a clap cancellation.
  expect(result.status).not.toBe("cancelled");
});

test("ClapListener reads claps from the hub and releases the sink on stop", () => {
  const hub = new FakeHub();
  let claps = 0;
  const cl = new ClapListener({
    onDoubleClap: () => { claps++; },
    micHub: hub as unknown as AecAudioHub,
  });

  cl.start();
  expect(hub.sink).not.toBeNull(); // acquired the hub mic, no sox spawned

  // frameSamples=1024 default (64ms); claps at frame 0 and frame 3 → gap 192ms.
  cl.start(); // idempotent — second call is a no-op while running
  hub.push(pcmFrames(1024, [1, 0, 0, 1, 0]));
  expect(claps).toBe(1);

  cl.stop();
  expect(hub.sink).toBeNull(); // released so the conversational recorder can take it
});

test("ClapListener rejects an initially stopped hub without claiming running ownership", async () => {
  try {
    const hub = new FakeHub();
    hub.running = false;
    const cl = new ClapListener({
      onDoubleClap: () => {},
      micHub: hub as unknown as AecAudioHub,
    }) as ClapListener & { running: boolean };

    await cl.start();

    expect(cl.running).toBe(false);
    expect(hub.sink).toBeNull();
  } catch (error: unknown) {
    throw error;
  }
});

test("ClapListener clears a failed hub epoch and can arm again", async () => {
  try {
    const hub = new FakeHub();
    const cl = new ClapListener({
      onDoubleClap: () => {},
      micHub: hub as unknown as AecAudioHub,
    }) as ClapListener & { running: boolean };

    await cl.start();
    expect(cl.running).toBe(true);
    hub.end();
    expect(cl.running).toBe(false);
    expect(hub.sink).toBeNull();

    hub.running = true;
    await cl.start();
    expect(cl.running).toBe(true);
    expect(hub.sink).not.toBeNull();
    await cl.stop();
  } catch (error: unknown) {
    throw error;
  }
});

test("a stale hub end callback cannot disarm a newer ClapListener epoch", async () => {
  try {
    const hub = new FakeHub();
    const cl = new ClapListener({
      onDoubleClap: () => {},
      micHub: hub as unknown as AecAudioHub,
    }) as ClapListener & { running: boolean };

    await cl.start();
    const staleEnd = hub.ended;
    await cl.stop();
    hub.running = true;
    await cl.start();
    staleEnd?.();

    expect(cl.running).toBe(true);
    expect(hub.sink).not.toBeNull();
    await cl.stop();
  } catch (error: unknown) {
    throw error;
  }
});

test("VadRecorder carries ambient calibration into the next immediate utterance", async () => {
  const hub = new FakeHub();
  const rec = new VadRecorder({
    micHub: hub as unknown as AecAudioHub,
    frameMs: 30,
    calibrationMs: 90,
    minSpeechMs: 60,
    hangoverMs: 60,
    onsetTimeoutMs: 240,
    maxDurationMs: 300,
    prerollMs: 0,
  });

  const first = rec.capture(`/tmp/cicero-vad-calibrate-${process.pid}.wav`);
  hub.push(pcmLevelFrames(480, new Array(12).fill(0.01)));
  expect((await first).status).toBe("silent");

  // This utterance is shorter than calibrationMs + minSpeechMs. It is caught
  // only because the first capture's ambient floor is reused immediately.
  const secondPath = `/tmp/cicero-vad-immediate-${process.pid}.wav`;
  const second = rec.capture(secondPath);
  hub.push(pcmLevelFrames(480, [0.2, 0.2, 0.2, 0.2, 0.2, 0.005, 0.005, 0.005, 0.005]));
  expect((await second).status).toBe("ok");
  try { (await import("fs")).unlinkSync(secondPath); } catch { /* best effort */ }
});

test("VadRecorder returns an error instead of hanging when the AEC stream dies", async () => {
  const hub = new FakeHub();
  const rec = new VadRecorder({ micHub: hub as unknown as AecAudioHub, onsetTimeoutMs: 30_000 });
  const capture = rec.capture(`/tmp/cicero-vad-dead-hub-${process.pid}.wav`);
  hub.end();
  expect(await capture).toEqual({ status: "error", message: "AEC microphone stream ended" });
});

test("VadRecorder onset timeout is a wall deadline even when no frame ever arrives", async () => {
  const hub = new FakeHub();
  const rec = new VadRecorder({
    micHub: hub as unknown as AecAudioHub,
    onsetTimeoutMs: 20,
    maxDurationMs: 200,
  });
  const startedAt = performance.now();

  const result = await rec.capture(`/tmp/cicero-vad-stalled-hub-${process.pid}.wav`);

  expect(result).toEqual({ status: "silent" });
  expect(performance.now() - startedAt).toBeLessThan(250);
  expect(hub.sink).toBeNull();
});

test("VadRecorder stop settles the old hub capture before a replacement can claim its sink", async () => {
  const hub = new FakeHub();
  const rec = new VadRecorder({
    micHub: hub as unknown as AecAudioHub,
    onsetTimeoutMs: 5_000,
    maxDurationMs: 5_000,
  });
  const first = rec.capture(`/tmp/cicero-vad-old-hub-${process.pid}.wav`);
  let second: Promise<Awaited<ReturnType<VadRecorder["capture"]>>> | null = null;

  try {
    await rec.stop();
    second = rec.capture(`/tmp/cicero-vad-new-hub-${process.pid}.wav`);
    await Bun.sleep(0);
    expect(hub.sink).not.toBeNull();
  } finally {
    await rec.stop();
  }

  expect(await first).toEqual({ status: "cancelled" });
  expect(await second!).toEqual({ status: "cancelled" });
});

test("VadRecorder does not spawn a raw mic until stopped AEC cleanup is confirmed", async () => {
  try {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let spawns = 0;
    const hub = {
      isRunning: () => false,
      waitForRelease: () => released,
      setMicSink() {},
    } as unknown as AecAudioHub;
    const rec = new VadRecorder({
      micHub: hub,
      which: () => "/usr/bin/rec",
      spawnHelper: (() => {
        spawns++;
        return {
          pid: 8761,
          stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
          stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
          exited: Promise.resolve(0),
          exitCode: 0,
          kill() {},
        } as never;
      }) as typeof Bun.spawn,
    });

    const capture = rec.capture(`/tmp/cicero-vad-aec-release-${process.pid}.wav`);
    await Bun.sleep(0);
    expect(spawns).toBe(0);
    release();

    expect(await capture).toEqual({ status: "silent" });
    expect(spawns).toBe(1);
  } catch (error: unknown) {
    throw error;
  }
});

test("VadRecorder keeps raw capture disarmed when AEC release is unconfirmed", async () => {
  try {
    let spawns = 0;
    const hub = {
      isRunning: () => false,
      waitForRelease: () => Promise.reject(new Error("old AEC helper is unreaped")),
      setMicSink() {},
    } as unknown as AecAudioHub;
    const rec = new VadRecorder({
      micHub: hub,
      which: () => "/usr/bin/rec",
      spawnHelper: (() => { spawns++; throw new Error("must not spawn"); }) as typeof Bun.spawn,
    });

    expect(await rec.capture(`/tmp/cicero-vad-aec-blocked-${process.pid}.wav`)).toEqual({
      status: "error",
      message: "old AEC helper is unreaped",
    });
    expect(spawns).toBe(0);
  } catch (error: unknown) {
    throw error;
  }
});
