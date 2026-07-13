import { afterEach, expect, jest, test } from "bun:test";
import { ActionExecutor } from "../../src/executor";
import type { RuntimeConfig } from "../../src/config";
import type { RouterResult, TerminalAdapter, Brain, Speaker } from "../../src/types";
import type { ContextStore } from "../../src/brain/context-store";
import type { LLMProvider, ChatMessage, LLMCompletionOpts } from "../../src/backends/llm/provider";

// The conversational path now routes through the injected LLMProvider, not a
// hardcoded localhost URL — so a fake provider is all the test needs.
class StreamingFake implements LLMProvider {
  readonly name = "fake-stream";
  lastMessages: ChatMessage[] = [];
  constructor(private chunks: string[]) {}
  async chatCompletion(messages: ChatMessage[]): Promise<string> {
    this.lastMessages = messages;
    return this.chunks.join("");
  }
  async *chatCompletionStream(messages: ChatMessage[]): AsyncGenerator<string> {
    this.lastMessages = messages;
    for (const c of this.chunks) yield c;
  }
  async health(): Promise<boolean> { return true; }
}

class NonStreamingFake implements LLMProvider {
  readonly name = "fake-oneshot";
  lastMessages: ChatMessage[] = [];
  constructor(private full: string) {}
  async chatCompletion(messages: ChatMessage[]): Promise<string> {
    this.lastMessages = messages;
    return this.full;
  }
  async health(): Promise<boolean> { return true; }
}

function makeExecutor(llm: LLMProvider, brain: Partial<Brain> = {}): ActionExecutor {
  const config = { ttsLocalMaxTokens: 150 } as unknown as RuntimeConfig;
  const contextStore = { getRecentTurns: () => [] } as unknown as ContextStore;
  const stub = {} as unknown;
  return new ActionExecutor(config, stub as TerminalAdapter, brain as Brain, stub as Speaker, contextStore, llm);
}

async function drain(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of gen) out.push(s);
  return out;
}

afterEach(() => {
  jest.useRealTimers();
});

const route: RouterResult = {
  intent: "simple_question",
  category: "local-llm",
  params: { query: "hear me" }, // router mangled "Can you hear me?" → "hear me"
  confidence: 0.9,
};

test("streaming path sends the full transcript and yields sentences", async () => {
  const llm = new StreamingFake(["Yes I can ", "hear you. ", "All good."]);
  const exec = makeExecutor(llm);

  const sentences = await drain(exec.executeLocalLLMStreaming(route, "Can you hear me?"));

  expect(sentences).toEqual(["Yes I can hear you.", "All good."]);
  const lastUser = llm.lastMessages.filter((m) => m.role === "user").at(-1);
  expect(lastUser?.content).toBe("Can you hear me?"); // full utterance, not "hear me"
});

test("streaming path preserves answer text after a same-delta <think> block", async () => {
  const llm = new StreamingFake(["<think>reasoning</think>Hello there. How are you?"]);
  const exec = makeExecutor(llm);

  const sentences = await drain(exec.executeLocalLLMStreaming(route, "hi"));

  expect(sentences.join(" ")).not.toContain("reasoning");
  expect(sentences).toEqual(["Hello there.", "How are you?"]);
});

test("streaming path strips <think> tags split at every character boundary", async () => {
  const response = "Before. <think>private reasoning</think>After. Done.";
  const llm = new StreamingFake([...response]);
  const exec = makeExecutor(llm);

  const sentences = await drain(exec.executeLocalLLMStreaming(route, "hi"));

  expect(sentences).toEqual(["Before.", "After.", "Done."]);
});

test("streaming path removes multiple reasoning blocks without joining answers", async () => {
  const llm = new StreamingFake([
    "<think>first secret</think>First answer. ",
    "<think>second secret</think>Second answer.",
  ]);
  const exec = makeExecutor(llm);

  const sentences = await drain(exec.executeLocalLLMStreaming(route, "hi"));

  expect(sentences).toEqual(["First answer.", "Second answer."]);
});

test("streaming path discards an unclosed reasoning block at end of stream", async () => {
  const llm = new StreamingFake(["Visible answer. <think>unfinished secret"]);
  const exec = makeExecutor(llm);

  const sentences = await drain(exec.executeLocalLLMStreaming(route, "hi"));

  expect(sentences).toEqual(["Visible answer."]);
});

