import { test, expect, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { TabInjectBrain } from "../src/brain/tab-inject";
import type { SpawnTabOptions, Tab, TerminalAdapter } from "../src/types";

class RecordingTerminal implements TerminalAdapter {
  spawned: SpawnTabOptions[] = [];
  private spawnedTab: Tab | null = null;

  listTabs(): Promise<Tab[]> {
    return Promise.resolve(this.spawnedTab ? [this.spawnedTab] : []);
  }
  focusTab(): Promise<void> { return Promise.resolve(); }
  sendText(): Promise<void> { return Promise.resolve(); }
  sendKey(): Promise<void> { return Promise.resolve(); }
  getText(): Promise<string> { return Promise.resolve("❯"); }
  spawnTab(opts: SpawnTabOptions): Promise<Tab> {
    this.spawned.push(opts);
    this.spawnedTab = { id: "brain-tab", title: opts.title, is_focused: false };
    return Promise.resolve(this.spawnedTab);
  }
  closeTab(): Promise<void> { return Promise.resolve(); }
  health(): Promise<{ ok: boolean; reason?: string }> {
    return Promise.resolve({ ok: true });
  }
}

async function startWithoutReadinessDelay(brain: TabInjectBrain): Promise<void> {
  const sleep = spyOn(Bun, "sleep").mockResolvedValue();
  try {
    await brain.start();
  } catch (error) {
    throw new Error("TabInjectBrain.start() unexpectedly failed", { cause: error });
  } finally {
    sleep.mockRestore();
  }
}

test("tab-inject.ts has no direct kitty references", () => {
  const src = readFileSync("src/brain/tab-inject.ts", "utf8");
  expect(src.includes('"kitty"')).toBe(false);
  expect(src.includes("kitty @")).toBe(false);
});

test("dedicated tab uses Claude auto permission mode by default", async () => {
  const terminal = new RecordingTerminal();
  const brain = new TabInjectBrain(terminal, "cicero-brain");

  await startWithoutReadinessDelay(brain);

  expect(terminal.spawned).toHaveLength(1);
  expect(terminal.spawned[0]?.command).toBe("claude --permission-mode auto");
});

test("dedicated tab bypasses Claude tool permissions when auto-approve is enabled", async () => {
  const terminal = new RecordingTerminal();
  const brain = new TabInjectBrain(terminal, "cicero-brain", true);

  await startWithoutReadinessDelay(brain);

  expect(terminal.spawned).toHaveLength(1);
  expect(terminal.spawned[0]?.command).toBe("claude --dangerously-skip-permissions");
});
