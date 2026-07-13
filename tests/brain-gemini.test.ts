import { test, expect } from "bun:test";
import { GeminiBrain } from "../src/brain/gemini";

test("GeminiBrain spawns 'gemini' reading prompt from stdin", async () => {
  const brain = new GeminiBrain();
  await brain.start();
  const cfg = (brain as unknown as { config: { binary: string; args: string[]; promptViaStdin?: boolean } }).config;
  expect(cfg.binary).toBe("gemini");
  expect(cfg.promptViaStdin).toBe(true);
  expect(cfg.args).toEqual([]);
});
