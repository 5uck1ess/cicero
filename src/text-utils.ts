/**
 * Make a value safe to interpolate into a log line: strip C0/C7F control
 * characters (so a newline or terminal escape in an untrusted value can't
 * forge log entries or emit control sequences) and length-cap it.
 */
export function sanitizeLabel(value: string, max: number): string {
  const cleaned = Array.from(value, (ch) => {
    const c = ch.codePointAt(0)!;
    return c < 0x20 || c === 0x7f ? "\uFFFD" : ch; // strip C0/DEL controls
  });
  return cleaned.length > max ? cleaned.slice(0, max).join("") + "\u2026" : cleaned.join("");
}

/**
 * Strip leading filler words and trailing punctuation from voice input.
 * Used as a preprocessing step before intent classification.
 *
 * Strips up to 3 rounds of leading fillers like:
 * "okay", "um", "let's", "so", "well", "alright", "can you", "could you please",
 * "go ahead and", etc.
 */
export function stripFillers(text: string): string {
  let result = text.toLowerCase().trim();

  // Strip trailing punctuation
  result = result.replace(/[.?!,]+$/, "").trim();

  // Compound prefixes (must check before single-word fillers)
  const compoundPrefixes = /^(?:go ahead and|can you|could you|could you please|would you|would you please)\s+/i;

  // Single-word fillers (prefix-only, up to 3 rounds)
  const singleFiller = /^(?:okay|ok|hey|so|um+|uh+|hmm+|alright|well|yeah|yes|no|please|now|right|let's|lets|like|basically|actually)\s*[,.]?\s*/i;

  // Strip compound prefix first
  result = result.replace(compoundPrefixes, "").trim();

  // Then strip up to 3 single-word fillers
  for (let i = 0; i < 3; i++) {
    const next = result.replace(singleFiller, "").trim();
    if (next === result) break;
    result = next;
  }

  return result.trim();
}
