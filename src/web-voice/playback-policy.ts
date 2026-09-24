/** Last-resort bound; v2 server pacing normally keeps the queue near 12 s. */
export const MAX_QUEUED_AUDIO_MS = 120_000;
export function canQueueAudio(queuedMs: number, incomingMs: number): boolean {
  return Number.isFinite(queuedMs) && Number.isFinite(incomingMs)
    && queuedMs >= 0 && incomingMs > 0 && queuedMs + incomingMs <= MAX_QUEUED_AUDIO_MS;
}
