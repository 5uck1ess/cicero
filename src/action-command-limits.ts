import type { ActionConfig } from "./types";

export const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
export const MAX_ACTION_TIMEOUT_SECONDS = 60 * 60;
export const DEFAULT_ACTION_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const MAX_ACTION_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export interface ActionCommandLimits {
  timeoutMs: number;
  outputLimitBytes: number;
}

/**
 * Resolve validated action limits at the final execution boundary. Startup and
 * hot-reload validation reject malformed config first; this second check keeps
 * programmatic RuntimeConfig mutations from disabling process bounds.
 */
export function resolveActionCommandLimits(
  action: Pick<ActionConfig, "timeout_s" | "output_limit">,
): ActionCommandLimits {
  const timeoutSeconds = action.timeout_s;
  if (
    timeoutSeconds !== undefined
    && (
      typeof timeoutSeconds !== "number"
      || !Number.isFinite(timeoutSeconds)
      || timeoutSeconds <= 0
      || timeoutSeconds > MAX_ACTION_TIMEOUT_SECONDS
    )
  ) {
    throw new TypeError(
      `action timeout_s must be greater than 0 and at most ${MAX_ACTION_TIMEOUT_SECONDS}`,
    );
  }

  const outputLimit = action.output_limit;
  if (
    outputLimit !== undefined
    && (
      !Number.isSafeInteger(outputLimit)
      || outputLimit < 1
      || outputLimit > MAX_ACTION_OUTPUT_LIMIT_BYTES
    )
  ) {
    throw new TypeError(
      `action output_limit must be an integer between 1 and ${MAX_ACTION_OUTPUT_LIMIT_BYTES}`,
    );
  }

  return {
    timeoutMs: timeoutSeconds === undefined
      ? DEFAULT_ACTION_TIMEOUT_MS
      : Math.max(1, Math.ceil(timeoutSeconds * 1000)),
    outputLimitBytes: outputLimit ?? DEFAULT_ACTION_OUTPUT_LIMIT_BYTES,
  };
}
