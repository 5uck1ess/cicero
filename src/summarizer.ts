import type { LLMProvider } from "./backends/llm/provider";
import { log } from "./logger";

export interface SummarizerOptions {
  maxTokens: number;
}

export async function summarizeForTTS(
  output: string,
  llm: LLMProvider,
  opts: SummarizerOptions,
): Promise<string> {
  if (output.length < 200) return output;

  const truncated = output.length > 2000
    ? output.substring(0, 1000) + "\n...\n" + output.substring(output.length - 800)
    : output;

  try {
    const raw = await llm.chatCompletion(
      [
        {
          role: "system",
          content: "/no_think\nYou summarize AI assistant outputs for text-to-speech. Give a 1-3 sentence TLDR of what was done or answered. Be conversational and natural. No markdown, no code, no file paths.",
        },
        {
          role: "user",
          content: `Summarize this response for a voice assistant to read aloud:\n\n${truncated}`,
        },
      ],
      { temperature: 0.3, max_tokens: opts.maxTokens },
    );

    const summary = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (summary) return summary;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", `TTS summary failed: ${msg}`);
  }

  const lastLine = output.split("\n")
    .filter(l => l.trim() && !l.startsWith("```") && !l.startsWith("  "))
    .pop();
  return lastLine?.substring(0, 300) ?? "Done.";
}
