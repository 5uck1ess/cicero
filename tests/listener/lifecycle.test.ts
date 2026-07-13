import { afterEach, expect, jest, test } from "bun:test";
import { ConversationalListener } from "../../src/listener/conversational";
import type { TurnDetector } from "../../src/backends/turn/provider";
import { encodeWav } from "../../src/platform/wav";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

afterEach(() => {
  jest.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function parkedRecorder(onRecord: () => void) {
  return {
    record() {
      onRecord();
      const exit = deferred<number>();
      const proc = {
        exited: exit.promise,
        exitCode: null,
        stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
        kill() { exit.resolve(0); },
      };
      return proc as never;
    },
  };
}

test("a stale activation cannot reopen the mic after deactivate/reactivate", async () => {
  const firstHealth = deferred<boolean>();
  let healthCalls = 0;
  const detector: TurnDetector = {
    name: "deferred",
    health: async () => (++healthCalls === 1 ? firstHealth.promise : true),
    predict: async () => ({ complete: true, probability: 1 }),
  };
  let recordings = 0;
  const listener = new ConversationalListener(
    { transcribe: async () => "" } as never,
    parkedRecorder(() => { recordings++; }) as never,
    { play: async () => {} } as never,
    false,
    "1",
    "3%",
    { detector, threshold: 0.6, graceAttempts: 1, graceMaxDuration: 1 },
    undefined,
    false,
  );

  listener.activate();
  listener.deactivate();
  listener.activate();
  firstHealth.resolve(true);
  await Bun.sleep(10);

  // Only the current epoch reaches capture; the first health check completing
  // late cannot start a second recorder.
  expect(recordings).toBe(1);
  listener.deactivate();
  await listener.stop();
});

test("a killed capture from an old epoch cannot deactivate the new activation", async () => {
  const first = deferred<{ status: "error"; message: string }>();
  const second = deferred<{ status: "cancelled" }>();
  let captures = 0;
  let deactivations = 0;
  const listener = new ConversationalListener(
    { transcribe: async () => "" } as never,
    {} as never,
    { play: async () => {} } as never,
    false,
    "1",
    "3%",
    undefined,
    undefined,
    false,
  ) as ConversationalListener & {
    recordUntilSilence(): Promise<unknown>;
  };
  listener.recordUntilSilence = () => {
    captures++;
    return (captures === 1 ? first.promise : second.promise) as never;
  };
  listener.onDeactivate(() => { deactivations++; });

  listener.activate();
  await Bun.sleep(0);
  expect(captures).toBe(1);
  listener.deactivate();
  listener.activate();

  // The killed old recorder reports an error after `active` became true again.
  // Its epoch must be rejected before the error path can deactivate the new loop.
  first.resolve({ status: "error", message: "killed recorder" });
  for (let i = 0; i < 20 && captures < 2; i++) await Bun.sleep(1);
  expect(listener.isActive()).toBe(true);
  expect(deactivations).toBe(1);
  expect(captures).toBe(2);

  listener.deactivate();
  second.resolve({ status: "cancelled" });
  await listener.stop();
});

test("legacy capture retains an unreaped child and blocks a replacement recorder", async () => {
  const exited = Promise.reject<number>(new Error("fixture exit observation failed"));
  void exited.catch(() => { /* terminateRecording observes this rejection */ });
  let recordings = 0;
  const proc = {
    pid: 2468,
    exited,
    exitCode: null,
    signalCode: null,
    kill() {},
  } as never;
  const listener = new ConversationalListener(
    {} as never,
    { record() { recordings++; return proc; } } as never,
    { play: async () => {} } as never,
    false,
    "1",
    "3%",
    undefined,
    undefined,
    false,
  ) as ConversationalListener & {
    currentRecording: ReturnType<typeof Bun.spawn> | null;
    terminateRecording(proc: ReturnType<typeof Bun.spawn>): Promise<void>;
    recordUntilSilence(): Promise<{ status: string; message?: string }>;
  };
  listener.currentRecording = proc;

  await expect(listener.terminateRecording(proc)).rejects.toThrow("exit observation failed");
  expect(listener.currentRecording).toBe(proc);
  expect(await listener.recordUntilSilence()).toEqual({
    status: "error",
    message: "previous recorder has not been reaped",
  });
  expect(recordings).toBe(0);
});

test("legacy recorder polling observes one exit promise without accumulating handlers", async () => {
  let resolveExit!: (code: number) => void;
  const pendingExit = new Promise<number>((resolve) => { resolveExit = resolve; });
  let handlers = 0;
  const exited = {
    then(onFulfilled?: (code: number) => unknown, onRejected?: (error: unknown) => unknown) {
      handlers++;
      return pendingExit.then(onFulfilled, onRejected);
    },
  } as Promise<number>;
  const listener = new ConversationalListener(
    {} as never,
    {} as never,
    { play: () => Promise.resolve() } as never,
    false,
    "1",
    "3%",
    undefined,
    undefined,
    false,
  ) as ConversationalListener & {
    waitForRecordingExit(proc: ReturnType<typeof Bun.spawn>): Promise<number>;
  };
  const proc = { pid: 2469, exited, kill() {} } as never;
  const waiting = listener.waitForRecordingExit(proc);

  await Bun.sleep(450);
  expect(handlers).toBe(1);
  resolveExit(0);
  expect(await waiting).toBe(0);
});

async function expectLegacyCaptureWallCap(bytes: number): Promise<void> {
  jest.useFakeTimers();
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  let audioPath = "";
  const proc = {
    pid: 2470,
    exited,
    exitCode: null,
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    kill(signal?: NodeJS.Signals | number) {
      signals.push(signal);
      resolveExit(0);
    },
  } as never;
  const listener = new ConversationalListener(
    {} as never,
    {
      record(path: string) {
        audioPath = path;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, new Uint8Array(bytes));
        return proc;
      },
    } as never,
    { play: () => Promise.resolve() } as never,
    false,
    "1",
    "3%",
    undefined,
    undefined,
    false,
  ) as ConversationalListener & {
    active: boolean;
    recordUntilSilence(): Promise<{ status: string; path?: string }>;
  };
  listener.active = true;

  try {
    const capture = listener.recordUntilSilence();
    jest.advanceTimersByTime(200);
    await Promise.resolve();
    jest.advanceTimersByTime(31_000);
    await Promise.resolve();

    expect(await capture).toEqual(bytes >= 1_024
      ? { status: "ok", path: audioPath }
      : { status: "silent" });
    expect(signals).toEqual(["SIGTERM"]);
  } catch (error: unknown) {
    throw error;
  } finally {
    if (audioPath) {
      try { unlinkSync(audioPath); } catch { /* test cleanup */ }
    }
  }
}

for (const bytes of [0, 512, 2_048]) {
  test(`legacy capture enforces its absolute wall cap with ${bytes} output bytes`, () => (
    expectLegacyCaptureWallCap(bytes)
  ));
}

async function expectLegacyBargeWallCap(bytes: number): Promise<void> {
  jest.useFakeTimers();
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  let audioPath = "";
  const proc = {
    pid: 2471,
    exited,
    exitCode: null,
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    kill(signal?: NodeJS.Signals | number) {
      signals.push(signal);
      resolveExit(0);
    },
  } as never;
  const listener = new ConversationalListener(
    {} as never,
    {
      record(path: string) {
        audioPath = path;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, new Uint8Array(bytes));
        return proc;
      },
    } as never,
    { play: () => Promise.resolve() } as never,
    false,
    "1",
    "3%",
    undefined,
    undefined,
    false,
  ) as ConversationalListener & {
    active: boolean;
    captureBargeIn(): Promise<string | null>;
  };
  listener.active = true;

  try {
    const capture = listener.captureBargeIn();
    jest.advanceTimersByTime(11_000);
    await Promise.resolve();

    expect(await capture).toBeNull();
    expect(signals).toEqual(["SIGTERM"]);
  } catch (error: unknown) {
    throw error;
  } finally {
    if (audioPath) {
      try { unlinkSync(audioPath); } catch { /* test cleanup */ }
    }
  }
}