test("falls back to a one-shot completion when the provider can't stream", async () => {
  const llm = new NonStreamingFake("Sure thing. Done.");
  const exec = makeExecutor(llm);

  const sentences = await drain(exec.executeLocalLLMStreaming(route, "do the thing"));

  expect(sentences).toEqual(["Sure thing.", "Done."]);
  const lastUser = llm.lastMessages.filter((m) => m.role === "user").at(-1);
  expect(lastUser?.content).toBe("do the thing");
});

test("stream failure before output falls back to brain streaming with the caller signal", async () => {
  const llm: LLMProvider = {
    name: "failing-stream",
    chatCompletion: () => Promise.resolve("unused"),
    health: () => Promise.resolve(true),
    chatCompletionStream: () => (async function* () {
      throw new Error("local stream unavailable");
    })(),
  };
  const controller = new AbortController();
  let forwardedSignal: AbortSignal | undefined;
  const brain: Partial<Brain> = {
    send: () => Promise.resolve("unused"),
    sendStream: (_message, options) => {
      forwardedSignal = options?.signal;
      return (async function* () { yield "Fallback answer. Ready."; })();
    },
  };
  const exec = makeExecutor(llm, brain);

  const sentences = await drain(exec.executeLocalLLMStreaming(route, "help me", controller.signal));

  expect(sentences).toEqual(["Fallback answer.", "Ready."]);
  expect(forwardedSignal).toBe(controller.signal);
});

test("batch failure falls back to brain.send with the caller signal", async () => {
  const llm: LLMProvider = {
    name: "failing-batch",
    chatCompletion: () => Promise.reject(new Error("local batch unavailable")),
    health: () => Promise.resolve(true),
  };
  const controller = new AbortController();
  let forwardedSignal: AbortSignal | undefined;
  const brain: Partial<Brain> = {
    send: (_message, options) => {
      forwardedSignal = options?.signal;
      return Promise.resolve("Batch fallback. Complete.");
    },
  };
  const exec = makeExecutor(llm, brain);

  const sentences = await drain(exec.executeLocalLLMStreaming(route, "help me", controller.signal));

  expect(sentences).toEqual(["Batch fallback.", "Complete."]);
  expect(forwardedSignal).toBe(controller.signal);
});

test("failure after spoken output reports interruption without starting a second answer", async () => {
  let brainCalls = 0;
  const llm: LLMProvider = {
    name: "partial-stream",
    chatCompletion: () => Promise.resolve("unused"),
    health: () => Promise.resolve(true),
    chatCompletionStream: () => (async function* () {
      yield "First sentence. ";
      throw new Error("connection lost");
    })(),
  };
  const brain: Partial<Brain> = {
    send: () => {
      brainCalls++;
      return Promise.resolve("duplicate answer");
    },
    sendStream: () => {
      brainCalls++;
      return (async function* () { yield "duplicate answer"; })();
    },
  };
  const exec = makeExecutor(llm, brain);

  const sentences = await drain(exec.executeLocalLLMStreaming(route, "help me"));

  expect(sentences).toEqual([
    "First sentence.",
    "The local model stopped before it finished.",
  ]);
  expect(brainCalls).toBe(0);
});

test("natural stream completion disarms the deadline before trailing text is consumed", async () => {
  jest.useFakeTimers();
  let signalSeen: AbortSignal | undefined;
  const llm: LLMProvider = {
    name: "completed-stream",
    chatCompletion: () => Promise.resolve("unused"),
    health: () => Promise.resolve(true),
    async *chatCompletionStream(_messages: ChatMessage[], options?: LLMCompletionOpts): AsyncGenerator<string> {
      try {
        signalSeen = options?.signal;
        yield "Complete trailing answer.";
      } catch (error) {
        throw new Error("completed stream test failed", { cause: error });
      }
    },
  };
  const stream = makeExecutor(llm).executeLocalLLMStreaming(route, "help me");

  expect(await stream.next()).toEqual({ value: "Complete trailing answer.", done: false });
  jest.advanceTimersByTime(30_000);

  expect((await stream.next()).done).toBe(true);
  expect(signalSeen?.aborted).toBe(false);
});

