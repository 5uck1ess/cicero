/** Last-resort bound on backlog; v2 server pacing normally keeps the queue near 12 s. */
export const MAX_QUEUED_AUDIO_MS = 120_000;
/**
 * The cap bounds backlog, not a single clip: the server's synthesized-WAV
 * admission already bounds each clip, so an empty queue accepts any clip it
 * admitted (which may exceed this cap at low sample rates).
 */
export function canQueueAudio(queuedMs: number, incomingMs: number): boolean {
  if (!Number.isFinite(queuedMs) || !Number.isFinite(incomingMs) || queuedMs < 0 || incomingMs <= 0) return false;
  return queuedMs === 0 || queuedMs + incomingMs <= MAX_QUEUED_AUDIO_MS;
}
