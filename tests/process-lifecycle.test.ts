import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import {
  runUntilShutdown,
  StartupCancelledByShutdownError,
  waitForShutdown,
} from "../src/process-lifecycle";

describe("waitForShutdown", () => {
  test("stops exactly once and removes both signal handlers", async () => {
    const signals = new EventEmitter();
    let stops = 0;
    const waiting = waitForShutdown({
      stop: async () => {
        try {
          stops += 1;
        } catch (error) {
          throw new Error(`stop failed: ${(error as Error).message}`, { cause: error });
        }
      },
    }, signals);

    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await waiting;

    expect(stops).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  test("rejects when cleanup fails", async () => {
    const signals = new EventEmitter();
    const waiting = waitForShutdown({ stop: async () => { throw new Error("cleanup failed"); } }, signals);
    signals.emit("SIGINT");
    await expect(waiting).rejects.toThrow("cleanup failed");
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  test("a cancelled wait removes handlers without stopping the target", async () => {
    const signals = new EventEmitter();
    const cancel = new AbortController();
    let stops = 0;
    const waiting = waitForShutdown({
      stop: () => { stops += 1; return Promise.resolve(); },
    }, signals, cancel.signal);

    cancel.abort();
    await waiting;

    expect(stops).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  test("a signal-cancelled startup waits for cleanup and resolves as a clean CLI exit", async () => {
    const signals = new EventEmitter();
    let rejectStart: (error: Error) => void = () => {};
    const starting = new Promise<void>((_resolve, reject) => { rejectStart = reject; });
    let releaseStop: () => void = () => {};
    const stopping = new Promise<void>((resolve) => { releaseStop = resolve; });
    let stops = 0;
    let settled = false;
    const running = runUntilShutdown({
      start: () => starting,
      stop: () => {
        stops += 1;
        rejectStart(new StartupCancelledByShutdownError());
        return stopping;
      },
    }, signals).then(
      () => { settled = true; },
      (error: unknown) => { throw error; },
    );

    try {
      signals.emit("SIGINT");
      await Promise.resolve();
      expect(stops).toBe(1);
      expect(settled).toBe(false);

      releaseStop();
      await running;

      expect(settled).toBe(true);
      expect(signals.listenerCount("SIGINT")).toBe(0);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    } catch (error) {
      releaseStop();
      throw new Error(`clean startup-cancellation test failed: ${(error as Error).message}`, { cause: error });
    }
  });

  test("a real startup failure remains fatal and removes signal handlers", async () => {
    const signals = new EventEmitter();
    const running = runUntilShutdown({
      start: () => Promise.reject(new Error("model load failed")),
      stop: () => Promise.resolve(),
    }, signals);

    try {
      await expect(running).rejects.toThrow("model load failed");
      expect(signals.listenerCount("SIGINT")).toBe(0);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    } catch (error) {
      throw new Error(`fatal startup test failed: ${(error as Error).message}`, { cause: error });
    }
  });
});