test("deadline skips a gracefully aborted trailing fragment and falls back", async () => {
  jest.useFakeTimers();
  let signalSeen: AbortSignal | undefined;
  let markWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
  const llm: LLMProvider = {
    name: "graceful-timeout-stream",
    chatCompletion: () => Promise.resolve("unused"),
    health: () => Promise.resolve(true),
    async *chatCompletionStream(_messages: ChatMessage[], options?: LLMCompletionOpts): AsyncGenerator<string> {
      signalSeen = options?.signal;
      yield "unfinished local answer";
      markWaiting();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      }).catch((error: unknown) => {
        throw new Error("graceful timeout test stream failed", { cause: error });
      });
    },
  };
  const exec = makeExecutor(llm, {
    send: () => Promise.resolve("Fallback answer."),
  });
  const consuming = drain(exec.executeLocalLLMStreaming(route, "help me"));

  await waiting;
  jest.advanceTimersByTime(30_000);

  expect(await consuming).toEqual(["Fallback answer."]);
  expect(signalSeen?.aborted).toBe(true);
});

test("deadline stops a signal-ignoring stream after spoken output", async () => {
  jest.useFakeTimers();
  let markWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
  const llm: LLMProvider = {
    name: "ignores-deadline-stream",
    chatCompletion: () => Promise.resolve("unused"),
    health: () => Promise.resolve(true),
    chatCompletionStream: () => (async function* () {
      yield "First sentence. ";
      markWaiting();
      await new Promise<void>(() => { /* deliberately ignores provider abort */ }).catch((error: unknown) => {
        throw new Error("deadline test stream failed", { cause: error });
      });
    })(),
  };
  let brainCalls = 0;
  const exec = makeExecutor(llm, {
    send: () => {
      brainCalls++;
      return Promise.resolve("must not run");
    },
  });
  const consuming = drain(exec.executeLocalLLMStreaming(route, "help me"));

  await waiting;
  jest.advanceTimersByTime(30_000);

  expect(await consuming).toEqual([
    "First sentence.",
    "The local model stopped before it finished.",
  ]);
  expect(brainCalls).toBe(0);
});

test("deadline also bounds a signal-ignoring batch provider", async () => {
  jest.useFakeTimers();
  let signalSeen: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const llm: LLMProvider = {
    name: "ignores-deadline-batch",
    chatCompletion: (_messages, options) => {
      signalSeen = options?.signal;
      markStarted();
      return new Promise<string>(() => { /* deliberately ignores provider abort */ });
    },
    health: () => Promise.resolve(true),
  };
  const exec = makeExecutor(llm, {
    send: () => Promise.resolve("Batch fallback."),
  });
  const consuming = drain(exec.executeLocalLLMStreaming(route, "help me"));

  await started;
  jest.advanceTimersByTime(30_000);

  expect(await consuming).toEqual(["Batch fallback."]);
  expect(signalSeen?.aborted).toBe(true);
});

test("caller cancellation stops a signal-ignoring stream without fallback", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const llm: LLMProvider = {
    name: "ignores-caller-abort",
    chatCompletion: () => Promise.resolve("unused"),
    health: () => Promise.resolve(true),
    chatCompletionStream: () => (async function* () {
      markStarted();
      await new Promise<void>(() => { /* deliberately ignores provider abort */ }).catch((error: unknown) => {
        throw new Error("caller cancellation test stream failed", { cause: error });
      });
    })(),
  };
  let brainCalls = 0;
  const exec = makeExecutor(llm, {
    send: () => {
      brainCalls++;
      return Promise.resolve("must not run");
    },
  });
  const controller = new AbortController();
  const consuming = drain(exec.executeLocalLLMStreaming(route, "cancel me", controller.signal));

  await started;
  controller.abort("barge-in");

  expect(await consuming).toEqual([]);
  expect(brainCalls).toBe(0);
});

test("caller cancellation aborts an in-flight local model stream", async () => {
  let signalSeen: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const llm: LLMProvider = {
    name: "blocking-stream",
    chatCompletion: () => Promise.resolve("unused"),
    health: () => Promise.resolve(true),
    async *chatCompletionStream(_messages: ChatMessage[], options?: LLMCompletionOpts): AsyncGenerator<string> {
      try {
        signalSeen = options?.signal;
        markStarted();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      } catch (error) {
        throw new Error(`blocking stream test failed: ${(error as Error).message}`, { cause: error });
      }
    },
  };
  let brainCalls = 0;
  const exec = makeExecutor(llm, {
    send: () => {
      brainCalls++;
      return Promise.resolve("must not run");
    },
    sendStream: () => {
      brainCalls++;
      return (async function* () { yield "must not run"; })();
    },
  });
  const controller = new AbortController();
  const consuming = drain(exec.executeLocalLLMStreaming(route, "cancel me", controller.signal));

  await started;
  controller.abort("barge-in");

  expect(await consuming).toEqual([]);
  expect(signalSeen?.aborted).toBe(true);
  expect(brainCalls).toBe(0);
});
