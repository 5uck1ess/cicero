import { expect, test } from "bun:test";
import {
  TabInjectBrain,
  type TabInjectTimingOptions,
} from "../../src/brain/tab-inject";
import type { SpawnTabOptions, Tab, TerminalAdapter } from "../../src/types";

const FAST_TIMINGS: Partial<TabInjectTimingOptions> = {
  responseInitialDelayMs: 0,
  responsePollIntervalMs: 1,
  responseMaxWaitMs: 250,
  responseAssumeStartedAfterMs: 0,
  responseStableChecks: 1,
  terminalOperationTimeoutMs: 15,
  interruptSendTimeoutMs: 10,
  interruptSettleTimeoutMs: 30,
  interruptPollIntervalMs: 1,
  interruptStableChecks: 1,
};

function makeAdapter(overrides: Partial<TerminalAdapter> = {}): TerminalAdapter {
  return {
    listTabs: () => Promise.resolve([
      { id: "brain-1", title: "Claude Code", is_focused: false },
    ]),
    focusTab: () => Promise.resolve(),
    sendText: () => Promise.resolve(),
    sendKey: () => Promise.resolve(),
    getText: () => Promise.resolve("❯\n"),
    spawnTab: (_opts: SpawnTabOptions) => Promise.resolve({} as Tab),
    closeTab: () => Promise.resolve(),
    health: () => Promise.resolve({ ok: true }),
    ...overrides,
  };
}

test("aborting a tab-injected turn sends Escape and waits for stable idle", async () => {
  const keys: string[] = [];
  let screen = "Working…";
  let entered!: () => void;
  const wasEntered = new Promise<void>((resolve) => { entered = resolve; });
  const adapter = makeAdapter({
    sendKey: (_tab: string, key: string) => {
      keys.push(key);
      if (key === "enter") entered();
      if (key === "escape") screen = "❯\n";
      return Promise.resolve();
    },
    getText: () => Promise.resolve(screen),
  });
  const brain = new TabInjectBrain(adapter, "Claude", false, FAST_TIMINGS);
  const controller = new AbortController();

  const turn = brain.send("do slow work", { signal: controller.signal });
  await wasEntered;
  controller.abort("barge-in");

  await expect(turn).rejects.toThrow("barge-in");
  expect(keys).toEqual(["enter", "escape"]);
  expect(screen).toBe("❯\n");
});

test("a queued tab turn aborted while waiting rejects promptly without releasing its successor", async () => {
  const messages: string[] = [];
  let screen = "Working…";
  let firstEntered!: () => void;
  let thirdEntered!: () => void;
  const firstWasEntered = new Promise<void>((resolve) => { firstEntered = resolve; });
  const thirdWasEntered = new Promise<void>((resolve) => { thirdEntered = resolve; });
  let enters = 0;
  const adapter = makeAdapter({
    sendText: (_tab: string, text: string) => {
      messages.push(text);
      return Promise.resolve();
    },
    sendKey: (_tab: string, key: string) => {
      if (key === "enter") {
        screen = "Working…";
        enters++;
        if (enters === 1) firstEntered();
        if (enters === 2) thirdEntered();
      } else if (key === "escape") {
        screen = "❯\n";
      }
      return Promise.resolve();
    },
    getText: () => Promise.resolve(screen),
  });
  const brain = new TabInjectBrain(adapter, "Claude", false, FAST_TIMINGS);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const thirdController = new AbortController();

  const first = brain.send("first", { signal: firstController.signal });
  await firstWasEntered;
  const second = brain.send("second", { signal: secondController.signal });
  const third = brain.send("third", { signal: thirdController.signal });
  secondController.abort("superseded in queue");

  await expect(Promise.race([
    second,
    Bun.sleep(100).then(() => { throw new Error("queued abort was not prompt"); }),
  ])).rejects.toThrow("superseded in queue");
  await Bun.sleep(5);
  expect(messages).toEqual(["first"]);

  firstController.abort("release first");
  await expect(first).rejects.toThrow("release first");
  await thirdWasEntered;
  expect(messages).toEqual(["first", "third"]);
  thirdController.abort("finish third");
  await expect(third).rejects.toThrow("finish third");
});