for (const bytes of [0, 512]) {
  test(`legacy barge capture enforces its absolute wall cap with ${bytes} output bytes`, () => (
    expectLegacyBargeWallCap(bytes)
  ));
}

async function expectDeactivationWaitsForLegacyReap(): Promise<void> {
  const exit = deferred<number>();
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const proc = {
    pid: 2472,
    exited: exit.promise,
    exitCode: null,
    kill(signal?: NodeJS.Signals | number) { signals.push(signal); },
  } as never;
  const listener = new ConversationalListener(
    {} as never,
    {} as never,
    { play: () => Promise.resolve() } as never,
    false,
    "1",
    "3%",
    undefined,
    undefined,
    false,
  ) as ConversationalListener & {
    active: boolean;
    currentRecording: ReturnType<typeof Bun.spawn> | null;
  };
  listener.active = true;
  listener.currentRecording = proc;

  try {
    listener.deactivate();
    let settled = false;
    const release = listener.waitForCaptureRelease().finally(() => { settled = true; });
    await Bun.sleep(0);
    expect(signals).toEqual(["SIGTERM"]);
    expect(settled).toBe(false);

    exit.resolve(0);
    await release;
    expect(settled).toBe(true);
  } catch (error: unknown) {
    throw error;
  }
}

test("conversational deactivation exposes the exact legacy child reap barrier", () => (
  expectDeactivationWaitsForLegacyReap()
));

