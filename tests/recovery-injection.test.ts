import { test, expect } from "bun:test";
import { buildRecoveryContext } from "../src/speaker/recovery";
import type { Brain } from "../src/types";

class FakeBrain implements Partial<Brain> {
  lastContext = "";
  injectContext(ctx: string): void { this.lastContext = ctx; }
}

test("a snapshot interjection produces an injected recovery context", () => {
  const brain = new FakeBrain();
  const snapshot = { spoken: ["I refactored the auth module."], pending: [] as string[] };
  const interjection = "wait, use JWT";
  brain.injectContext(buildRecoveryContext({ spoken: snapshot.spoken, interjection }));
  expect(brain.lastContext).toContain("I refactored the auth module.");
  expect(brain.lastContext).toContain("wait, use JWT");
});
