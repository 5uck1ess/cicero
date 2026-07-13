export interface Stoppable {
  stop(): Promise<void>;
}

export interface StartableStoppable extends Stoppable {
  start(): Promise<void>;
}

export interface SignalSource {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/** Expected control flow when a signal interrupts daemon startup. */
export class StartupCancelledByShutdownError extends Error {
  constructor() {
    super("startup cancelled by shutdown");
    this.name = "StartupCancelledByShutdownError";
  }
}

/**
 * CLI-only signal ownership. Library consumers call daemon.stop() themselves;
 * the daemon never registers process-global handlers or exits its host process.
 */
export function waitForShutdown(
  target: Stoppable,
  source: SignalSource = process,
  cancel?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let closing = false;
    const cleanup = () => {
      source.removeListener("SIGINT", shutdown);
      source.removeListener("SIGTERM", shutdown);
      cancel?.removeEventListener("abort", cancelWait);
    };
    const shutdown = () => {
      if (closing) return;
      closing = true;
      target.stop().then(
        () => { cleanup(); resolve(); },
        (error: unknown) => { cleanup(); reject(error); },
      );
    };
    const cancelWait = () => {
      if (closing) return;
      closing = true;
      cleanup();
      resolve();
    };
    source.once("SIGINT", shutdown);
    source.once("SIGTERM", shutdown);
    cancel?.addEventListener("abort", cancelWait, { once: true });
    if (cancel?.aborted) cancelWait();
  });
}

/**
 * Run a CLI-owned daemon until SIGINT/SIGTERM completes its cleanup.
 *
 * A signal can make start() reject before stop() finishes. Treat that typed
 * cancellation as the same clean shutdown path, but keep real startup errors
 * fatal so supervisors still see a non-zero exit.
 */
export async function runUntilShutdown(
  target: StartableStoppable,
  source: SignalSource = process,
): Promise<void> {
  const cancelWait = new AbortController();
  const shutdown = waitForShutdown(target, source, cancelWait.signal);
  try {
    const outcome = await Promise.race([
      target.start().then(
        () => "started" as const,
        (error: unknown) => {
          if (error instanceof StartupCancelledByShutdownError) return "startup-cancelled" as const;
          throw error;
        },
      ),
      shutdown.then(() => "stopped" as const),
    ]);
    if (outcome === "started" || outcome === "startup-cancelled") {
      await shutdown;
    }
  } catch (error) {
    throw error;
  } finally {
    cancelWait.abort();
  }
}
