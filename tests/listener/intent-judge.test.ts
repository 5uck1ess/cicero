import { describe, expect, test } from "bun:test";
import {
  buildJudgePrompt,
  createIntentJudge,
  parseVerdict,
  type IntentJudgeInput,
} from "../../src/listener/intent-judge";
import type { ChatMessage, LLMCompletionOpts, LLMProvider } from "../../src/backends/llm/provider";
import { ConversationalListener } from "../../src/listener/conversational";
import { DEFAULT_CONFIG, RuntimeConfig } from "../../src/config";
import { validateRuntimeConfig } from "../../src/config-validation";

/** A classifier stand-in that answers with whatever the test provides. */
function fakeClassifier(
  answer: string | (() => Promise<string>),
  seen?: { messages: ChatMessage[][]; opts: (LLMCompletionOpts | undefined)[] },
): LLMProvider {
  return {
    name: "fake-classifier",
    chatCompletion: (messages, opts) => {
      seen?.messages.push(messages);
      seen?.opts.push(opts);
      return typeof answer === "string" ? Promise.resolve(answer) : answer();
    },
    health: () => Promise.resolve(true),
  };
}

const input = (over: Partial<IntentJudgeInput> = {}): IntentJudgeInput => ({
  utterance: "open the deploy log",
  recentUtterances: [],
  recentAssistantSpeech: [],
  msSinceAssistantSpoke: null,
  ...over,
});

describe("verdict parsing", () => {
  // Model output is untrusted input; anything not exactly a verdict is no opinion.
  const rejected: Array<[string, string]> = [
    ["prose with no JSON", "I think it was directed at you"],
    ["missing confidence", '{"directed": true}'],
    ["missing directed", '{"confidence": 0.9}'],
    ["directed as a string", '{"directed": "true", "confidence": 0.9}'],
    ["confidence above 1", '{"directed": false, "confidence": 1.4}'],
    ["negative confidence", '{"directed": false, "confidence": -0.1}'],
    ["confidence NaN", '{"directed": false, "confidence": null}'],
    ["broken JSON", '{"directed": false, "confidence":}'],
    ["empty", ""],
    ["an array", '[{"directed": true, "confidence": 1}]'],
  ];
  for (const [name, raw] of rejected) {
    test(`rejects ${name}`, () => {
      expect(parseVerdict(raw)).toBeNull();
    });
  }

  test("accepts a well-formed verdict", () => {
    expect(parseVerdict('{"directed": false, "confidence": 0.82}')).toEqual({ directed: false, confidence: 0.82 });
  });

  // Small models wrap JSON in prose or a code fence constantly.
  test("accepts a verdict wrapped in prose or a code fence", () => {
    expect(parseVerdict('Sure!\n```json\n{"directed": true, "confidence": 0.7}\n```')).toEqual({
      directed: true,
      confidence: 0.7,
    });
  });

  test("refuses an enormous reply rather than parsing it", () => {
    expect(parseVerdict(`{"directed": true, "confidence": 1}${" ".repeat(5_000)}`)).toBeNull();
  });
});

describe("the prompt", () => {
  test("carries the utterance, the room, and what the assistant said", () => {
    const messages = buildJudgePrompt(
      input({
        utterance: "yeah, do that",
        recentUtterances: ["did you see the game", "no idea"],
        recentAssistantSpeech: ["Should I redeploy the staging box?"],
      }),
      4,
    );
    const text = messages[0]!.content;
    expect(text).toContain("yeah, do that");
    expect(text).toContain("did you see the game");
    expect(text).toContain("Should I redeploy the staging box?");
  });

  test("bounds each line and the utterance", () => {
    const messages = buildJudgePrompt(
      input({ utterance: "x".repeat(5_000), recentUtterances: ["y".repeat(5_000)] }),
      4,
    );
    expect(messages[0]!.content.length).toBeLessThan(2_000);
  });

  test("shows only the most recent context turns", () => {
    const messages = buildJudgePrompt(
      input({ recentUtterances: ["oldest", "middle", "newer", "newest"] }),
      2,
    );
    expect(messages[0]!.content).not.toContain("oldest");
    expect(messages[0]!.content).toContain("newest");
  });
});

