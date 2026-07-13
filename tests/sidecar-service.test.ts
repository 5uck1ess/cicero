import { test, expect, mock } from "bun:test";
import { DefaultSpeakService } from "../src/sidecar/service";
import type { LLMProvider } from "../src/backends/llm/provider";
import type { TTSProvider } from "../src/backends/tts/provider";
import type { Speaker } from "../src/types";

function makeDeps() {
  const speakMock = mock(async (_text: string) => {});
  const stopMock = mock(async () => {});
  return {
    llm: { chatCompletion: mock(async () => "Summary text.") } as unknown as LLMProvider,
    tts: { name: "mock", synthesize: mock(async () => new Uint8Array()), health: mock(async () => true) } as unknown as TTSProvider,
    speaker: { speak: speakMock, stop: stopMock, health: mock(async () => true) } as Speaker,
    summaryMaxTokens: 100,
  };
}

test("speak() summarizes long text then plays via speaker", async () => {
  const deps = makeDeps();
  const svc = new DefaultSpeakService(deps);
  await svc.speak({ text: "x".repeat(500) });
  expect(deps.speaker.speak).toHaveBeenCalledWith("Summary text.");
});

test("speak() skips summarizer when skipSummary is true", async () => {
  const deps = makeDeps();
  const svc = new DefaultSpeakService(deps);
  await svc.speak({ text: "x".repeat(500), skipSummary: true });
  expect(deps.llm.chatCompletion).not.toHaveBeenCalled();
  expect(deps.speaker.speak).toHaveBeenCalledWith("x".repeat(500));
});

test("speak() passes short text through unchanged", async () => {
  const deps = makeDeps();
  const svc = new DefaultSpeakService(deps);
  await svc.speak({ text: "Done." });
  expect(deps.llm.chatCompletion).not.toHaveBeenCalled();
  expect(deps.speaker.speak).toHaveBeenCalledWith("Done.");
});

test("stop() proxies to speaker.stop", async () => {
  const deps = makeDeps();
  const svc = new DefaultSpeakService(deps);
  await svc.stop();
  expect(deps.speaker.stop).toHaveBeenCalled();
});
