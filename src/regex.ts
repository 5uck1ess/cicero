/** Escape a string so it is matched literally inside a regular expression. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD_CHAR = "[\\p{L}\\p{N}_]";

/**
 * Replace one configured phrase literally, including phrases such as `c++` or
 * `a.b`. A callback keeps `$&` and `$1` in replacement text literal as well.
 */
export function replaceLiteralPhrase(text: string, phrase: string, replacement: string): string {
  const literal = phrase.trim();
  if (!literal) return text;
  const pattern = new RegExp(
    `(?<!${WORD_CHAR})${escapeRegExp(literal)}(?!${WORD_CHAR})`,
    "giu",
  );
  return text.replace(pattern, () => replacement);
}

export interface CompiledTemplate {
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
}

const TEMPLATE_CACHE_LIMIT = 256;
const templateCache = new Map<string, CompiledTemplate>();

/** Compile an action example while treating only `{param}` slots as dynamic. */
export function compileLiteralTemplate(template: string): CompiledTemplate {
  const cached = templateCache.get(template);
  if (cached) {
    // Refresh insertion order so frequently used templates survive the cap.
    templateCache.delete(template);
    templateCache.set(template, cached);
    return cached;
  }

  const slot = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  const paramNames: string[] = [];
  let source = "";
  let cursor = 0;
  for (const match of template.matchAll(slot)) {
    const index = match.index ?? cursor;
    source += escapeRegExp(template.slice(cursor, index));
    // Keep the router's historical greedy capture semantics. Escaping config
    // must not silently redistribute repeated delimiters between parameters.
    source += "(.+)";
    paramNames.push(match[1]!);
    cursor = index + match[0].length;
  }
  source += escapeRegExp(template.slice(cursor));
  const compiled = Object.freeze({
    regex: new RegExp(`^${source}$`, "iu"),
    paramNames: Object.freeze(paramNames),
  });
  if (templateCache.size >= TEMPLATE_CACHE_LIMIT) {
    const oldest = templateCache.keys().next().value;
    if (oldest !== undefined) templateCache.delete(oldest);
  }
  templateCache.set(template, compiled);
  return compiled;
}
