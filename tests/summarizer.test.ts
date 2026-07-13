import { test, expect, mock } from "bun:test";
import { summarizeForTTS } from "../src/summarizer";
import type { LLMProvider } from "../src/backends/llm/provider";

const mockLLM = (response: string): LLMProvider => ({
  chatCompletion: mock(async () => response),
} as unknown as LLMProvider);

test("short outputs pass through unchanged", async () => {
  const result = await summarizeForTTS("Done.", mockLLM(""), { maxTokens: 100 });
  expect(result).toBe("Done.");
});

test("long outputs get summarized via LLM", async () => {
  const long = "x".repeat(500);
  const result = await summarizeForTTS(long, mockLLM("Did the thing."), { maxTokens: 100 });
  expect(result).toBe("Did the thing.");
});

test("LLM failure falls back to last non-code line", async () => {
  const failing: LLMProvider = {
    chatCompletion: mock(async () => { throw new Error("boom"); }),
  } as unknown as LLMProvider;
  const longContext = "x".repeat(300);
  const input = `${longContext}\n\`\`\`ts\ncode\n\`\`\`\nFinal answer line.`;
  const result = await summarizeForTTS(input, failing, { maxTokens: 100 });
  expect(result).toBe("Final answer line.");
});

test("very long outputs are truncated before sending to LLM", async () => {
  const huge = "x".repeat(3000);
  const chatMock = mock(async (_messages: unknown, _opts: unknown) => "Summary.");
  const llm = { chatCompletion: chatMock } as unknown as LLMProvider;
  await summarizeForTTS(huge, llm, { maxTokens: 100 });
  const callArgs = chatMock.mock.calls[0][0] as Array<{ content: string }>;
  expect(callArgs[1].content.length).toBeLessThan(2500);
});

test("strips <think> tags from LLM output", async () => {
  const result = await summarizeForTTS(
    "x".repeat(500),
    mockLLM("<think>reasoning</think>The summary."),
    { maxTokens: 100 },
  );
  expect(result).toBe("The summary.");
});
