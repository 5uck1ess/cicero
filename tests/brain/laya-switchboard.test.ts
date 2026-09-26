import { expect, spyOn, test } from "bun:test";
import { createBrain, layaIntentClassifier } from "../../src/brain";
import { classifySwitchboardIntent, intentPrompt, NONE, type IntentClassifier } from "../../src/brain/switchboard-intent";
import { SwitchboardBrain } from "../../src/brain/switchboard";
import type { RuntimeConfig } from "../../src/config";

const roster = { coder: { aliases: ["Rick"] }, reviewer: {} };
const raw = (extra = {}) => JSON.stringify({ intent: "transfer", target: "Rick", request_now: true, confidence: 0.9, ...extra });
const signal = () => new AbortController().signal;

test("structured classifier receives utterance and roster and uses all shared parse rules", async () => {
  const cases = [
    [raw(), { intent: "transfer", target: "coder" }],
    [raw({ target: "Friday" }), NONE],
    [raw({ intent: "callme", target: " Morgan " }), { intent: "callme", target: "morgan" }],
    [raw({ intent: "callme", request_now: false }), { intent: "callme", target: "coder", request_now: false }],
    [raw({ extra: true }), NONE],
    ["not JSON", NONE],
  ] as const;
  for (const [response, expected] of cases) {
    const result = await classifySwitchboardIntent({ structured: async (utterance, lanes, owned) => {
      expect(utterance).toBe("synthetic routing utterance");
      expect(lanes).toBe(roster);
      expect(owned.aborted).toBe(false);
      return response;
    } }, "synthetic routing utterance", roster, signal(), 1500, undefined, ["friday"]);
    expect(result).toMatchObject(expected);
  }
});

test("structured deadline aborts uncooperative work and ignores a late answer", async () => {
  let owned: AbortSignal | undefined;
  let resolve!: (s: string) => void;
  const attempts: unknown[] = [];
  const start = performance.now();
  const result = await classifySwitchboardIntent({ structured: (_utterance, _roster, s) => {
    owned = s;
    return new Promise((done) => { resolve = done; });
  } }, "synthetic request", roster, signal(), 10, (attempt) => attempts.push(attempt));
  expect(result).toEqual(NONE);
  expect(owned?.aborted).toBe(true);
  expect(performance.now() - start).toBeLessThan(500);
  expect(attempts).toEqual([expect.objectContaining({ timedOut: true, failed: false })]);
  resolve(raw());
  await Promise.resolve();
  expect(result).toEqual(NONE);
});

test("structured caller cancellation remains cancellation", async () => {
  const controller = new AbortController();
  let owned: AbortSignal | undefined;
  const task = classifySwitchboardIntent({ structured: async (_utterance, _roster, s) => {
    owned = s;
    controller.abort(new Error("caller stopped"));
    return raw();
  } }, "hi", roster, controller.signal);
  await expect(task).rejects.toThrow("caller stopped");
  expect(owned?.aborted).toBe(true);
});

test("Laya HTTP adapter posts the structured roster and returns the exact response text", async () => {
  const response = ` ${raw()}\n`;
  const owned = signal();
  const mock = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe("http://synthetic.invalid/base/v1/switchboard");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBe(owned);
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init!.body as string)).toEqual({
      utterance: "ask Rick", roster: [{ name: "coder", aliases: ["Rick"] }, { name: "reviewer", aliases: [] }],
    });
    return new Response(response);
  });
  try {
    expect(await layaIntentClassifier("http://synthetic.invalid/base/").structured("ask Rick", roster, owned)).toBe(response);
    expect(mock).toHaveBeenCalledTimes(1);
  } finally { mock.mockRestore(); }
});

test("Laya HTTP adapter preserves all 17 aliases including a long alias", async () => {
  const aliases = Array.from({ length: 17 }, (_, i) => i === 16 ? "a".repeat(200) : "alias-" + i);
  const mock = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    expect(JSON.parse(init!.body as string)).toEqual({
      utterance: "ask coder", roster: [{ name: "coder", aliases }],
    });
    return new Response(raw());
  });
  try {
    await layaIntentClassifier("http://synthetic.invalid").structured("ask coder", { coder: { aliases } }, signal());
    expect(mock).toHaveBeenCalledTimes(1);
  } finally { mock.mockRestore(); }
});

test("Laya HTTP errors and oversized bodies cancel streams without exposing provider text", async () => {
  for (const status of [200, 500]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("synthetic-secret-".repeat(100))); },
      cancel() { cancelled = true; },
    });
    const mock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status }));
    try {
      await expect(layaIntentClassifier("http://synthetic.invalid").structured("hi", roster, signal()))
        .rejects.toThrow("switchboard classifier request failed");
      expect(cancelled).toBe(true);
      expect(mock).toHaveBeenCalledTimes(1);
    } finally { mock.mockRestore(); }
  }
});

test("Laya response streaming remains under the shared deadline and releases on abort", async () => {
  let owned: AbortSignal | undefined;
  let released = false;
  const mock = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    owned = init!.signal as AbortSignal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        owned!.addEventListener("abort", () => {
          released = true;
          controller.error(new Error("aborted"));
        }, { once: true });
      },
    }));
  });
  try {
    expect(await classifySwitchboardIntent(layaIntentClassifier("http://synthetic.invalid"), "hi", roster, signal(), 10)).toEqual(NONE);
    expect(owned?.aborted).toBe(true);
    expect(released).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
  } finally { mock.mockRestore(); }
});

for (const useLaya of [true, false]) {
  test(`createBrain selects ${useLaya ? "Laya" : "the unchanged summarizer prompt"}`, async () => {
    const mock = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const body = JSON.parse(init!.body as string);
      if (useLaya) {
        expect(String(url)).toBe("http://laya.invalid/v1/switchboard");
        expect(body).toEqual({ utterance: "ask Rick", roster: [{ name: "coder", aliases: ["Rick"] }, { name: "reviewer", aliases: [] }] });
        return new Response(raw());
      }
      expect(String(url)).toBe("http://gemma.invalid/v1/chat/completions");
      expect(body.messages).toEqual([{ role: "user", content: intentPrompt("ask Rick", roster) }]);
      expect(body.model).toBe("gemma");
      expect(body.response_format.type).toBe("json_schema");
      return Response.json({ choices: [{ message: { content: raw() } }] });
    });
    try {
      const config = {
        brain: { backend: "acp", lanes: { coder: { aliases: ["Rick"] } } },
        raw: {
          switchboard: useLaya ? { intent_url: "http://laya.invalid" } : undefined,
          web_voice: { tldr: { summarizer_url: "http://gemma.invalid/v1", summarizer_model: "gemma" } },
        },
      } as unknown as RuntimeConfig;
      const brain = createBrain(config);
      expect(brain).toBeInstanceOf(SwitchboardBrain);
      // Inspect the factory's selected classifier without starting an ACP process.
      const classifier = (brain as unknown as { classify: IntentClassifier }).classify;
      expect(await classifySwitchboardIntent(classifier, "ask Rick", roster, signal())).toMatchObject({ intent: "transfer", target: "coder" });
      expect(mock).toHaveBeenCalledTimes(1);
    } finally { mock.mockRestore(); }
  });
}