test("a rejected interrupt quarantines the session and blocks later injection", async () => {
  let sends = 0;
  let screen = "Working…";
  let entered!: () => void;
  const wasEntered = new Promise<void>((resolve) => { entered = resolve; });
  const adapter = makeAdapter({
    sendText: () => { sends++; return Promise.resolve(); },
    sendKey: (_tab: string, key: string) => {
      if (key === "enter") {
        entered();
        return Promise.resolve();
      }
      return Promise.reject(new Error("remote key rejected"));
    },
    getText: () => Promise.resolve(screen),
  });
  const brain = new TabInjectBrain(adapter, "Claude", false, FAST_TIMINGS);
  const controller = new AbortController();

  const turn = brain.send("first", { signal: controller.signal });
  await wasEntered;
  controller.abort("stop");
  await expect(turn).rejects.toThrow("quarantined");
  await expect(brain.send("must not inject")).rejects.toThrow("quarantined");
  expect(sends).toBe(1);

  screen = "❯\n";
  expect(await brain.health()).toBe(true);
  await brain.send("recovered");
  expect(sends).toBe(2);
});

test("an interrupt that never reaches idle quarantines the session", async () => {
  let sends = 0;
  let entered!: () => void;
  const wasEntered = new Promise<void>((resolve) => { entered = resolve; });
  const adapter = makeAdapter({
    sendText: () => { sends++; return Promise.resolve(); },
    sendKey: (_tab: string, key: string) => {
      if (key === "enter") entered();
      return Promise.resolve();
    },
    getText: () => Promise.resolve("Working…"),
  });
  const brain = new TabInjectBrain(adapter, "Claude", false, FAST_TIMINGS);
  const controller = new AbortController();

  const turn = brain.send("first", { signal: controller.signal });
  await wasEntered;
  controller.abort("stop");
  await expect(turn).rejects.toThrow("stable idle prompt");
  await expect(brain.send("must not inject")).rejects.toThrow("quarantined");
  expect(sends).toBe(1);
});

test("a hung interrupt key is bounded and quarantines the session", async () => {
  let entered!: () => void;
  const wasEntered = new Promise<void>((resolve) => { entered = resolve; });
  const adapter = makeAdapter({
    sendKey: (_tab: string, key: string) => {
      if (key === "enter") {
        entered();
        return Promise.resolve();
      }
      return new Promise<void>(() => {});
    },
    getText: () => Promise.resolve("Working…"),
  });
  const brain = new TabInjectBrain(adapter, "Claude", false, FAST_TIMINGS);
  const controller = new AbortController();

  const turn = brain.send("first", { signal: controller.signal });
  await wasEntered;
  controller.abort("stop");
  await expect(Promise.race([
    turn,
    Bun.sleep(100).then(() => { throw new Error("hung interrupt was not bounded"); }),
  ])).rejects.toThrow("sending the brain interrupt key timed out");
});

test("a hung idle read is bounded and quarantines the session", async () => {
  let entered!: () => void;
  const wasEntered = new Promise<void>((resolve) => { entered = resolve; });
  let interrupted = false;
  const adapter = makeAdapter({
    sendKey: (_tab: string, key: string) => {
      if (key === "enter") entered();
      if (key === "escape") interrupted = true;
      return Promise.resolve();
    },
    getText: () => interrupted
      ? new Promise<string>(() => {})
      : Promise.resolve("Working…"),
  });
  const brain = new TabInjectBrain(adapter, "Claude", false, FAST_TIMINGS);
  const controller = new AbortController();

  const turn = brain.send("first", { signal: controller.signal });
  await wasEntered;
  controller.abort("stop");
  await expect(Promise.race([
    turn,
    Bun.sleep(100).then(() => { throw new Error("hung idle read was not bounded"); }),
  ])).rejects.toThrow("reading the brain screen after interrupt timed out");
});

