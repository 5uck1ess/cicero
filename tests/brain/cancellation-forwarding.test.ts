import { test, expect } from "bun:test";
import type { Brain, BrainTurnOptions } from "../../src/types";
import { QuickIntentsBrain } from "../../src/brain/quick-intents";
import { RoutingBrain } from "../../src/brain/routing";
import { FallbackBrain } from "../../src/brain/fallback";
import { SwitchboardBrain } from "../../src/brain/switchboard";

function recordingBrain(seen: Array<AbortSignal | undefined>): Brain {
  return {
    async start() {},
    async stop() {},
    async send(_message: string, options?: BrainTurnOptions) {
      seen.push(options?.signal);
      return "ok";
    },
    async *sendStream(_message: string, options?: BrainTurnOptions) {
      seen.push(options?.signal);
      yield "ok";
    },
    injectContext() {},
    async restart() {},
    async health() { return true; },
  };
}

async function drain(source: AsyncIterable<string>): Promise<void> {
  for await (const chunk of source) void chunk;
}

async function assertForwards(makeWrapper: (inner: Brain) => Brain): Promise<void> {
  const seen: Array<AbortSignal | undefined> = [];
  const wrapper = makeWrapper(recordingBrain(seen));
  await wrapper.start();
  const controller = new AbortController();
  const options = { signal: controller.signal };
  await wrapper.send("ordinary request", options);
  await drain(wrapper.sendStream!("ordinary request", options));
  expect(seen).toEqual([controller.signal, controller.signal]);
  await wrapper.stop();
}

test("brain wrappers preserve per-turn cancellation signals", async () => {
  await assertForwards((inner) => new QuickIntentsBrain(inner, []));
  await assertForwards((inner) => new RoutingBrain(inner, recordingBrain([])));
  await assertForwards((inner) => new FallbackBrain([inner], "primary"));
  await assertForwards((inner) => new SwitchboardBrain(inner, {}));
});
