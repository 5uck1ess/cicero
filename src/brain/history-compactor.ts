import { discardResponseBody, providerSignal, readBoundedJson, PROVIDER_TIMEOUT_MS } from "../backends/http-transfer";
import type { HistoryCompactor } from "./turn-context";

/** One small-model completion against an OpenAI-compatible endpoint. */
export type SummarizerComplete = (prompt: string, maxTokens: number, signal?: AbortSignal) => Promise<string>;

export interface SummarizerEndpoint {
  summarizer_url?: string;
  summarizer_model?: string;
}

/**
 * Build the shared small-model completion helper.
 *
 * The TLDR speech gate, the call-minutes writer, and history compaction all
 * talk to the same local endpoint; this is that one client. Returns undefined
 * when no URL is configured, which every caller treats as "feature off".
 */
export function createSummarizerComplete(config: SummarizerEndpoint | undefined): SummarizerComplete | undefined {
  const base = config?.summarizer_url;
  if (!base) return undefined;
  const url = `${base.replace(/\/$/, "")}/chat/completions`;
  const model = config?.summarizer_model ?? "";
  return async (prompt: string, maxTokens: number, signal?: AbortSignal): Promise<string> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        reasoning_effort: "none",
        messages: [{ role: "user", content: prompt }],
      }),
      signal: providerSignal(PROVIDER_TIMEOUT_MS.summarizer, signal),
    });
    if (!res.ok) {
      await discardResponseBody(res);
      // The URL may carry credentials; the status alone is what is safe to surface.
      throw new Error(`summarizer ${res.status}`);
    }
    const data = await readBoundedJson<{ choices?: Array<{ message?: { content?: string } }> }>(res);
    const line = data.choices?.[0]?.message?.content?.trim();
    if (!line) throw new Error("summarizer returned nothing");
    return line;
  };
}

/** Tokens allowed for one compaction. Roughly tracks MAX_SUMMARY_CHARS. */
const COMPACTION_MAX_TOKENS = 700;
/** Bound on what is sent up: this is conversation text, and the endpoint is small. */
const MAX_PROMPT_CHARS = 24_000;

function buildPrompt(turns: readonly { user: string; assistant: string }[], previousSummary: string | null): string {
  const transcript = turns
    .map((turn) => `User: ${turn.user}\nAssistant: ${turn.assistant}`)
    .join("\n\n");
  const sections = [
    "You are compacting the earlier part of a conversation so it can be carried forward in limited space.",
    "Write a single dense paragraph in the third person recording what was discussed, what was decided, and any facts, names, paths, or numbers that later turns would need. Do not add commentary, headings, or markdown. Do not invent anything.",
  ];
  if (previousSummary) {
    sections.push(
      `This is the summary of everything before the excerpt below. Fold it together with the excerpt into ONE paragraph — do not simply append:\n${previousSummary}`,
    );
  }
  sections.push(`Excerpt to fold in:\n${transcript}`);
  const prompt = sections.join("\n\n");
  return prompt.length <= MAX_PROMPT_CHARS
    ? prompt
    : `${prompt.slice(0, MAX_PROMPT_CHARS)}\n[excerpt truncated]`;
}

/**
 * Adapt the summarizer endpoint into the compactor the turn context expects.
 * Returns undefined when no endpoint is configured — the context then evicts
 * exactly as it always has.
 */
export function createHistoryCompactor(config: SummarizerEndpoint | undefined): HistoryCompactor | undefined {
  const complete = createSummarizerComplete(config);
  if (!complete) return undefined;
  return ({ turns, previousSummary }, signal) =>
    complete(buildPrompt(turns, previousSummary), COMPACTION_MAX_TOKENS, signal);
}
