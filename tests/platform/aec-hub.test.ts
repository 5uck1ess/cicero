import { test, expect } from "bun:test";
import {
  AecAudioHub,
  AecReleaseUnconfirmedError,
  resampleTo16k,
  floatToS16LE,
  pcm16kFromWav,
  aecAvailable,
} from "../../src/platform/aec-hub";
import { encodeWav } from "../../src/platform/wav";

test("resampleTo16k is identity when already 16 kHz", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const out = resampleTo16k(samples, 16000);
  expect(out).toBe(samples); // same reference — no work done
});

test("resampleTo16k downsamples 48 kHz to one third the length", () => {
  const samples = new Float32Array(48000).fill(0.25);
  const out = resampleTo16k(samples, 48000);
  expect(out.length).toBe(16000);
  // Constant signal stays constant through linear interpolation.
  expect(out[0]).toBeCloseTo(0.25, 5);
  expect(out[8000]).toBeCloseTo(0.25, 5);
});

test("resampleTo16k preserves the first sample at the boundary", () => {
  const samples = new Float32Array([1, 0, 0, 0, 0, 0]); // 6 samples @ 48k
  const out = resampleTo16k(samples, 48000);
  expect(out.length).toBe(2);
  expect(out[0]).toBeCloseTo(1, 5); // pos 0 → sample 0 exactly
});

test("resampleTo16k handles empty input", () => {
  const out = resampleTo16k(new Float32Array(0), 48000);
  expect(out.length).toBe(0);
});

test("resampleTo16k rejects metadata-driven expansion from absurd rates", () => {
  expect(() => resampleTo16k(new Float32Array([0]), 1)).toThrow(/sample rate/);
  expect(() => resampleTo16k(new Float32Array([0]), 192000)).toThrow(/sample rate/);
  expect(() => resampleTo16k(new Float32Array([0]), Number.NaN)).toThrow(/sample rate/);
});

test("floatToS16LE converts and clamps to signed 16-bit little-endian", () => {
  const out = floatToS16LE(new Float32Array([0, 1, -1, 2, -2]));
  expect(out.length).toBe(10); // 5 samples × 2 bytes
  const dv = new DataView(out.buffer);
  expect(dv.getInt16(0, true)).toBe(0);
  expect(dv.getInt16(2, true)).toBe(32767);  // +1.0 → max
  expect(dv.getInt16(4, true)).toBe(-32767); // -1.0 → round(-32767)
  expect(dv.getInt16(6, true)).toBe(32767);  // +2.0 clamped to +1.0
  expect(dv.getInt16(8, true)).toBe(-32767); // -2.0 clamped to -1.0
});

test("pcm16kFromWav decodes and resamples a 48 kHz WAV to 16 kHz s16le bytes", () => {
  const samples = new Int16Array(4800).fill(8192); // 100ms @ 48k, constant tone
  const wav = encodeWav(samples, 48000).buffer as ArrayBuffer;
  const pcm = pcm16kFromWav(wav);
  expect(pcm.length).toBe(1600 * 2); // 100ms @ 16k mono s16le
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  expect(dv.getInt16(0, true)).toBeCloseTo(8192, -2); // amplitude survives the round-trip
});

test("aecAvailable is false when the helper binary is missing", () => {
  // Requires both macOS and a built helper; a non-existent path is never available
  // on any platform, and the check never throws.
  const result = aecAvailable("/definitely/not/a/real/path");
  expect(result).toBe(false);
});

