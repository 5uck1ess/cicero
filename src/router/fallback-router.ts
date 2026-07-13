import type { Router, RouterResult, ActionConfig } from "../types";
import { compileLiteralTemplate, replaceLiteralPhrase } from "../regex";

export class FallbackRouter implements Router {
  private primary: Router;
  private aliases: Record<string, string[]>;

  constructor(primary: Router, aliases: Record<string, string[]> = {}) {
    this.primary = primary;
    this.aliases = aliases;
  }

  private expandAliases(text: string): string {
    let result = text;
    for (const [canonical, alts] of Object.entries(this.aliases)) {
      for (const alt of alts) {
        result = replaceLiteralPhrase(result, alt, canonical);
      }
    }
    return result;
  }

  async classify(text: string, actions: Record<string, ActionConfig>, context?: string): Promise<RouterResult> {
    // Check for continuation words — if present and context has recent intent, try to inherit
    if (context) {
      const continuationResult = this.checkContinuation(text, actions, context);
      if (continuationResult) return continuationResult;
    }

    // Try keyword matching first — fast and reliable for known actions
    const keywordResult = this.keywordMatch(text, actions);

    // High-confidence keyword match — trust it over the LLM
    if (keywordResult.confidence >= 0.6) {
      return keywordResult;
    }

    // Low/no confidence — try LLM router for classification. Do not preflight
    // with health(): classification is already the availability check, and a
    // separate request adds a full network round trip to every uncached command.
    try {
      const llmResult = await this.primary.classify(text, actions, context);
      // Only use LLM result if it's a known action (not hallucinated)
      if (llmResult.intent in actions || llmResult.intent === "simple_question" || llmResult.intent === "complex") {
        // Enforce correct category — LLM sometimes misclassifies these
        if (llmResult.intent === "simple_question") llmResult.category = "local-llm";
        if (llmResult.intent === "complex") llmResult.category = "brain";
        if (llmResult.intent in actions) llmResult.category = actions[llmResult.intent].category;
        return llmResult;
      }
    } catch {}

    // LLM unavailable or bad result — return the keyword result
    return keywordResult;
  }

  async health(): Promise<boolean> {
    return true; // Fallback always works
  }

  private checkContinuation(text: string, actions: Record<string, ActionConfig>, context: string): RouterResult | null {
    const lower = text.toLowerCase().trim();
    const continuationPrefixes = /^(?:now|also|then|and|again|next|after that)\s+/;

    if (!continuationPrefixes.test(lower)) return null;

    // Extract last intent from context
    const lastIntentMatch = context.match(/→ (\w+) \((\w[\w-]*)\)/g);
    if (!lastIntentMatch) return null;

    const lastMatch = lastIntentMatch[lastIntentMatch.length - 1];
    const parsed = lastMatch.match(/→ (\w+) \((\w[\w-]*)\)/);
    if (!parsed) return null;

    const lastIntent = parsed[1];

    // Strip the continuation prefix and try to re-classify the remainder
    const remainder = lower.replace(continuationPrefixes, "").trim();
    if (!remainder) return null;

    // Try keyword matching on the remainder
    const result = this.keywordMatch(remainder, actions);
    if (result.confidence >= 0.6) return result;

    // If remainder doesn't match anything but last intent was an action, inherit it
    if (lastIntent in actions) {
      return {
        intent: lastIntent,
        category: actions[lastIntent].category,
        params: { query: remainder, payload: remainder },
        confidence: 0.7,
      };
    }

    return null;
  }

  private keywordMatch(text: string, actions: Record<string, ActionConfig>): RouterResult {
    const expanded = this.expandAliases(text);
    const lower = expanded.toLowerCase();

    // Phase 1: Exact example matching (with template params)
    for (const [name, action] of Object.entries(actions)) {
      for (const example of action.examples) {
        // Handle template params like {tab}; configured punctuation is literal,
        // not executable regular-expression syntax.
        const { regex, paramNames } = compileLiteralTemplate(example);
        const match = lower.match(regex);

        if (match) {
          const params: Record<string, string> = {};
          paramNames.forEach((pname, i) => {
            if (match[i + 1]) params[pname] = match[i + 1].trim();
          });

          return {
            intent: name,
            category: action.category,
            params,
            confidence: 0.9,
          };
        }
      }
    }

    // Phase 2: Fuzzy keyword matching — check if core words from examples appear
    for (const [name, action] of Object.entries(actions)) {
      const allExampleWords = action.examples
        .flatMap(e => e.toLowerCase().replace(/\{.*?\}/g, "").split(/\s+/))
        .filter(w => w.length > 3); // skip tiny words
      const uniqueWords = [...new Set(allExampleWords)];

      // Count how many core words appear in the input
      const matchCount = uniqueWords.filter(w => lower.includes(w)).length;
      if (matchCount >= 2 && uniqueWords.length > 0) {
        return {
          intent: name,
          category: action.category,
          params: { query: text },
          confidence: 0.6,
        };
      }
    }

    // No keyword match — simple questions go to local LLM, complex to brain
    if (this.isSimpleQuestion(lower)) {
      return {
        intent: "simple_question",
        category: "local-llm",
        params: { query: text },
        confidence: 0.3,
      };
    }

    return {
      intent: "complex",
      category: "brain",
      params: { query: text },
      confidence: 0.0,
    };
  }

  /**
   * Heuristic: simple questions are short, conversational queries that
   * a small LLM can answer. Complex tasks mention code, files, projects,
   * or multi-step instructions.
   */
  private isSimpleQuestion(text: string): boolean {
    // Complex indicators — route to brain
    const complexPatterns = [
      /\b(file|code|function|class|bug|fix|refactor|deploy|commit|push|pull|merge)\b/,
      /\b(create|write|build|implement|add|remove|delete|update|change|modify)\b.*\b(file|code|function|test|component)\b/,
      /\b(project|repo|repository|codebase|branch)\b/,
      /\b(run|execute|install|configure|setup)\b/,
      /\b(debug|error|exception|crash|fail)\b/,
    ];

    if (complexPatterns.some(p => p.test(text))) return false;

    // Simple indicators — local LLM can handle
    const simplePatterns = [
      /^(what|who|where|when|why|how|is|are|was|were|do|does|did|can|could|will|would|should)\b/,
      /\b(explain|tell me|what is|what are|describe|define)\b/,
      /\b(joke|story|fun fact|trivia|quote)\b/,
      /\b(meaning|definition|difference between)\b/,
      /\b(thanks|thank you|okay|ok|sure|yes|no|maybe)\b/,
    ];

    // Short text + simple pattern = local LLM
    if (text.split(/\s+/).length <= 15 && simplePatterns.some(p => p.test(text))) {
      return true;
    }

    // Very short questions (≤8 words) without complex indicators = local LLM
    if (text.split(/\s+/).length <= 8) return true;

    return false;
  }
}
