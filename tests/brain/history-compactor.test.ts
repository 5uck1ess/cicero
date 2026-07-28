import { afterEach, describe, expect, test } from "bun:test";
import { createHistoryCompactor, createSummarizerComplete } from "../../src/brain/history-compactor";
import { BrainTurnContext, setDefaultHistoryCompactor } from "../../src/brain/turn-context";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Capture the outbound request and answer with a fixed completion. */
function stubSummarizer(reply: string | { status: number }): { requests: { url: string; body: any }[] } {
  const requests: { url: string; body: any }[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    if (typeof reply !== "string") {
      return new Response("upstream detail", { status: reply.status });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { requests };
}

describe("summarizer client", () => {
  test("no URL means no client — the feature is simply off", () => {
    expect(createSummarizerComplete(undefined)).toBeUndefined();
    expect(createSummarizerComplete({})).toBeUndefined();
    expect(createHistoryCompactor({})).toBeUndefined();
  });

  test("posts to the chat-completions path with the configured model", async () => {
    const { requests } = stubSummarizer("a line");
    const complete = createSummarizerComplete({ summarizer_url: "http://x:1/v1/", summarizer_model: "small" })!;
    expect(await complete("hello", 40)).toBe("a line");
    expect(requests[0]!.url).toBe("http://x:1/v1/chat/completions");
    expect(requests[0]!.body.model).toBe("small");
    expect(requests[0]!.body.max_tokens).toBe(40);
  });

  // The URL can carry credentials; only the status is safe to put in an error.
  test("an error surfaces the status, never the URL or the response body", async () => {
    stubSummarizer({ status: 401 });
    const complete = createSummarizerComplete({ summarizer_url: "http://user:hunter2@x:1/v1" })!;
    await expect(complete("hello", 40)).rejects.toThrow(/^summarizer 401$/);
  });

  test("an empty completion is an error, not an empty summary", async () => {
    stubSummarizer("   ");
    const complete = createSummarizerComplete({ summarizer_url: "http://x:1/v1" })!;
    await expect(complete("hello", 40)).rejects.toThrow(/returned nothing/);
  });
});

describe("history compactor", () => {
  test("sends the retired turns and folds in the previous summary", async () => {
    const { requests } = stubSummarizer("folded summary");
    const compactor = createHistoryCompactor({ summarizer_url: "http://x:1/v1" })!;
    const out = await compactor(
      { turns: [{ user: "where is the config", assistant: "in config.yaml" }], previousSummary: "earlier: they set up TTS" },
      new AbortController().signal,
    );
    expect(out).toBe("folded summary");
    const prompt: string = requests[0]!.body.messages[0].content;
    expect(prompt).toContain("where is the config");
    expect(prompt).toContain("in config.yaml");
    expect(prompt).toContain("earlier: they set up TTS");
    // It must fold, not stack — the instruction has to say so.
    expect(prompt).toContain("do not simply append");
  });

  test("with no previous summary the fold instruction is omitted", async () => {
    const { requests } = stubSummarizer("s");
    const compactor = createHistoryCompactor({ summarizer_url: "http://x:1/v1" })!;
    await compactor({ turns: [{ user: "u", assistant: "a" }], previousSummary: null }, new AbortController().signal);
    expect(requests[0]!.body.messages[0].content).not.toContain("do not simply append");
  });

  test("the prompt is bounded even when the turns are enormous", async () => {
    const { requests } = stubSummarizer("s");
    const compactor = createHistoryCompactor({ summarizer_url: "http://x:1/v1" })!;
    await compactor(
      { turns: [{ user: "x".repeat(100_000), assistant: "y".repeat(100_000) }], previousSummary: null },
      new AbortController().signal,
    );
    const prompt: string = requests[0]!.body.messages[0].content;
    expect(prompt.length).toBeLessThan(25_000);
    expect(prompt).toContain("[excerpt truncated]");
  });

  test("the caller's abort signal cancels the request", async () => {
    globalThis.fetch = ((_input: any, init?: any) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const compactor = createHistoryCompactor({ summarizer_url: "http://x:1/v1" })!;
    const controller = new AbortController();
    const pending = compactor({ turns: [{ user: "u", assistant: "a" }], previousSummary: null }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("process-wide registration", () => {
  test("a context with no compactor of its own uses the registered default", async () => {
    stubSummarizer("the registered default ran");
    const release = setDefaultHistoryCompactor(createHistoryCompactor({ summarizer_url: "http://x:1/v1" })!);
    try {
      const ctx = new BrainTurnContext();
      for (let i = 0; i < 13; i += 1) ctx.remember(`q${i}`, `a${i}`);
      await ctx.settled();
      expect(ctx.buildTextPrompt("now", true)).toContain("the registered default ran");
    } finally {
      release();
    }
  });

  test("releasing restores plain eviction for contexts created afterwards", async () => {
    stubSummarizer("should not appear");
    setDefaultHistoryCompactor(createHistoryCompactor({ summarizer_url: "http://x:1/v1" })!)();
    const ctx = new BrainTurnContext();
    for (let i = 0; i < 20; i += 1) ctx.remember(`q${i}`, `a${i}`);
    await ctx.settled();
    const text = ctx.buildTextPrompt("now", true);
    expect(text).not.toContain("should not appear");
    expect(text).not.toContain("q0");
  });

  // An explicit off must not silently fall back to the process-wide default.
  test("setCompactor(null) turns compaction off for that context", async () => {
    stubSummarizer("default summary");
    const release = setDefaultHistoryCompactor(createHistoryCompactor({ summarizer_url: "http://x:1/v1" })!);
    try {
      const ctx = new BrainTurnContext();
      ctx.setCompactor(null);
      for (let i = 0; i < 20; i += 1) ctx.remember(`q${i}`, `a${i}`);
      await ctx.settled();
      const text = ctx.buildTextPrompt("now", true);
      expect(text).not.toContain("default summary");
      expect(text).not.toContain("q0");
    } finally {
      release();
    }
  });

  // An instance compactor is the explicit choice and must win.
  test("an explicit per-context compactor overrides the default", async () => {
    stubSummarizer("default summary");
    const release = setDefaultHistoryCompactor(createHistoryCompactor({ summarizer_url: "http://x:1/v1" })!);
    try {
      const ctx = new BrainTurnContext();
      ctx.setCompactor(async () => "instance summary");
      for (let i = 0; i < 13; i += 1) ctx.remember(`q${i}`, `a${i}`);
      await ctx.settled();
      const text = ctx.buildTextPrompt("now", true);
      expect(text).toContain("instance summary");
      expect(text).not.toContain("default summary");
    } finally {
      release();
    }
  });
});