function fakeHelperProcess(options: {
  flush?: () => number | Promise<number>;
  finishOnKill?: boolean;
} = {}) {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (code: number) => void;
  let ended = false;
  let killed = false;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { stdoutController = controller; } });
  const stderr = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  const finish = (code = 0) => {
    if (ended) return;
    ended = true;
    try { stdoutController.close(); } catch { /* already closed */ }
    resolveExit(code);
  };
  const proc = {
    pid: 4321,
    stdout,
    stderr,
    stdin: {
      write(bytes: Uint8Array) { return bytes.byteLength; },
      flush: options.flush ?? (() => 0),
    },
    exited,
    exitCode: null,
    kill(signal?: NodeJS.Signals | number) {
      signals.push(signal);
      killed = true;
      if (options.finishOnKill !== false) finish(0);
    },
  };
  return {
    proc: proc as never,
    push: (bytes: Uint8Array) => stdoutController.enqueue(bytes),
    finish,
    wasKilled: () => killed,
    signals,
  };
}

test("AEC startup timeout clears running state and kills the stale helper", async () => {
  const helper = fakeHelperProcess();
  const hub = new AecAudioHub(import.meta.path, 5, (() => helper.proc) as typeof Bun.spawn);

  await expect(hub.start()).rejects.toThrow("produced no microphone audio");
  expect(hub.isRunning()).toBe(false);
  expect(helper.wasKilled()).toBe(true);
  let ended = 0;
  hub.setMicSink(() => {}, () => { ended++; });
  expect(ended).toBe(1); // a late consumer cannot hang on the stopped helper
});

test("AEC cleanup failure remains a restart barrier instead of replacing the helper", async () => {
  const exited = Promise.reject<number>(new Error("fixture exit observation failed"));
  void exited.catch(() => { /* hub cleanup observes this rejection */ });
  const proc = {
    pid: 4322,
    exited,
    exitCode: null,
    signalCode: null,
    kill() {},
  } as never;
  let spawns = 0;
  const hub = new AecAudioHub(import.meta.path, 100, (() => { spawns++; return proc; }) as typeof Bun.spawn);
  const state = hub as unknown as {
    proc: ReturnType<typeof Bun.spawn> | null;
    state: "stopped" | "starting" | "running";
    failProcess(proc: ReturnType<typeof Bun.spawn>, error: Error): Promise<void>;
  };
  state.proc = proc;
  state.state = "running";

  await expect(state.failProcess(proc, new Error("fixture failure"))).rejects.toThrow("exit observation failed");
  expect(hub.isRunning()).toBe(false);
  await expect(hub.waitForRelease()).rejects.toBeInstanceOf(AecReleaseUnconfirmedError);
  await expect(hub.start()).rejects.toThrow("exit observation failed");
  expect(spawns).toBe(0);
});

test("concurrent AEC starts released by one cleanup spawn one replacement", async () => {
  const old = fakeHelperProcess({ finishOnKill: false });
  const replacements = [fakeHelperProcess(), fakeHelperProcess()];
  let spawns = 0;
  const hub = new AecAudioHub(
    import.meta.path,
    100,
    (() => {
      const helper = replacements[spawns++]!;
      queueMicrotask(() => helper.push(new Uint8Array([0, 0])));
      return helper.proc;
    }) as typeof Bun.spawn,
  );
  const state = hub as unknown as {
    proc: ReturnType<typeof Bun.spawn> | null;
    state: "stopped" | "starting" | "running";
    failProcess(proc: ReturnType<typeof Bun.spawn>, error: Error): Promise<void>;
  };
  state.proc = old.proc;
  state.state = "running";
  const cleanup = state.failProcess(old.proc, new Error("old helper"));

  const starts = Array.from({ length: 8 }, () => hub.start());
  old.finish();
  await Promise.all([cleanup, ...starts]);

  expect(spawns).toBe(1);
  expect(hub.isRunning()).toBe(true);
  await hub.stop();
});

