/**
 * Build a context line, injected into the brain before the interjection turn,
 * so the assistant knows it was interrupted mid-response and can resume.
 */
export function buildRecoveryContext(opts: { spoken: string[]; interjection: string }): string {
  const said = opts.spoken.join(" ").trim();
  if (!said) {
    return `[The user interjected before you finished responding. They said: "${opts.interjection}". Address it, then continue naturally.]`;
  }
  return `[You were speaking and the user interrupted you. You had already said: "${said}". The user interjected: "${opts.interjection}". Respond to their interjection first. If your previous point was unfinished, briefly resume it afterward.]`;
}
