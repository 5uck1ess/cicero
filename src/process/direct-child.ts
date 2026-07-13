import {
  OwnedProcessReapError,
  terminateOwnedDirectProcess,
  type OwnedProcess,
} from "./owned-process";

export type DirectChildProcess = OwnedProcess;

export interface DirectChildTerminationOptions {
  /** Grace between TERM and KILL. */
  terminateGraceMs?: number;
  /** Maximum wait to confirm direct-child reap after KILL. */
  reapTimeoutMs?: number;
}

/**
 * Stop one owned direct child, escalate if needed, and confirm its exit promise
 * settles. This deliberately makes no descendant-tree claim; callers here own
 * native recorder/player helpers that do not launch child process trees.
 */
export async function terminateDirectChild(
  proc: DirectChildProcess,
  options: DirectChildTerminationOptions = {},
): Promise<void> {
  try {
    await terminateOwnedDirectProcess(proc, options);
  } catch (error: unknown) {
    // Preserve this long-standing direct-child API while delegating the actual
    // signaling to the shared primitive. Callers log these diagnostics and
    // validation used to reject as RangeError before any cleanup attempt.
    if (error instanceof RangeError) throw error;
    if (error instanceof OwnedProcessReapError) {
      if (Object.hasOwn(error, "cause")) {
        const observationError = error.cause;
        throw new Error(
          `direct child ${proc.pid} exit observation failed: ${observationError instanceof Error ? observationError.message : String(observationError)}`,
          { cause: observationError },
        );
      }
      throw new Error(`direct child ${proc.pid} did not reap after SIGKILL`, { cause: error });
    }
    throw new Error(
      `direct child ${proc.pid} cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
