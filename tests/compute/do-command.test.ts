import { test, expect } from "bun:test";
import { runDo } from "../../src/compute";

test("runDo drives the agent with an injected llm + auto-confirm and returns the summary", async () => {
  const llm = (() => {
    const steps = [
      '{"thought":"finish","action":{"tool":"finish","args":{"summary":"nothing to do"}}}',
    ];
    let i = 0;
    return { async chatCompletion() { return steps[Math.min(i++, steps.length - 1)]; } };
  })();

  const result = await runDo("say hi", { llm, confirm: async () => true });
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("nothing to do");
});
