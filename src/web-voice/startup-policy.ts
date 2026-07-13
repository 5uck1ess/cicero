/** Fail before allocating providers when a headless daemon has no input/output surface. */
export function assertHeadlessWebVoiceConfigured(headless: boolean, enabled: boolean): void {
  if (headless && !enabled) {
    throw new Error("headless mode requires web_voice.enabled: true; otherwise no client can reach Cicero");
  }
}

/** A bind/listen failure is fatal when web voice is the daemon's only surface. */
export function assertHeadlessWebVoiceStarted(
  headless: boolean,
  started: boolean,
  host: string,
  port: number,
): void {
  if (headless && !started) {
    throw new Error(`headless web voice failed to listen on ${host}:${port}; refusing to report Cicero ready`);
  }
}

export interface WebVoiceToken {
  token: string;
  ephemeral: boolean;
}

export const WEB_VOICE_TOKEN_GENERATION_HINT =
  "run: openssl rand -hex 16; paste only its output as web_voice.token";

const DOCUMENTED_TOKEN_PLACEHOLDERS: readonly RegExp[] = [
  /^<[^>]+>$/,
  /^(?:change|replace)[-_ ]+me(?:$|[-_ ])/,
  /^(?:generate|insert|paste)(?:[-_ ]+(?:a|the|your))?[-_ ]+(?:secret|token|value)(?:$|[-_ ]+here$)/,
  /^(?:your|example|sample)[-_ ]+(?:secret|token|value)(?:$|[-_ ]+(?:here|value)$)/,
];

/** Reject copy/paste documentation values before they become public credentials. */
export function webVoiceTokenProblem(configured: unknown): string | null {
  if (typeof configured !== "string") {
    return "must be a string containing at least 16 non-whitespace characters";
  }
  const token = configured.trim();
  if (token.length < 16) {
    return "must be a string containing at least 16 non-whitespace characters";
  }
  if (DOCUMENTED_TOKEN_PLACEHOLDERS.some((pattern) => pattern.test(token.toLowerCase()))) {
    return "must not use a documented placeholder value";
  }
  return null;
}

/** Normalize an operator token or create a fresh credential for this process. */
export function resolveWebVoiceToken(
  configured: unknown,
  generate: () => string = () => crypto.randomUUID(),
): WebVoiceToken {
  if (configured !== undefined && configured !== null && typeof configured !== "string") {
    throw new Error(`web_voice.token ${webVoiceTokenProblem(configured)}`);
  }
  const stable = typeof configured === "string" ? configured.trim() : "";
  const problem = stable ? webVoiceTokenProblem(stable) : null;
  if (problem) throw new Error(`web_voice.token ${problem}`);
  return stable
    ? { token: stable, ephemeral: false }
    : { token: generate(), ephemeral: true };
}
