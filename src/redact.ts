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

/** Replace credential-shaped substrings. Never throws; input is untrusted. */
export function redactSecrets(message: string): string {
  let output = message;
  for (const [pattern, replacement] of RULES) output = output.replace(pattern, replacement);
  return output;
}
