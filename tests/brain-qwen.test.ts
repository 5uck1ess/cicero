import { test, expect } from "bun:test";
import { QwenBrain } from "../src/brain/qwen";

test("QwenBrain spawns 'qwen' reading prompt from stdin", async () => {
  const brain = new QwenBrain();
  await brain.start();
  const cfg = (brain as unknown as { config: { binary: string; promptViaStdin?: boolean } }).config;
  expect(cfg.binary).toBe("qwen");
  expect(cfg.promptViaStdin).toBe(true);
});

test("QwenBrain accepts a custom binary override", () => {
  const brain = new QwenBrain("qwen-coder");
  const cfg = (brain as unknown as { config: { binary: string } }).config;
  expect(cfg.binary).toBe("qwen-coder");
});