test("previous-tab restoration is bounded for a hung custom adapter", async () => {
  let entered!: () => void;
  const wasEntered = new Promise<void>((resolve) => { entered = resolve; });
  let screen = "Working…";
  let focusCalls = 0;
  const adapter = makeAdapter({
    listTabs: () => Promise.resolve([
      { id: "user-1", title: "shell", is_focused: true },
      { id: "brain-1", title: "Claude Code", is_focused: false },
    ]),
    focusTab: () => {
      focusCalls++;
      return new Promise<void>(() => {});
    },
    sendKey: (_tab: string, key: string) => {
      if (key === "enter") entered();
      if (key === "escape") screen = "❯\n";
      return Promise.resolve();
    },
    getText: () => Promise.resolve(screen),
  });
  const brain = new TabInjectBrain(adapter, "Claude", false, FAST_TIMINGS);
  const controller = new AbortController();

  const turn = brain.send("first", { signal: controller.signal });
  await wasEntered;
  controller.abort("stop");
  await expect(Promise.race([
    turn,
    Bun.sleep(100).then(() => { throw new Error("tab restoration was not bounded"); }),
  ])).rejects.toThrow("stop");
  expect(focusCalls).toBe(1);
});

test("aborting final scrollback retrieval rejects instead of returning a stale response", async () => {
  let screenReads = 0;
  let interrupted = false;
  let fullRequested!: () => void;
  let resolveFull!: (text: string) => void;
  const wasFullRequested = new Promise<void>((resolve) => { fullRequested = resolve; });
  const fullText = new Promise<string>((resolve) => { resolveFull = resolve; });
  const adapter = makeAdapter({
    sendKey: (_tab: string, key: string) => {
      if (key === "escape") interrupted = true;
      return Promise.resolve();
    },
    getText: (_tab: string, extent?: "screen" | "all" | "last_cmd_output") => {
      if (extent === "all") {
        fullRequested();
        return fullText;
      }
      if (interrupted) return Promise.resolve("❯\n");
      screenReads++;
      return Promise.resolve(screenReads === 1 ? "Working…" : "Answer\n❯\n");
    },
  });
  const brain = new TabInjectBrain(adapter, "Claude", false, FAST_TIMINGS);
  const controller = new AbortController();

  const turn = brain.send("question", { signal: controller.signal });
  await wasFullRequested;
  controller.abort("superseded at completion");
  resolveFull("question\nStale answer\n❯\n");

  await expect(turn).rejects.toThrow("superseded at completion");
});

test("response timeout throws instead of returning partial terminal text", async () => {
  let screen = "Partial answer that never reached an idle prompt";
  const adapter = makeAdapter({
    sendKey: (_tab: string, key: string) => {
      if (key === "escape") screen = "❯\n";
      return Promise.resolve();
    },
    getText: () => Promise.resolve(screen),
  });
  const responseMaxWaitMs = 10;
  const brain = new TabInjectBrain(adapter, "Claude", false, {
    ...FAST_TIMINGS,
    responseMaxWaitMs,
  });

  await expect(brain.send("question")).rejects.toThrow(
    `Brain response timed out after ${responseMaxWaitMs}ms`,
  );
  expect(screen).toBe("❯\n");
});

test("an already-aborted turn is never injected", async () => {
  let sends = 0;
  const adapter = makeAdapter({
    sendText: () => { sends++; return Promise.resolve(); },
  });
  const brain = new TabInjectBrain(adapter, "Claude", false, FAST_TIMINGS);
  const controller = new AbortController();
  controller.abort("superseded");

  await expect(brain.send("never submit", { signal: controller.signal })).rejects.toThrow("superseded");
  expect(sends).toBe(0);
});

