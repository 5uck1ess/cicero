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
