/**
 * One-shot brain context for a proactive notification that actually went out.
 *
 * Notifications are rendered and delivered (or parked) without the brain ever
 * seeing them, so a follow-up on any surface — a dial-back call after texting
 * "call me", a typed "what should we do about that?" — used to land on a brain
 * that had no idea what "that" was. Injecting the delivered text as turn
 * context closes that gap; BrainTurnContext accumulates and bounds entries, so
 * a burst of notifications stacks safely.
 */
export function notificationTurnContext(text: string, at: Date): string {
  return (
    `[Proactive notification delivered to the user at ${at.toISOString()}] ${text}\n` +
    "If the user follows up without naming a topic, assume they mean the most recent notification."
  );
}

/** BrainTurnContext's per-entry bound; keep briefing wrappers within it. */
export const MAX_TURN_CONTEXT_ENTRY_CHARS = 8_000;

/** One-shot brain context for a delivered morning briefing. */
export function briefingTurnContext(text: string, at: Date): string {
  const prefix = `[Morning briefing delivered at ${at.toISOString()}] `;
  const suffix = "\nIf the user follows up without naming a topic, assume they mean the most recent morning briefing.";
  const full = `${prefix}${text}${suffix}`;
  if (full.length <= MAX_TURN_CONTEXT_ENTRY_CHARS) return full;

  const marker = "[earlier briefing content truncated for brain context]\n";
  const available = MAX_TURN_CONTEXT_ENTRY_CHARS - prefix.length - marker.length - suffix.length;
  return `${prefix}${marker}${text.slice(-Math.max(0, available))}${suffix}`;
}
