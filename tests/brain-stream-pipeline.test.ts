import { test, expect } from "bun:test";
import { canStreamBrain, canNarrateAgent, streamBrainToSpeaker, streamAgentNarration } from "../src/speaker/brain-stream";
import type { Brain, BrainTurnOptions } from "../src/types";
import type { StreamingTTSSpeaker } from "../src/speaker/streaming-tts";

class FakeStreamingBrain implements Partial<Brain> {
  async *sendStream(_message: string): AsyncGenerator<string> {
    yield "Refactored the auth module. ";
    yield "All tests pass.";
  }
}

class FakeNonStreamingBrain implements Partial<Brain> {
  async send(_m: string): Promise<string> { return "x"; }
}

class CapturingSpeaker {
  sentences: string[] = [];
  async speakStream(stream: AsyncIterable<string>): Promise<void> {
    for await (const s of stream) this.sentences.push(s);
  }
}

/** Mimics StreamingTTSSpeaker, which swallows iterator errors to stay resilient. */
class SwallowingSpeaker {
  sentences: string[] = [];
  async speakStream(stream: AsyncIterable<string>): Promise<void> {
    try {
      for await (const s of stream) this.sentences.push(s);
    } catch {
      /* swallowed, like the real speaker does for a single bad sentence */
    }
  }
}

class FailingBrain implements Partial<Brain> {
  async *sendStream(_m: string): AsyncGenerator<string> {
    yield "Working on it. ";
    throw new Error("Claude Code exited with 1: Invalid API key");
  }
}

class FakeNarratingBrain implements Partial<Brain> {
  async *streamProgress(_m: string): AsyncGenerator<string> {
    yield "Running ls. ";
    yield "There are 14 entries.";
  }
}

class FailingNarrator implements Partial<Brain> {
  async *streamProgress(_m: string): AsyncGenerator<string> {
    yield "Working. ";
    throw new Error("Codex CLI exited with 1: boom");
  }
}

test("canStreamBrain detects sendStream support", () => {
  expect(canStreamBrain(new FakeStreamingBrain() as unknown as Brain)).toBe(true);
  expect(canStreamBrain(new FakeNonStreamingBrain() as unknown as Brain)).toBe(false);
});

test("streamBrainToSpeaker segments brain output into sentences", async () => {
  const speaker = new CapturingSpeaker();
  await streamBrainToSpeaker(
    new FakeStreamingBrain() as unknown as Brain,
    speaker as unknown as StreamingTTSSpeaker,
    "summarize the change",
  );
  expect(speaker.sentences).toEqual(["Refactored the auth module.", "All tests pass."]);
});

test("streamBrainToSpeaker rethrows a brain failure even when the speaker swallows it", async () => {
  // Without this, a crashed brain (e.g. claude exiting 1) dies as a silent
  // warning and the daemon never plays its error earcon / graceful notice.
  const speaker = new SwallowingSpeaker();
  await expect(
    streamBrainToSpeaker(
      new FailingBrain() as unknown as Brain,
      speaker as unknown as StreamingTTSSpeaker,
      "do work",
    ),
  ).rejects.toThrow(/Claude Code exited with 1: Invalid API key/);
});

test("canNarrateAgent detects streamProgress support", () => {
  expect(canNarrateAgent(new FakeNarratingBrain() as unknown as Brain)).toBe(true);
  expect(canNarrateAgent(new FakeStreamingBrain() as unknown as Brain)).toBe(false);
});

test("streamAgentNarration speaks the agent's progress narration", async () => {
  const speaker = new CapturingSpeaker();
  await streamAgentNarration(
    new FakeNarratingBrain() as unknown as Brain,
    speaker as unknown as StreamingTTSSpeaker,
    "list files",
  );
  expect(speaker.sentences).toEqual(["Running ls.", "There are 14 entries."]);
});

test("streamAgentNarration rethrows a narration failure even when the speaker swallows it", async () => {
  const speaker = new SwallowingSpeaker();
  await expect(
    streamAgentNarration(
      new FailingNarrator() as unknown as Brain,
      speaker as unknown as StreamingTTSSpeaker,
      "do work",
    ),
  ).rejects.toThrow(/Codex CLI exited with 1: boom/);
});

test("brain and narration streams receive the caller's turn signal", async () => {
  const controller = new AbortController();
  const seen: Array<AbortSignal | undefined> = [];
  const brain = {
    async *sendStream(_message: string, options?: BrainTurnOptions): AsyncGenerator<string> {
      try {
        seen.push(options?.signal);
        yield "Plain answer.";
      } catch (error) {
        throw new Error(`plain signal test failed: ${(error as Error).message}`, { cause: error });
      }
    },
    async *streamProgress(_message: string, options?: BrainTurnOptions): AsyncGenerator<string> {
      try {
        seen.push(options?.signal);
        yield "Working.";
      } catch (error) {
        throw new Error(`narration signal test failed: ${(error as Error).message}`, { cause: error });
      }
    },
  } as unknown as Brain;

  await streamBrainToSpeaker(
    brain,
    new CapturingSpeaker() as unknown as StreamingTTSSpeaker,
    "plain",
    undefined,
    { signal: controller.signal },
  );
  await streamAgentNarration(
    brain,
    new CapturingSpeaker() as unknown as StreamingTTSSpeaker,
    "progress",
    undefined,
    { signal: controller.signal },
  );

  expect(seen).toEqual([controller.signal, controller.signal]);
});

test("a silent narrated agent turn settles when local barge-in aborts it", async () => {
  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const brain = {
    async *streamProgress(_message: string, options?: BrainTurnOptions): AsyncGenerator<string> {
      try {
        markStarted();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      } catch (error) {
        throw new Error(`silent narration cancellation failed: ${(error as Error).message}`, { cause: error });
      }
    },
  } as unknown as Brain;
  const speaking = streamAgentNarration(
    brain,
    new CapturingSpeaker() as unknown as StreamingTTSSpeaker,
    "keep working",
    undefined,
    { signal: controller.signal },
  );

  await started;
  controller.abort("barge-in");

  await expect(speaking).resolves.toBeUndefined();
});
