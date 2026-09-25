/** Normalize a captured lane reference: lowercase, strip filler and punctuation. */
export function normalizeRef(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,!?'"]/g, "")
    .replace(/\b(?:please|now|again|lane|profile|agent|employee)\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // The pin pattern consumes a leading "the" before its capture, so aliases
    // written naturally ("the thinker") must drop theirs too or never match.
    .replace(/^the\s+/, "");
}

