import { redactSecrets } from "../../redact";

export const LIVE_STT_FAILURES = ["never_opened", "open_failed", "push_rejected", "server_error", "deadline", "aborted", "empty_final", "missing_terminal", "superseded"] as const;
export type LiveSttFailure = typeof LIVE_STT_FAILURES[number];

export class LiveSttError extends Error {
  constructor(readonly stage: LiveSttFailure, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = cause instanceof Error ? cause.name : "Error";
  }
}

export function liveSttFailure(error: unknown): LiveSttFailure {
  if (error instanceof LiveSttError) return error.stage;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof DOMException && error.name === "AbortError" || /\babort(?:ed)?\b/i.test(message)) return "aborted";
  if (/\bdeadline\b|\btimeout\b/i.test(message)) return "deadline";
  if (/\bmissing terminal\b/i.test(message)) return "missing_terminal";
  return "server_error";
}

/** A bounded operator detail, with whole URLs hidden before the usual credential rules. */
export function liveSttFailureDetail(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(`${name}: ${message}`.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, "<redacted URL>"))
    .replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
}