describe("the judge as a veto", () => {
  test("there is no judge without a classifier — it never borrows another model", () => {
    expect(createIntentJudge(undefined)).toBeNull();
  });

  test("declines a confidently undirected utterance", async () => {
    const judge = createIntentJudge(fakeClassifier('{"directed": false, "confidence": 0.95}'))!;
    const decision = await judge.decide(input());
    expect(decision.accept).toBe(false);
    expect(decision.reason).toBe("judged-undirected");
  });

  test("accepts a directed utterance", async () => {
    const judge = createIntentJudge(fakeClassifier('{"directed": true, "confidence": 0.9}'))!;
    expect((await judge.decide(input())).accept).toBe(true);
  });

  // Being deaf is worse than being eager: an unsure "no" must not decline.
  test("an unconfident no does not decline the turn", async () => {
    const judge = createIntentJudge(fakeClassifier('{"directed": false, "confidence": 0.2}'), { minConfidence: 0.6 })!;
    const decision = await judge.decide(input());
    expect(decision.accept).toBe(true);
    expect(decision.reason).toBe("low-confidence");
  });

  // Every failure path must end in today's behavior, never in silence.
  const failures: Array<[string, () => Promise<string>]> = [
    ["the model is down", () => Promise.reject(new Error("connection refused"))],
    ["the model returns nonsense", () => Promise.resolve("who knows honestly")],
    ["the model returns nothing", () => Promise.resolve("")],
  ];
  for (const [name, answer] of failures) {
    test(`accepts the turn when ${name}`, async () => {
      const judge = createIntentJudge(fakeClassifier(answer))!;
      const decision = await judge.decide(input());
      expect(decision.accept).toBe(true);
      expect(decision.reason).toBe("unavailable");
    });
  }

  test("a slow model is abandoned at the deadline and the turn is accepted", async () => {
    const judge = createIntentJudge(
      fakeClassifier(() => new Promise<string>(() => { /* never settles */ })),
      { timeoutMs: 20 },
    )!;
    const decision = await judge.decide(input());
    expect(decision.accept).toBe(true);
    expect(decision.reason).toBe("unavailable");
  });

  test("the caller's abort also releases the decision", async () => {
    const judge = createIntentJudge(
      fakeClassifier(() => new Promise<string>(() => { /* never settles */ })),
      { timeoutMs: 60_000 },
    )!;
    const controller = new AbortController();
    const pending = judge.decide(input(), controller.signal);
    controller.abort();
    expect((await pending).accept).toBe(true);
  });
});

describe("the hot window", () => {
  // A direct reply to Cicero's own question is what a judge most often gets
  // wrong, and what we are surest about.
  test("a follow-up just after the assistant spoke skips the model entirely", async () => {
    let calls = 0;
    const judge = createIntentJudge(
      {
        name: "counting",
        chatCompletion: () => { calls += 1; return Promise.resolve('{"directed": false, "confidence": 1}'); },
        health: () => Promise.resolve(true),
      },
      { hotWindowMs: 15_000 },
    )!;
    const decision = await judge.decide(input({ utterance: "yeah", msSinceAssistantSpoke: 1_200 }));
    expect(decision).toEqual({ accept: true, reason: "hot-window" });
    expect(calls).toBe(0);
  });

  test("it decays — past the window the model is consulted again", async () => {
    let calls = 0;
    const judge = createIntentJudge(
      {
        name: "counting",
        chatCompletion: () => { calls += 1; return Promise.resolve('{"directed": false, "confidence": 0.95}'); },
        health: () => Promise.resolve(true),
      },
      { hotWindowMs: 15_000 },
    )!;
    const decision = await judge.decide(input({ msSinceAssistantSpoke: 60_000 }));
    expect(calls).toBe(1);
    expect(decision.accept).toBe(false);
  });

  test("it does not apply before the assistant has ever spoken", async () => {
    let calls = 0;
    const judge = createIntentJudge({
      name: "counting",
      chatCompletion: () => { calls += 1; return Promise.resolve('{"directed": true, "confidence": 0.9}'); },
      health: () => Promise.resolve(true),
    })!;
    await judge.decide(input({ msSinceAssistantSpoke: null }));
    expect(calls).toBe(1);
  });
});