async function expectDeactivationWaitsForVadStop(): Promise<void> {
  const stop = deferred<void>();
  const listener = new ConversationalListener(
    {} as never,
    {} as never,
    { play: () => Promise.resolve() } as never,
    false,
    "1",
    "3%",
    undefined,
    undefined,
    false,
  ) as ConversationalListener & {
    active: boolean;
    vadRecorder: { stop(): Promise<void> };
  };
  listener.active = true;
  listener.vadRecorder = { stop: () => stop.promise };

  try {
    listener.deactivate();
    let settled = false;
    const release = listener.waitForCaptureRelease().finally(() => { settled = true; });
    await Bun.sleep(0);
    expect(settled).toBe(false);

    stop.resolve();
    await release;
    expect(settled).toBe(true);
  } catch (error: unknown) {
    throw error;
  }
}

test("conversational deactivation exposes the exact VAD stop barrier", () => (
  expectDeactivationWaitsForVadStop()
));

async function expectCaptureReleaseCanRetry(): Promise<void> {
  let stopCalls = 0;
  const listener = new ConversationalListener(
    {} as never,
    {} as never,
    { play: () => Promise.resolve() } as never,
    false,
    "1",
    "3%",
    undefined,
    undefined,
    false,
  ) as ConversationalListener & {
    active: boolean;
    vadRecorder: { stop(): Promise<void> };
  };
  listener.active = true;
  listener.vadRecorder = {
    stop: () => (++stopCalls === 1
      ? Promise.reject(new Error("first reap failed"))
      : Promise.resolve()),
  };

  try {
    listener.deactivate();
    await expect(listener.waitForCaptureRelease()).rejects.toThrow("first reap failed");
    await listener.releaseAudioCapture();

    expect(stopCalls).toBe(2);
    await expect(listener.waitForCaptureRelease()).resolves.toBeUndefined();
  } catch (error: unknown) {
    throw error;
  }
}

test("a fresh conversational release request can recover after a failed reap", () => (
  expectCaptureReleaseCanRetry()
));

test("barge loops await asynchronous VAD stop before releasing the microphone", async () => {
  const listener = new ConversationalListener(
    {} as never,
    {} as never,
    { play: () => Promise.resolve() } as never,
    false,
    "1",
    "3%",
    undefined,
    undefined,
    false,
  ) as ConversationalListener & {
    active: boolean;
    activationEpoch: number;
    vadRecorder: { stop(): Promise<void> };
    detectBargeIn(): Promise<string | null>;
    bargeInLoop(done: Promise<"done">, epoch: number): Promise<void>;
    runLegacyBargeInTurn(done: Promise<void>, epoch: number): Promise<void>;
  };
  listener.active = true;
  listener.activationEpoch = 1;
  listener.detectBargeIn = () => Promise.resolve(null);

  for (const mode of ["full", "legacy"] as const) {
    let releaseStop!: () => void;
    const stopped = new Promise<void>((resolve) => { releaseStop = resolve; });
    listener.vadRecorder = { stop: () => stopped };
    let settled = false;
    const loop = (mode === "full"
      ? listener.bargeInLoop(Promise.resolve("done"), 1)
      : listener.runLegacyBargeInTurn(Promise.resolve(), 1))
      .finally(() => { settled = true; });

    await Bun.sleep(0);
    expect(settled).toBe(false);
    releaseStop();
    await loop;
    expect(settled).toBe(true);
  }
});

test("turn-detector prediction errors disable it for the session", async () => {
  const detector: TurnDetector = {
    name: "broken",
    health: async () => true,
    predict: async () => { throw new Error("model crashed"); },
  };
  const listener = new ConversationalListener(
    { transcribe: async () => "" } as never,
    {} as never,
    { play: async () => {} } as never,
    false,
    "1",
    "3%",
    { detector, threshold: 0.6, graceAttempts: 1, graceMaxDuration: 1 },
    undefined,
    false,
  ) as ConversationalListener & {
    turnActive: boolean;
    predictTurn(path: string): Promise<unknown>;
  };
  const path = `/tmp/cicero-turn-failure-${process.pid}.wav`;
  await Bun.write(path, encodeWav(new Int16Array(1600), 16000));
  listener.turnActive = true;

  expect(await listener.predictTurn(path)).toBeNull();
  expect(listener.turnActive).toBe(false);
  try { (await import("fs")).unlinkSync(path); } catch { /* best effort */ }
});

