import { expect, test } from "bun:test";
import type { Client, SessionNotification } from "@agentclientprotocol/sdk";
import type { Brain } from "../../src/types";
import { AcpBrain } from "../../src/brain/acp";
import { SwitchboardBrain } from "../../src/brain/switchboard";
import { hasPendingOneShotContext } from "../../src/brain/capabilities";
import { QuickIntentsBrain } from "../../src/brain/quick-intents";
import { DialBackBrain } from "../../src/brain/dial-back";
import { RoutingBrain } from "../../src/brain/routing";
import { FallbackBrain } from "../../src/brain/fallback";
import { OllamaBrain } from "../../src/brain/ollama";
import { OpenAiCompatibleBrain } from "../../src/brain/openai-compatible";

const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const verdict = (intent: string) => JSON.stringify({ intent, target: null, request_now: true, confidence: 0.95 });
const front: Brain = {
  start: async () => {}, stop: async () => {}, restart: async () => {}, health: async () => true,
  send: async () => "front", injectContext: () => {},
};

// Real ACP prompt construction and context consumption; only the transport is fake.
function lane() {
  const brain = new AcpBrain({ binary: "unused" });
  const prompts: string[] = [];
  let client: Pick<Client, "sessionUpdate">;
  const runtime = {
    generation: 1, sessionId: "session", sessionIdentity: null, stopping: false, activeTurn: null,
    stopped: new Promise<void>(() => {}),
    conn: {
      prompt: async (request: { prompt: Array<{ text?: string }> }) => {
        prompts.push(request.prompt.map((part) => part.text ?? "").join(""));
        await client.sessionUpdate({ sessionId: "session", update: {
          sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lane reply" },
        } satisfies SessionNotification["update"] });
        return { stopReason: "end_turn" };
      },
      cancel: async () => {},
    },
  };
  const state = brain as unknown as { runtime: typeof runtime; makeClient: (r: typeof runtime) => typeof client };
  state.runtime = runtime;
  client = state.makeClient(runtime);
  brain.start = async () => {};
  return { brain, prompts };
}

for (const item of ["cold persona", "handoff briefing"]) {
  test(`${item} survives model release and reaches the next real ACP turn exactly once`, async () => {
    const { brain, prompts } = lane();
    const context = `synthetic ${item} unique marker`;
    let intent = "release";
    const sb = new SwitchboardBrain(front, { coder: { brain, ...(item === "cold persona" ? { persona: context } : {}) } }, async () => verdict(intent));
    await sb.transferTo("coder", item === "handoff briefing" ? async () => context : undefined);
    expect(hasPendingOneShotContext(brain)).toBe(true);
    expect(await sb.send("I'm finished talking to this colleague")).toBe("Back with you.");
    expect(prompts).toEqual([]);
    expect(hasPendingOneShotContext(brain)).toBe(true);
    await sb.transferTo("coder");
    intent = "none";
    expect(await sb.send("describe the implementation")).toBe("lane reply");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.split(context)).toHaveLength(2);
    expect(hasPendingOneShotContext(brain)).toBe(false);
    await sb.send("continue the explanation");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain(context);
  });
}

test("a wrapper that drops the predicate classifies first even if it can hold output", async () => {
  let resolve!: (s: string) => void;
  let calls = 0;
  const wrapper: Brain = { ...front, canHoldIntentOutput: () => true, send: async () => { calls++; return "only response"; } };
  const sb = new SwitchboardBrain(wrapper, {}, () => new Promise<string>((r) => { resolve = r; }));
  const response = sb.send("ordinary words");
  await flush();
  expect(calls).toBe(0);
  resolve(verdict("none"));
  expect(await response).toBe("only response");
  expect(calls).toBe(1);
});

test("wrappers propagate pending context and fail closed on unknown destinations", () => {
  for (const wrap of [
    (b: Brain) => new QuickIntentsBrain(b, []), (b: Brain) => new DialBackBrain(b),
    (b: Brain) => new RoutingBrain(b, b), (b: Brain) => new FallbackBrain([b], "test"),
  ]) {
    const { brain } = lane();
    const wrapper = wrap(brain);
    expect(hasPendingOneShotContext(wrapper)).toBe(false);
    wrapper.injectContext("pending briefing");
    expect(hasPendingOneShotContext(wrapper)).toBe(true);
    expect(hasPendingOneShotContext(wrap(front))).toBe(true);
  }
  expect(hasPendingOneShotContext({ ...front, hasPendingOneShotContext: () => { throw new Error("probe failed"); } })).toBe(true);
});

test("text adapters expose their pending prompt injections", () => {
  for (const brain of [new OllamaBrain(), new OpenAiCompatibleBrain({ backend: "openai" })]) {
    expect(hasPendingOneShotContext(brain)).toBe(false);
    brain.injectContext("next-turn context");
    expect(hasPendingOneShotContext(brain)).toBe(true);
  }
});

test("ACP pending confirmation and one-use approval each prevent a held turn", () => {
  const { brain } = lane();
  const state = brain as unknown as { pendingConfirmation: object | null; confirmationGrant: object | null };
  state.pendingConfirmation = {};
  expect(hasPendingOneShotContext(brain)).toBe(true);
  state.pendingConfirmation = null;
  state.confirmationGrant = {};
  expect(hasPendingOneShotContext(brain)).toBe(true);
  state.confirmationGrant = null;
  expect(hasPendingOneShotContext(brain)).toBe(false);
});
