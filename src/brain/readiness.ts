import type { Brain } from "../types";
import { StartupCancelledByShutdownError } from "../process-lifecycle";

export const DEFAULT_BRAIN_READINESS_ATTEMPTS = 3;
export const DEFAULT_BRAIN_READINESS_TIMEOUT_MS = 10_000;
export const DEFAULT_BRAIN_READINESS_RETRY_DELAY_MS = 3_000;

export interface BrainReadinessOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  /** Injectable delay for deterministic tests and embedders. */
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface BrainReadinessResult {
  healthy: boolean;
  attempts: number;
  timedOut: boolean;
  timeoutMs: number;
  lastError?: unknown;
}

type BoundedOutcome<T> =
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" }
  | { kind: "aborted" };

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new StartupCancelledByShutdownError());
  return new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new StartupCancelledByShutdownError());
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function withinBudget<T>(
  operation: Promise<T>,
  remainingMs: number,
  signal: AbortSignal,
): Promise<BoundedOutcome<T>> {
  if (signal.aborted) return { kind: "aborted" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const observed = operation.then<BoundedOutcome<T>, BoundedOutcome<T>>(
    (value) => ({ kind: "value", value }),
    (error: unknown) => ({ kind: "error", error }),
  );
  try {
    const timeout = new Promise<BoundedOutcome<T>>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
    });
    const cancelled = new Promise<BoundedOutcome<T>>((resolve) => {
      abort = () => resolve({ kind: "aborted" });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    return await Promise.race([observed, timeout, cancelled]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/**
 * Retry a brain's bounded health probe within one absolute startup budget.
 * A timed-out health promise remains observed, but can never extend startup or
 * produce an unhandled rejection after the caller has failed closed.
 */
export async function waitForBrainReadiness(
  brain: Pick<Brain, "health">,
  signal: AbortSignal,
  options: BrainReadinessOptions = {},
): Promise<BrainReadinessResult> {
  try {
    const maxAttempts = positiveInteger(
      options.maxAttempts ?? DEFAULT_BRAIN_READINESS_ATTEMPTS,
      "brain readiness maxAttempts",
    );
    const timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_BRAIN_READINESS_TIMEOUT_MS,
      "brain readiness timeoutMs",
    );
    const retryDelayMs = nonNegativeInteger(
      options.retryDelayMs ?? DEFAULT_BRAIN_READINESS_RETRY_DELAY_MS,
      "brain readiness retryDelayMs",
    );
    const sleep = options.sleep ?? abortableSleep;
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    let lastError: unknown;

    while (attempts < maxAttempts) {
      if (signal.aborted) throw new StartupCancelledByShutdownError();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return { healthy: false, attempts, timedOut: true, timeoutMs, lastError };
      }

      attempts += 1;
      const outcome = await withinBudget(
        Promise.resolve().then(() => brain.health()),
        remainingMs,
        signal,
      );
      if (outcome.kind === "aborted") throw new StartupCancelledByShutdownError();
      if (outcome.kind === "timeout") {
        return { healthy: false, attempts, timedOut: true, timeoutMs, lastError };
      }
      if (outcome.kind === "value" && outcome.value) {
        return { healthy: true, attempts, timedOut: false, timeoutMs };
      }
      if (outcome.kind === "error") lastError = outcome.error;
      if (attempts >= maxAttempts) break;

      const beforeDelayMs = deadline - Date.now();
      if (beforeDelayMs <= 0) {
        return { healthy: false, attempts, timedOut: true, timeoutMs, lastError };
      }
      if (retryDelayMs === 0) continue;
      const delayOutcome = await withinBudget(
        Promise.resolve().then(() => sleep(Math.min(retryDelayMs, beforeDelayMs), signal)),
        beforeDelayMs,
        signal,
      );
      if (delayOutcome.kind === "aborted") throw new StartupCancelledByShutdownError();
      if (delayOutcome.kind === "timeout") {
        return { healthy: false, attempts, timedOut: true, timeoutMs, lastError };
      }
      if (delayOutcome.kind === "error") {
        throw delayOutcome.error instanceof Error
          ? delayOutcome.error
          : new Error(`brain readiness delay failed: ${String(delayOutcome.error)}`);
      }
    }

    return { healthy: false, attempts, timedOut: false, timeoutMs, lastError };
  } catch (error: unknown) {
    throw error instanceof Error
      ? error
      : new Error(`brain readiness check failed: ${String(error)}`);
  }
}
