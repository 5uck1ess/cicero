import { expect, test } from "bun:test";
import { CiceroDaemon } from "../src/daemon";

interface VoiceActionHarness {
  handleVoiceAction(goal: string, originalText: string, signal: AbortSignal): Promise<void>;
}

test("voice computer-use carries barge-in cancellation through model planning", async () => {
  try {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    let recorded = false;
    const spoken: string[] = [];
    const daemon = Object.create(CiceroDaemon.prototype) as CiceroDaemon;
    Object.assign(daemon as unknown as Record<string, unknown>, {
      config: {
        ttsEnabled: true,
        llmBackend: { backend: "ollama", host: "127.0.0.1" },
        compute: { allowCloud: false, root: process.cwd(), maxReadBytes: 256 * 1024 },
      },
      providers: {
        llm: {
          chatCompletion(
            _messages: unknown[],
            options?: { signal?: AbortSignal },
          ): Promise<string> {
            received = options?.signal;
            return new Promise<string>((_resolve, reject) => {
              const onAbort = () => reject(options?.signal?.reason);
              options?.signal?.addEventListener("abort", onAbort, { once: true });
              if (options?.signal?.aborted) onAbort();
            });
          },
        },
      },
      conversational: {
        playSound: () => {},
        isActive: () => true,
        listenOnce: () => Promise.resolve("yes"),
      },
      speaker: {
        speak: (text: string) => {
          spoken.push(text);
          return Promise.resolve();
        },
      },
      contextStore: { addTurn: () => { recorded = true; } },
    });

    const running = (daemon as unknown as VoiceActionHarness).handleVoiceAction(
      "run a slow command",
      "computer, run a slow command",
      controller.signal,
    );
    await Bun.sleep(5);
    controller.abort(new Error("barge-in"));
    await running;

    expect(received).toBe(controller.signal);
    expect(recorded).toBe(false);
    expect(spoken).toEqual([]);
  } catch (error) {
    throw new Error("daemon compute cancellation regression failed", { cause: error });
  }
});