test("a later AEC stop prevents a start waiting on cleanup from resurrecting the helper", async () => {
  const old = fakeHelperProcess({ finishOnKill: false });
  const replacement = fakeHelperProcess();
  let spawns = 0;
  const hub = new AecAudioHub(
    import.meta.path,
    100,
    (() => {
      spawns++;
      queueMicrotask(() => replacement.push(new Uint8Array([0, 0])));
      return replacement.proc;
    }) as typeof Bun.spawn,
  );
  const state = hub as unknown as {
    proc: ReturnType<typeof Bun.spawn> | null;
    state: "stopped" | "starting" | "running";
    failProcess(proc: ReturnType<typeof Bun.spawn>, error: Error): Promise<void>;
  };
  state.proc = old.proc;
  state.state = "running";
  const cleanup = state.failProcess(old.proc, new Error("old helper"));
  const starting = hub.start();
  const stopping = hub.stop();
  old.finish();

  try {
    await Bun.sleep(5);
    expect(spawns).toBe(0);
    expect(hub.isRunning()).toBe(false);
  } finally {
    replacement.finish();
    await Promise.allSettled([cleanup, starting, stopping]);
  }
});

test("AEC stream exit clears running state and wakes the active mic consumer", async () => {
  const helper = fakeHelperProcess();
  const hub = new AecAudioHub(import.meta.path, 100, (() => helper.proc) as typeof Bun.spawn);
  const started = hub.start();
  helper.push(new Uint8Array([0, 0]));
  await started;
  expect(hub.isRunning()).toBe(true);

  let ended = 0;
  hub.setMicSink(() => {}, () => { ended++; });
  helper.finish(9);
  await Bun.sleep(0);

  expect(hub.isRunning()).toBe(false);
  expect(ended).toBe(1);
});

test("AEC playback awaits pipe backpressure instead of fire-and-forget flushing", async () => {
  let releaseFlush!: () => void;
  const flush = new Promise<number>((resolve) => { releaseFlush = () => resolve(0); });
  const helper = fakeHelperProcess({ flush: () => flush });
  const hub = new AecAudioHub(import.meta.path, 100, (() => helper.proc) as typeof Bun.spawn);
  const started = hub.start();
  helper.push(new Uint8Array([0, 0]));
  await started;

  let settled = false;
  const playback = hub.play(new Uint8Array([1, 2, 3, 4])).finally(() => { settled = true; });
  await Bun.sleep(0);
  expect(settled).toBe(false);
  releaseFlush();
  await playback;
  expect(settled).toBe(true);
  await hub.stop();
});

test("AEC playback deadline stops and reaps a helper whose pipe stalls", async () => {
  const helper = fakeHelperProcess({ flush: () => new Promise<number>(() => {}) });
  const hub = new AecAudioHub(
    import.meta.path,
    100,
    (() => helper.proc) as typeof Bun.spawn,
    { playbackWriteTimeoutMs: 10 },
  );
  const started = hub.start();
  helper.push(new Uint8Array([0, 0]));
  await started;

  await expect(hub.play(new Uint8Array([1, 2]))).rejects.toThrow("exceeded 10ms");
  expect(hub.isRunning()).toBe(false);
  expect(helper.wasKilled()).toBe(true);
  expect(helper.signals).toContain("SIGTERM");
});

test("AEC playback rejects excess pending bytes before copying another chunk", async () => {
  let releaseFlush!: () => void;
  const flush = new Promise<number>((resolve) => { releaseFlush = () => resolve(0); });
  const helper = fakeHelperProcess({ flush: () => flush });
  const hub = new AecAudioHub(
    import.meta.path,
    100,
    (() => helper.proc) as typeof Bun.spawn,
    { maxPendingPlaybackBytes: 4 },
  );
  const started = hub.start();
  helper.push(new Uint8Array([0, 0]));
  await started;

  const first = hub.play(new Uint8Array([1, 2, 3, 4]));
  await expect(hub.play(new Uint8Array([5]))).rejects.toThrow("backlog exceeds 4 bytes");
  releaseFlush();
  await first;
  await hub.stop();
});

test("AEC playback rejects when the helper stopped between streamed chunks", async () => {
  const hub = new AecAudioHub(import.meta.path);
  await expect(hub.play(new Uint8Array([1, 2]))).rejects.toThrow("not running");
});
