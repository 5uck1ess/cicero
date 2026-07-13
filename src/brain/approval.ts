import type { Brain, PendingConfirmation } from "../types";

/** Telegram callback data is limited to 64 bytes, so UUIDv4 fits with the action prefix. */
const CONFIRMATION_NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CONFIRM_YES: ReadonlySet<string> = new Set([
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay",
  "confirm", "confirmed", "approve", "approved",
  "go ahead", "go for it", "do it", "proceed",
]);

const CONFIRM_NO: ReadonlySet<string> = new Set([
  "no", "nope", "nah", "dont", "don't", "do not",
  "cancel", "cancel that", "deny", "denied", "stop",
]);

/** A fresh CSPRNG capability whose uniqueness does not rely on process-local counters. */
export function createConfirmationNonce(): string {
  return crypto.randomUUID();
}

export function isConfirmationNonce(value: string): boolean {
  return CONFIRMATION_NONCE_RE.test(value);
}

/**
 * Parse only an exact yes/no utterance. Terminal speech punctuation is benign;
 * additional words are not, so contradictions such as "yes, but don't" fail.
 */
export function confirmationDecision(message: string): boolean | null {
  const normalized = message
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[.,!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (CONFIRM_YES.has(normalized)) return true;
  if (CONFIRM_NO.has(normalized)) return false;
  return null;
}

/** Return independent snapshots so callers cannot mutate a child's gate state. */
export function collectPendingConfirmations(brains: Iterable<Brain>): PendingConfirmation[] {
  const pending: PendingConfirmation[] = [];
  for (const brain of brains) {
    for (const gate of brain.pendingConfirmations?.() ?? []) {
      pending.push({ nonce: gate.nonce, summary: gate.summary });
    }
  }
  return pending;
}

export function hasPendingConfirmations(brains: Iterable<Brain>): boolean {
  for (const brain of brains) {
    if ((brain.hasPendingConfirmation?.() ?? false) || (brain.pendingConfirmations?.().length ?? 0) > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Route a capability to exactly one direct child. Duplicate nonce claims are
 * treated as ambiguous and fail closed instead of approving multiple brains.
 */
export function resolveBoundConfirmation(
  brains: Iterable<Brain>,
  approved: boolean,
  nonce: string,
): boolean {
  const origins: Brain[] = [];
  for (const brain of brains) {
    if ((brain.pendingConfirmations?.() ?? []).some((gate) => gate.nonce === nonce)) {
      origins.push(brain);
    }
  }
  if (origins.length !== 1) return false;
  return origins[0]!.resolvePendingConfirmation?.(approved, nonce) ?? false;
}

/** Bind an exact local yes/no to the sole visible capability, if there is one. */
export function relayBoundConfirmation(brain: Brain, message: string): string | null {
  const pending = brain.pendingConfirmations?.() ?? [];
  if (pending.length === 0 && !(brain.hasPendingConfirmation?.() ?? false)) return null;
  const decision = confirmationDecision(message);
  if (decision === null) return null;
  if (pending.length !== 1) {
    return "I can't safely match that response. Use the matching approval request.";
  }
  return brain.resolvePendingConfirmation?.(decision, pending[0]!.nonce)
    ? decision ? "Approved." : "Cancelled."
    : "That approval is no longer pending.";
}
