/**
 * Flatten a sentence for text-to-speech. Models emit Markdown and typographic
 * punctuation that a voice engine can't pronounce — a leading "- " becomes a
 * spoken "dash", back-ticks and asterisks become clicks, an em-dash can glitch
 * mid-word. The pane keeps the rich text; only the audio path runs through
 * here, so what the user READS stays formatted and what they HEAR stays clean.
 *
 * Deliberately conservative: it strips speech-hostile markup and normalizes
 * dashes/quotes/ellipses to their spoken equivalents, and does nothing else —
 * word order and content are never touched.
 */
/**
 * Delivery tags — "[excited] Let's go." — are stage directions an LLM can
 * emit for the voice, not words. An engine that understands them gets "keep";
 * every other engine must not speak the word "excited", so the default
 * strips the whole token. Lowercase, short, bracketed: real content like
 * "[Note]" or "[2026]" doesn't match and only loses its brackets later.
 */
const DELIVERY_TAG = /(^|[\s"'.,;:!?])\[[a-z][a-z ,'-]{1,29}\]/g;

/** ALL-CAPS synthesizes as a shout; these acronyms are the exception. */
const CAPS_OK = new Set(["HTTP", "HTTPS", "JSON", "YAML", "HTML", "CUDA", "VRAM", "ONNX", "GGUF", "TLDR"]);

export function speakable(text: string, tags: "strip" | "keep" = "strip"): string {
  let s = text;

  // Fenced/inline code fences and emphasis markers — spoken as noise.
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`([^`]*)`/g, "$1");

  // Links and images: keep the visible label, drop the URL machinery.
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");

  // LLM delivery tags (see above) — remove the whole token unless the engine
  // downstream declared it can act on them; kept tags hide behind placeholders
  // so the stray-bracket cleanup below can't eat them.
  const kept: string[] = [];
  if (tags === "keep") {
    s = s.replace(DELIVERY_TAG, (m, pre: string) => {
      kept.push(m.slice(pre.length));
      return `${pre}\u0000${kept.length - 1}\u0000`;
    });
  } else {
    s = s.replace(DELIVERY_TAG, "$1");
  }

  // Leading list markers ("- ", "* ", "+ ", "1. ", "2) ") at the start of the
  // sentence or after a newline — the bullet itself must not be voiced.
  s = s.replace(/(^|\n)\s*(?:[-*+]|\d+[.)])\s+/g, "$1");

  // Heading hashes and block-quote carets at line starts.
  s = s.replace(/(^|\n)\s*#{1,6}\s+/g, "$1");
  s = s.replace(/(^|\n)\s*>\s?/g, "$1");

  // Bold/italic/strikethrough emphasis runs — remove the markers, keep the word.
  s = s.replace(/(\*\*|__)(.*?)\1/g, "$2");
  s = s.replace(/(\*|_)(.*?)\1/g, "$2");
  s = s.replace(/~~(.*?)~~/g, "$1");

  // Horizontal rules ("---", "***", "===") — decoration, not speech.
  s = s.replace(/(^|\n)\s*[-*=]{3,}\s*(?=\n|$)/g, "$1");

  // Typography → spoken equivalents. Em/en dashes (and their ASCII "--" form)
  // become a comma pause so the engine breathes instead of glitching; curly
  // quotes flatten to straight.
  s = s.replace(/\s*(?:[—–]|--+)\s*/g, ", ");
  s = s.replace(/[“”„]/g, '"').replace(/[‘’]/g, "'");
  s = s.replace(/…/g, "...");

  // Punctuation is a volume knob to the engine: repeated terminators get
  // belted, and an ALL-CAPS word is synthesized as a yell. One mark is
  // emphasis enough; caps flatten to a capitalized word (acronyms excepted).
  s = s.replace(/!{2,}/g, "!").replace(/\?{2,}/g, "?");
  s = s.replace(/\b[A-Z]{4,}\b/g, (w) => (CAPS_OK.has(w) ? w : w[0] + w.slice(1).toLowerCase()));

  // Any stray emphasis/heading/bracket characters left mid-sentence.
  s = s.replace(/[`*_#>[\]]/g, "");

  // Restore kept delivery tags now that the destructive passes are done.
  if (kept.length) s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)] ?? "");

  // Collapse the whitespace the substitutions leave behind.
  s = s.replace(/[ \t]+/g, " ").replace(/\s+\n/g, "\n").trim();
  return s;
}
