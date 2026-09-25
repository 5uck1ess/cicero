/** Browser monotonic origin for a completed utterance. */
export function speechEndOrigin(lastVoicedAt: number | null, finalizedAt: number, pushToTalk: boolean): number {
  return pushToTalk || lastVoicedAt === null ? finalizedAt : Math.min(finalizedAt, lastVoicedAt);
}
