/**
 * Secret redaction for anything that reaches an operator surface.
 *
 * Provider error bodies are untrusted *and* frequently reflective: a 401 from a
 * remote endpoint routinely quotes the credential it just rejected, and that
 * body is copied verbatim into the thrown error, logged, and stored in
 * dashboard history. Redacting only at one call site leaves every other path
 * open, so this is applied where bodies are read AND at the logger.
 *
 * The rules are deliberately shape-based rather than exhaustive: they cover URL
 * credentials, authorization headers, the common vendor key prefixes, and
 * secret-named fields. Anything unmatched is still bounded by the readers that
 * produced it.
 */

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // ?token=… / &api_key=… — the endpoint stays readable, the credential does not.
  [/([?&](?:token|access_token|api[-_]?key|apikey|key|sig|signature)=)[^&#\s"']+/gi, "$1<redacted>"],
  // scheme://user:pass@host
  [/([a-z][a-z0-9+.\-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1<redacted>@"],
  // Authorization: Bearer …  /  Basic …
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>"],
  // Vendor key shapes, matched by prefix so a rotated key is covered too.
  [/\b(?:sk|xai|xoxb|xoxp|xoxa|xoxs|dop_v1)-[A-Za-z0-9._-]{6,}/gi, "<redacted>"],
  [/\b(?:gsk|hf|ghp|gho|ghu|ghs|github_pat|glpat)_[A-Za-z0-9._-]{6,}/gi, "<redacted>"],
  [/\bAIza[A-Za-z0-9_-]{10,}/g, "<redacted>"],
  [/\bAKIA[A-Z0-9]{10,}/g, "<redacted>"],
  // "api_key": "…" / api_key=… — keep the field name, drop the value.
  [
    /(["']?\b(?:api[-_]?key|secret|password|passwd|access[-_]?token|auth[-_]?token|authorization|token)\b["']?\s*[:=]\s*)(["']?)(?!<redacted>)[^"'\s,;}]{4,}/gi,
    "$1$2<redacted>",
  ],
];

/**
 * Credentials whose VALUE is known because this daemon was configured with it.
 *
 * Shape rules cannot catch every key: a bare `correcthorsebattery` reflected in
 * a provider's 401 prose looks exactly like an ordinary word, and no pattern
 * will ever recognise it. The configured value is the one thing that does
 * identify it, so the daemon hands its credential inventory over at startup and
 * anything matching is removed by literal value.
 *
 * Module-level on purpose: the logger is a process-wide singleton and this is
 * the only way it can learn config-derived secrets.
 */
const known = new Set<string>();
/**
 * Short values are refused: a two-character "secret" would blank out ordinary
 * prose everywhere it happened to appear, which destroys diagnostics without
 * protecting anything worth protecting.
 */
const MIN_KNOWN_SECRET_CHARS = 6;

export function registerKnownSecrets(values: Iterable<string | undefined>): void {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length >= MIN_KNOWN_SECRET_CHARS) known.add(trimmed);
  }
}

/** Forget them — a daemon that stopped must not leak state into the next one. */
export function clearKnownSecrets(): void {
  known.clear();
}

/** Replace credential-shaped substrings. Never throws; input is untrusted. */
export function redactSecrets(message: string): string {
  let output = message;
  // Longest first: a credential that contains another registered value must not
  // be half-replaced, leaving the remainder of the real key in the output.
  for (const secret of [...known].sort((a, b) => b.length - a.length)) {
    if (output.includes(secret)) output = output.split(secret).join("<redacted>");
  }
  for (const [pattern, replacement] of RULES) output = output.replace(pattern, replacement);
  return output;
}
