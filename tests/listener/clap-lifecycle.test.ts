import { expect, test } from "bun:test";
import { ClapListener } from "../../src/listener/clap-listener";

function fakeRecorder(options: { finishOnKill?: boolean } = {}) {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (code: number) => void;
  let finished = false;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) { stdoutController = controller; },
  });
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const finish = (code = 0): void => {
    if (finished) return;
    finished = true;
    try { stdoutController.close(); } catch { /* already closed */ }
    resolveExit(code);
  };
  return {
    proc: {
      pid: 5678,
      stdout,
      exited,
      kill(signal?: NodeJS.Signals | number) {
        signals.push(signal);
        if (options.finishOnKill !== false) finish();
      },
    } as never,
    closeOutput() {
      try { stdoutController.close(); } catch { /* already closed */ }
    },
    finish,
    signals,
  };
}

test("ClapListener clears stale running state and can restart after recorder EOF", async () => {
  const recorders = [fakeRecorder(), fakeRecorder()];
  let spawns = 0;
  const listener = new ClapListener({
    onDoubleClap: () => {},
    platform: "linux",
    which: () => "/fixture/rec",
    spawnHelper: (() => recorders[spawns++]!.proc) as typeof Bun.spawn,
  });

  await listener.start();
  recorders[0]!.finish(9);
  await Bun.sleep(0);
  await listener.start();
  expect(spawns).toBe(2);
  await listener.stop();
});

test("ClapListener stop does not resolve until the exact recorder is reaped", async () => {
  const recorder = fakeRecorder({ finishOnKill: false });
  const listener = new ClapListener({
    onDoubleClap: () => {},
    platform: "linux",
    which: () => "/fixture/rec",
    spawnHelper: (() => recorder.proc) as typeof Bun.spawn,
  });
  await listener.start();

  let stopped = false;
  const stopping = listener.stop().finally(() => { stopped = true; });
  await Bun.sleep(0);
  expect(stopped).toBe(false);
  expect(recorder.signals).toEqual(["SIGTERM"]);
  recorder.finish();
  await stopping;
  expect(stopped).toBe(true);
});

test("ClapListener does not replace a child whose reap could not be confirmed", async () => {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) { stdoutController = controller; },
  });
  const exited = Promise.reject<number>(new Error("fixture exit observation failed"));
  void exited.catch(() => { /* listener cleanup observes this rejection */ });
  let spawns = 0;
  let closed = false;
  const proc = {
    pid: 5679,
    stdout,
    exited,
    kill() {
      if (!closed) {
        closed = true;
        stdoutController.close();
      }
    },
  } as never;
  const listener = new ClapListener({
    onDoubleClap: () => {},
    platform: "linux",
    which: () => "/fixture/rec",
    spawnHelper: (() => { spawns++; return proc; }) as typeof Bun.spawn,
  });

  await listener.start();
  await expect(listener.stop()).rejects.toThrow("exit observation failed");
  await listener.start();

  expect(spawns).toBe(1);
});

test("a later ClapListener stop prevents a start waiting on stale cleanup from rearming", async () => {
  const old = fakeRecorder({ finishOnKill: false });
  const replacement = fakeRecorder();
  const recorders = [old, replacement];
  let spawns = 0;
  const listener = new ClapListener({
    onDoubleClap: () => {},
    platform: "linux",
    which: () => "/fixture/rec",
    spawnHelper: (() => recorders[spawns++]!.proc) as typeof Bun.spawn,
  });
  const state = listener as unknown as { running: boolean };

  await listener.start();
  old.closeOutput();
  await Bun.sleep(0);
  const restarting = listener.start();
  let stopSettled = false;
  const stopping = listener.stop().finally(() => { stopSettled = true; });
  old.finish();

  try {
    await Bun.sleep(5);
    expect(spawns).toBe(1);
    expect(state.running).toBe(false);
    expect(stopSettled).toBe(true);
  } finally {
    await listener.stop();
    await Promise.allSettled([restarting, stopping]);
  }
});
