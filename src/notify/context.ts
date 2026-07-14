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
