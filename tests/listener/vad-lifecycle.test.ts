import { expect, test } from "bun:test";
import { VadRecorder } from "../../src/listener/vad-recorder";

function fakeRecorder(options: { finishOnKill?: boolean } = {}) {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (code: number) => void;
  let finished = false;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) { stdoutController = controller; },
  });
  const stderr = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const finish = (code = 0): void => {
    if (finished) return;
    finished = true;
    try { stdoutController.close(); } catch { /* already cancelled */ }
    resolveExit(code);
  };
  return {
    proc: {
      pid: 6789,
      stdout,
      stderr,
      exited,
      exitCode: null,
      kill(signal?: NodeJS.Signals | number) {
        signals.push(signal);
        if (options.finishOnKill !== false) finish();
      },
    } as never,
    finish,
    signals,
  };
}

test("platform VAD enforces onset wall time and reaps a silent recorder", async () => {
  const recorder = fakeRecorder();
  const vad = new VadRecorder({
    platform: "linux",
    which: () => "/fixture/rec",
    spawnHelper: (() => recorder.proc) as typeof Bun.spawn,
    onsetTimeoutMs: 20,
    maxDurationMs: 200,
  });
  const startedAt = performance.now();

  const result = await vad.capture(`/tmp/cicero-vad-stalled-recorder-${process.pid}.wav`);

  expect(result).toEqual({ status: "silent" });
  expect(performance.now() - startedAt).toBeLessThan(250);
  expect(recorder.signals).toEqual(["SIGTERM"]);
});

test("VadRecorder stop waits until its exact platform child is reaped", async () => {
  const recorder = fakeRecorder({ finishOnKill: false });
  const vad = new VadRecorder({
    platform: "linux",
    which: () => "/fixture/rec",
    spawnHelper: (() => recorder.proc) as typeof Bun.spawn,
    onsetTimeoutMs: 5_000,
    maxDurationMs: 5_000,
  });
  const capture = vad.capture(`/tmp/cicero-vad-stop-recorder-${process.pid}.wav`);
  await Bun.sleep(0);

  let stopped = false;
  const stopping = vad.stop().finally(() => { stopped = true; });
  await Bun.sleep(0);
  expect(stopped).toBe(false);
  expect(recorder.signals).toEqual(["SIGTERM"]);
  recorder.finish();
  await stopping;
  expect(stopped).toBe(true);
  expect((await capture).status).toBe("cancelled");
});

test("VadRecorder retains an unreaped child and refuses a competing capture", async () => {
  const exited = Promise.reject<number>(new Error("fixture exit observation failed"));
  void exited.catch(() => { /* recorder cleanup observes this rejection */ });
  let spawns = 0;
  const proc = {
    pid: 6790,
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    exited,
    exitCode: null,
    kill() {},
  } as never;
  const vad = new VadRecorder({
    platform: "linux",
    which: () => "/fixture/rec",
    spawnHelper: (() => { spawns++; return proc; }) as typeof Bun.spawn,
    onsetTimeoutMs: 5,
    maxDurationMs: 20,
  });

  const first = await vad.capture(`/tmp/cicero-vad-unreaped-${process.pid}.wav`);
  const second = await vad.capture(`/tmp/cicero-vad-unreaped-second-${process.pid}.wav`);

  expect(first.status).toBe("error");
  expect(second).toEqual({ status: "error", message: "previous recorder has not been reaped" });
  expect(spawns).toBe(1);
  await expect(vad.stop()).rejects.toThrow("exit observation failed");
});