describe("the request", () => {
  test("asks for a bounded, deterministic, schema-constrained answer", async () => {
    const seen = { messages: [] as ChatMessage[][], opts: [] as (LLMCompletionOpts | undefined)[] };
    const judge = createIntentJudge(fakeClassifier('{"directed": true, "confidence": 1}', seen))!;
    await judge.decide(input());
    const opts = seen.opts[0]!;
    expect(opts.temperature).toBe(0);
    expect(opts.max_tokens).toBeLessThanOrEqual(32);
    expect(opts.responseFormat?.type).toBe("json_schema");
    expect(opts.signal).toBeDefined();
  });
});

describe("listener integration", () => {
  /** Reach the private state the listener keeps for the judge. */
  type Inner = {
    intentJudge: unknown;
    recentAssistantSpeech: string[];
    lastSpokeAtMs: number | null;
  };

  function listener(): ConversationalListener & Inner {
    return new ConversationalListener(
      { name: "stt", transcribe: () => Promise.resolve(null), health: () => Promise.resolve(true) } as never,
      {} as never,
      {} as never,
    ) as ConversationalListener & Inner;
  }

  test("there is no judge until one is set", () => {
    expect(listener().intentJudge).toBeNull();
  });

  test("noteSpoken records what Cicero said, for the judge's context", () => {
    const l = listener();
    l.noteSpoken("Should I redeploy staging?");
    expect(l.recentAssistantSpeech).toEqual(["Should I redeploy staging?"]);
    expect(l.lastSpokeAtMs).not.toBeNull();
  });

  // Captured room audio must not accumulate in memory.
  test("the assistant-speech ring is bounded in both length and line size", () => {
    const l = listener();
    for (let i = 0; i < 50; i += 1) l.noteSpoken(`line ${i} `.padEnd(5_000, "x"));
    expect(l.recentAssistantSpeech.length).toBeLessThanOrEqual(6);
    for (const line of l.recentAssistantSpeech) expect(line.length).toBeLessThanOrEqual(300);
  });

  test("blank speech is not recorded and does not open a hot window", () => {
    const l = listener();
    l.noteSpoken("   ");
    expect(l.recentAssistantSpeech).toEqual([]);
    expect(l.lastSpokeAtMs).toBeNull();
  });

  test("setIntentJudge(null) takes it back off", () => {
    const l = listener();
    l.setIntentJudge(createIntentJudge(fakeClassifier('{"directed": true, "confidence": 1}')));
    expect(l.intentJudge).not.toBeNull();
    l.setIntentJudge(null);
    expect(l.intentJudge).toBeNull();
  });
});

describe("intent judge configuration", () => {
  function issuesFor(section: unknown): string[] {
    const config = structuredClone(DEFAULT_CONFIG) as Record<string, unknown>;
    config.intent_judge = section;
    try {
      validateRuntimeConfig(config, "test config");
      return [];
    } catch (error) {
      return String((error as Error).message).split("\n");
    }
  }

  test("is off by default", () => {
    expect(new RuntimeConfig(structuredClone(DEFAULT_CONFIG)).intentJudge.enabled).toBe(false);
  });

  test("defaults are applied for anything not set", () => {
    const resolved = new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      intent_judge: { enabled: true },
    }).intentJudge;
    expect(resolved).toEqual({
      enabled: true,
      hotWindowMs: 15_000,
      minConfidence: 0.6,
      contextTurns: 4,
      timeoutMs: 1_500,
    });
  });

  test("a well-formed section is accepted", () => {
    expect(issuesFor({ enabled: true, hot_window_ms: 8_000, min_confidence: 0.75 })).toEqual([]);
  });

  test("an unknown key is rejected", () => {
    expect(issuesFor({ enabled: true, hot_windows_ms: 8_000 }).some((i) => i.includes("hot_windows_ms"))).toBe(true);
  });

  test("a confidence outside 0..1 is rejected", () => {
    expect(issuesFor({ min_confidence: 1.5 }).some((i) => i.includes("intent_judge.min_confidence"))).toBe(true);
  });

  test("a zero timeout is rejected", () => {
    expect(issuesFor({ timeout_ms: 0 }).some((i) => i.includes("intent_judge.timeout_ms"))).toBe(true);
  });
});
