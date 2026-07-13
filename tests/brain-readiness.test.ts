import { describe, expect, test } from "bun:test";
import { waitForBrainReadiness } from "../src/brain/readiness";
import { StartupCancelledByShutdownError } from "../src/process-lifecycle";

describe("brain startup readiness", () => {
  test("absorbs transient false/error results and succeeds on a later attempt without real sleeps", async () => {
    const outcomes: Array<boolean | Error> = [false, new Error("service warming"), true];
    const delays: number[] = [];
    let calls = 0;
    const result = await waitForBrainReadiness(
      {
        health: () => {
          const outcome = outcomes[calls++];
          return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome ?? false);
        },
      },
      new AbortController().signal,
      {
        maxAttempts: 3,
        timeoutMs: 1_000,
        retryDelayMs: 75,
        sleep: (delayMs) => {
          delays.push(delayMs);
          return Promise.resolve();
        },
      },
    );

    expect(result).toMatchObject({ healthy: true, attempts: 3, timedOut: false });
    expect(calls).toBe(3);
    expect(delays).toEqual([75, 75]);
  });

  test("fails closed after the configured number of attempts without sleeping", async () => {
    let calls = 0;
    const result = await waitForBrainReadiness(
      { health: () => { calls += 1; return Promise.resolve(false); } },
      new AbortController().signal,
      { maxAttempts: 3, timeoutMs: 1_000, retryDelayMs: 0 },
    );

    expect(result).toEqual({
      healthy: false,
      attempts: 3,
      timedOut: false,
      timeoutMs: 1_000,
      lastError: undefined,
    });
    expect(calls).toBe(3);
  });

  test("an unresponsive health implementation cannot exceed the absolute budget", async () => {
    const started = performance.now();
    const result = await waitForBrainReadiness(
      { health: () => new Promise(() => {}) },
      new AbortController().signal,
      { maxAttempts: 3, timeoutMs: 20, retryDelayMs: 0 },
    );

    expect(performance.now() - started).toBeLessThan(500);
    expect(result).toMatchObject({ healthy: false, attempts: 1, timedOut: true, timeoutMs: 20 });
  });

  test("shutdown aborts an injected retry delay", async () => {
    const controller = new AbortController();
    let signalDelayStarted!: () => void;
    const delayStarted = new Promise<void>((resolve) => { signalDelayStarted = resolve; });
    const checking = waitForBrainReadiness(
      { health: () => Promise.resolve(false) },
      controller.signal,
      {
        maxAttempts: 3,
        timeoutMs: 1_000,
        retryDelayMs: 100,
        sleep: (_delayMs, signal) => new Promise<void>((resolve) => {
          signalDelayStarted();
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      },
    );

    await delayStarted;
    controller.abort();
    await expect(checking).rejects.toBeInstanceOf(StartupCancelledByShutdownError);
  });
});
