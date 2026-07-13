import { expect, test } from "bun:test";
import { CiceroDaemon } from "../src/daemon";
import { DEFAULT_CONFIG, RuntimeConfig } from "../src/config";
import type { Speaker } from "../src/types";

interface VoiceActionInvoker {
  handleVoiceAction(goal: string, originalText: string, signal: AbortSignal): Promise<void>;
}

test("daemon voice computer-use refuses cloud observations before running the agent", async () => {
  try {
    const raw = structuredClone(DEFAULT_CONFIG);
    raw.llm = { backend: "openai" };
    raw.compute = { allow_cloud: false };

    const spoken: string[] = [];
    const speaker: Speaker = {
      speak(text) {
        spoken.push(text);
        return Promise.resolve();
      },
      stop: () => Promise.resolve(),
      health: () => Promise.resolve(true),
    };
    const daemon = new CiceroDaemon(new RuntimeConfig(raw));
    Object.assign(daemon, { speaker });

    await (daemon as unknown as VoiceActionInvoker).handleVoiceAction(
      "read my project and summarize it",
      "computer, read my project and summarize it",
      new AbortController().signal,
    );

    expect(spoken).toEqual([
      "Computer use is connected to a cloud model. Enable compute dot allow cloud in the config if you want file and command observations sent there.",
    ]);
  } catch (error) {
    throw new Error("daemon compute egress regression failed", { cause: error });
  }
});