test("stop aborts an active turn before closing its owned tab", async () => {
  const order: string[] = [];
  let screen = "Working…";
  let entered!: () => void;
  const wasEntered = new Promise<void>((resolve) => { entered = resolve; });
  const adapter = makeAdapter({
    sendKey: (_tab: string, key: string) => {
      if (key === "enter") {
        order.push("enter");
        entered();
      }
      if (key === "escape") {
        order.push("escape");
        screen = "❯\n";
      }
      return Promise.resolve();
    },
    getText: () => Promise.resolve(screen),
    closeTab: () => {
      order.push("close");
      return Promise.resolve();
    },
  });
  const brain = new TabInjectBrain(adapter, "Claude", false, FAST_TIMINGS);
  (brain as unknown as { ownedTabId: string | null }).ownedTabId = "brain-1";

  const turn = brain.send("active");
  await wasEntered;
  const stopping = brain.stop();

  await expect(turn).rejects.toThrow("stopping");
  await stopping;
  expect(order).toEqual(["enter", "escape", "close"]);
  expect(await brain.health()).toBe(false);
  await expect(brain.send("after stop")).rejects.toThrow("not accepting");
});

test("stop rejects queued turns and drains them before closing the owned tab", async () => {
  const messages: string[] = [];
  const order: string[] = [];
  let screen = "Working…";
  let entered!: () => void;
  const wasEntered = new Promise<void>((resolve) => { entered = resolve; });
  const adapter = makeAdapter({
    sendText: (_tab: string, text: string) => {
      messages.push(text);
      return Promise.resolve();
    },
    sendKey: (_tab: string, key: string) => {
      if (key === "enter") entered();
      if (key === "escape") {
        order.push("escape");
        screen = "❯\n";
      }
      return Promise.resolve();
    },
    getText: () => Promise.resolve(screen),
    closeTab: () => {
      order.push("close");
      return Promise.resolve();
    },
  });
  const brain = new TabInjectBrain(adapter, "Claude", false, FAST_TIMINGS);
  (brain as unknown as { ownedTabId: string | null }).ownedTabId = "brain-1";

  const active = brain.send("active");
  await wasEntered;
  const queued = brain.send("queued");
  const stopping = brain.stop();

  await expect(queued).rejects.toThrow("stopping");
  await expect(active).rejects.toThrow("stopping");
  await stopping;
  expect(messages).toEqual(["active"]);
  expect(order).toEqual(["escape", "close"]);
});

test("stop clears a drained quarantine for a non-owned tab", async () => {
  let rejectInterrupt = true;
  let screen = "Working…";
  let entered!: () => void;
  const wasEntered = new Promise<void>((resolve) => { entered = resolve; });
  const adapter = makeAdapter({
    sendKey: (_tab: string, key: string) => {
      if (key === "enter") entered();
      if (key === "escape" && rejectInterrupt) {
        return Promise.reject(new Error("remote key rejected"));
      }
      return Promise.resolve();
    },
    getText: (_tab: string, extent?: "screen" | "all" | "last_cmd_output") => {
      if (extent === "all") return Promise.resolve("after stop\nRecovered\n❯\n");
      return Promise.resolve(screen);
    },
  });
  const brain = new TabInjectBrain(adapter, "Claude", false, FAST_TIMINGS);
  const controller = new AbortController();

  const turn = brain.send("first", { signal: controller.signal });
  await wasEntered;
  controller.abort("stop first");
  await expect(turn).rejects.toThrow("quarantined");
  await expect(brain.send("blocked before stop")).rejects.toThrow("quarantined");

  await brain.stop();
  rejectInterrupt = false;
  screen = "Recovered\n❯\n";
  await brain.start();
  await expect(brain.send("after stop")).resolves.toBe("Recovered");
});
