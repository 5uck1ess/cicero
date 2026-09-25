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


/** Identity of a configured name: case- and spacing-insensitive, nothing else.
 * Unlike normalizeRef it never drops words, so "coder" and "coder agent" stay
 * distinct names. Use it to compare configured names with each other. */
export function nameKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}