test("turn-detector health exceptions fall back instead of aborting activation", async () => {
  const detector: TurnDetector = {
    name: "broken-health",
    health: async () => { throw new Error("connection refused"); },
    predict: async () => ({ complete: false, probability: 0 }),
  };
  const listener = new ConversationalListener(
    {} as never,
    {} as never,
    { play: async () => {} } as never,
    false,
    "1",
    "3%",
    { detector, threshold: 0.6, graceAttempts: 1, graceMaxDuration: 1 },
  ) as ConversationalListener & { turnActive: boolean; initTurnDetection(): Promise<void> };

  await listener.initTurnDetection();
  expect(listener.turnActive).toBe(false);
});

test("reactivation waits for an in-flight one-shot confirmation to release the mic", async () => {
  const release = deferred<string>();
  let loops = 0;
  const listener = new ConversationalListener(
    {} as never,
    {} as never,
    { play: async () => {} } as never,
    false,
    "1",
    "3%",
    undefined,
    undefined,
    false,
  ) as ConversationalListener & {
    runOneShotCapture(): Promise<string>;
    listenLoop(epoch: number): Promise<void>;
  };
  listener.runOneShotCapture = () => release.promise;
  listener.listenLoop = async () => { loops++; };

  const confirmation = listener.listenOnce();
  listener.activate();
  await Bun.sleep(0);
  expect(loops).toBe(0);

  release.resolve("yes");
  expect(await confirmation).toBe("yes");
  await Bun.sleep(0);
  expect(loops).toBe(1);
  listener.deactivate();
});

async function expectStaleOneShotCannotOpenMicAfterRelease(): Promise<void> {
  const preliminaryHandoff = deferred<string | null>();
  let recordings = 0;
  const listener = new ConversationalListener(
    {} as never,
    {} as never,
    { play: () => Promise.resolve() } as never,
    false,
    "1",
    "3%",
    undefined,
    undefined,
    false,
  ) as ConversationalListener & {
    active: boolean;
    activationEpoch: number;
    bargeCaptureInFlight: Promise<string | null> | null;
    recordUntilSilence(): Promise<{ status: "cancelled" }>;
  };
  listener.active = true;
  listener.activationEpoch = 1;
  listener.bargeCaptureInFlight = preliminaryHandoff.promise;
  listener.recordUntilSilence = () => {
    recordings++;
    return Promise.resolve({ status: "cancelled" });
  };

  try {
    const oneShot = listener.listenOnce();
    await Bun.sleep(0);
    listener.deactivate();
    // There is no open recorder yet, so the published release barrier can
    // legitimately settle before the preliminary one-shot handoff does.
    await listener.waitForCaptureRelease();
    preliminaryHandoff.resolve(null);

    expect(await oneShot).toBe("");
    expect(recordings).toBe(0);
  } catch (error: unknown) {
    throw error;
  }
}

test("a one-shot continuation cannot open the mic after deactivation released it", () => (
  expectStaleOneShotCannotOpenMicAfterRelease()
));

test("activation retries a slow microphone handoff before starting the listen loop", async () => {
  let releaseChecks = 0;
  let loops = 0;
  const listener = new ConversationalListener(
    {} as never,
    {} as never,
    { play: () => Promise.resolve() } as never,
    false,
    "1",
    "3%",
    undefined,
    undefined,
    false,
  ) as ConversationalListener & {
    waitForAudioRelease(captures: Array<Promise<unknown> | null>): Promise<boolean>;
    listenLoop(epoch: number): Promise<void>;
  };
  listener.waitForAudioRelease = () => Promise.resolve(++releaseChecks === 2);
  listener.listenLoop = () => {
    loops++;
    return Promise.resolve();
  };

  listener.activate();
  for (let i = 0; i < 20 && loops === 0; i++) await Bun.sleep(1);

  expect(releaseChecks).toBe(2);
  expect(loops).toBe(1);
  expect(listener.isActive()).toBe(true);
  listener.deactivate();
});

test("activation fails audibly after two stuck microphone release attempts", async () => {
  let releaseChecks = 0;
  let deactivations = 0;
  const sounds: string[] = [];
  const listener = new ConversationalListener(
    {} as never,
    {} as never,
    { play: (path: string) => {
      sounds.push(path);
      return Promise.resolve();
    } } as never,
  ) as ConversationalListener & {
    waitForAudioRelease(captures: Array<Promise<unknown> | null>): Promise<boolean>;
  };
  listener.waitForAudioRelease = () => {
    releaseChecks++;
    return Promise.resolve(false);
  };
  listener.onDeactivate(() => { deactivations++; });

  listener.activate();
  for (let i = 0; i < 20 && listener.isActive(); i++) await Bun.sleep(1);

  expect(releaseChecks).toBe(2);
  expect(listener.isActive()).toBe(false);
  expect(deactivations).toBe(1);
  expect(sounds.some((path) => path.endsWith("/error.wav"))).toBe(true);
});
