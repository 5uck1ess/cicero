import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { CiceroDaemon, runOperatorChatTurn } from "../src/daemon";
import { ContextStore } from "../src/brain/context-store";
import { ActionExecutor } from "../src/executor";
import { HealthStore } from "../src/health/store";
import { BriefingStatusStore } from "../src/notify/briefing-scheduler";
import { OvernightStore } from "../src/notify/overnight-store";
import type { Brain, BrainTurnOptions, RouterResult } from "../src/types";
import { processWebTurn } from "../src/web-voice/turn";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

interface OperationalDaemonHarness {
  startedAtMs: number | null;
  briefingStatusStore: BriefingStatusStore | null;
  overnightStore: OvernightStore | null;
  kanbanWatcher: { snapshot: () => { asOfMs: number; truncated: boolean; totalTasks: number; tasks: Array<{ id: string; title: string; status: string }> } } | null;
  healthStore: HealthStore | null;
  healthSummary: { status: "ok"; summary: string | null; asOfMs: number } | { status: "unavailable"; asOfMs: number } | null;
  promptScheduler: { snapshot: () => { asOfMs: number; heldCount: number; inFlightCount: number; next: { name: string; at: string; day: "today" } } } | null;
  refreshHealthSummary(): Promise<void>;
  operationalContext(signal?: AbortSignal): Promise<string | null>;
}

test("daemon-produced context reaches a real voice brain invocation with all operational fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-operational-"));
  roots.push(root);
  const now = Date.now();
  const status = new BriefingStatusStore(join(root, "briefing.json"));
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(now));
  await status.claim({
    day, scheduledAt: "08:15", trigger: "scheduled", claimedAt: now - 2_000,
    completedAt: now - 1_000, phase: "delivered", contentSummary: "Morning brief sent with two updates.",
  });
  const overnight = new OvernightStore(join(root, "overnight.json"));
  await overnight.enqueue("Deferred release notification");

  const daemon = new CiceroDaemon({
    notify: { timezone: "UTC", briefing: { at: "08:15", catch_up_minutes: 90 } },
  } as never) as unknown as OperationalDaemonHarness;
  daemon.startedAtMs = now - 75_000;
  daemon.briefingStatusStore = status;
  daemon.overnightStore = overnight;
  daemon.kanbanWatcher = {
    snapshot: () => ({ asOfMs: now, truncated: false, totalTasks: 1, tasks: [{ id: "b1", title: "Parser rollout", status: "blocked" }] }),
  };
  daemon.healthSummary = { status: "ok", summary: "Health log: sleep 8 hours.", asOfMs: now };
  daemon.promptScheduler = {
    snapshot: () => ({
      asOfMs: now, heldCount: 1, inFlightCount: 0,
      next: { name: "next research brief", at: "16:00", day: "today" },
    }),
  };

  let received: string | undefined;
  await processWebTurn(new ArrayBuffer(8), {
    stt: { transcribe: async () => "where is my morning brief?" },
    brain: {
      send: async (_message, options) => {
        received = options?.systemContext;
        return "";
      },
    },
    tts: { generateAudio: async () => new ArrayBuffer(0) },
    operationalContext: (signal) => daemon.operationalContext(signal),
  });

  expect(received).toBeDefined();
  for (const value of [
    "08:15", "delivered", "Morning brief sent", "Deferred release notification",
    "Parser rollout", "next research brief", "Health log", "uptime_seconds",
  ]) expect(received).toContain(value);
});

test("daemon health cache reports unreadable and truly empty stores differently", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-health-status-"));
  roots.push(root);
  const unreadableFile = join(root, "unreadable", "metrics.jsonl");
  const unreadable = new HealthStore(unreadableFile);
  mkdirSync(unreadableFile);
  const daemon = new CiceroDaemon({} as never) as unknown as OperationalDaemonHarness;
  daemon.startedAtMs = Date.now();
  daemon.overnightStore = new OvernightStore(join(root, "overnight.json"));
  daemon.healthStore = unreadable;

  await daemon.refreshHealthSummary();
  expect(daemon.healthSummary?.status).toBe("unavailable");
  expect(await daemon.operationalContext()).toContain('health: "unknown"');

  daemon.healthStore = new HealthStore(join(root, "empty", "metrics.jsonl"));
  await daemon.refreshHealthSummary();
  expect(daemon.healthSummary).toMatchObject({ status: "ok", summary: null });
  expect(await daemon.operationalContext()).toContain('"summary":"no recent entries"');
});

test("Telegram text captures operational context once for the recording brain", async () => {
  const received: Array<BrainTurnOptions | undefined> = [];
  const history: Array<{ user: string; reply: string; lane?: string }> = [];
  let captures = 0;

  const reply = await runOperatorChatTurn("what is happening?", {
    brain: {
      send: async (_text, options) => {
        received.push(options);
        return "Current status.";
      },
      activeLane: () => "ops",
    },
    history: { append: async (turn) => { history.push(turn); } },
    operationalContext: async () => {
      captures += 1;
      return "telegram-operational-state";
    },
  });

  expect(reply).toBe("Current status.");
  expect(captures).toBe(1);
  expect(received).toEqual([{
    signal: undefined,
    systemContext: "telegram-operational-state",
  }]);
  expect(history).toEqual([{
    t: expect.any(Number),
    user: "what is happening?",
    reply: "Current status.",
    lane: "ops",
  }]);
});

test("web /api/chat passes its turn signal and operational context to the recording brain", async () => {
  const controller = new AbortController();
  const received: Array<BrainTurnOptions | undefined> = [];
  let captures = 0;

  await runOperatorChatTurn("give me the status", {
    brain: {
      send: async (_text, options) => {
        received.push(options);
        return "All systems ready.";
      },
    },
    history: { append: async () => {} },
    operationalContext: async (signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      captures += 1;
      return "web-chat-operational-state";
    },
  }, controller.signal);

  expect(captures).toBe(1);
  expect(received).toEqual([{
    signal: controller.signal,
    systemContext: "web-chat-operational-state",
  }]);
});

test("host mic captures once for each brain path and skips a local fast path", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-host-operational-"));
  roots.push(root);
  const config = loadConfig({}, { home: root });
  config.ttsEnabled = false;
  config.brain.thinking_filler = false;
  const daemon = new CiceroDaemon(config);
  const contextStore = new ContextStore();
  const sent: Array<{ mode: "send" | "stream"; options?: BrainTurnOptions }> = [];
  const brain: Brain = {
    start: async () => {},
    stop: async () => {},
    send: async (_text, options) => {
      sent.push({ mode: "send", options });
      return "brain reply";
    },
    streamProgress: async function* (_text, options) {
      sent.push({ mode: "stream", options });
      yield "streamed reply.";
    },
    injectContext: () => {},
    restart: async () => {},
    health: async () => true,
  };
  const executor = new ActionExecutor(
    config,
    {} as never,
    brain,
    {} as never,
    contextStore,
    {} as never,
  );
  let route: RouterResult = {
    intent: "brain_query",
    category: "brain",
    params: {},
    confidence: 1,
  };
  let captures = 0;
  const spoken: string[] = [];
  const state = daemon as unknown as {
    router: { classify: () => Promise<RouterResult> };
    brain: Brain;
    executor: ActionExecutor;
    contextStore: ContextStore;
    conversational: {
      isActive: () => boolean;
      playSound: () => void;
      noteSpoken: (text: string) => void;
    } | null;
    streamingSpeaker: {
      speakStream: (source: AsyncIterable<string>) => Promise<void>;
      getSnapshot: () => { spoken: string[]; pending: string[] };
    } | null;
    operationalContext: (signal?: AbortSignal) => Promise<string | null>;
    handleCommand: (text: string, signal: AbortSignal) => Promise<void>;
  };
  state.router = { classify: async () => ({ ...route }) };
  state.brain = brain;
  state.executor = executor;
  state.contextStore = contextStore;
  state.conversational = null;
  state.streamingSpeaker = null;
  state.operationalContext = async () => `host-operational-state-${++captures}`;

  await state.handleCommand("executor question", new AbortController().signal);
  expect(sent[0]).toMatchObject({
    mode: "send",
    options: { systemContext: "host-operational-state-1" },
  });

  state.conversational = {
    isActive: () => true,
    playSound: () => {},
    noteSpoken: (text) => { spoken.push(text); },
  };
  state.streamingSpeaker = {
    speakStream: async (source) => {
      for await (const sentence of source) spoken.push(sentence);
    },
    getSnapshot: () => ({ spoken: [...spoken], pending: [] }),
  };
  await state.handleCommand("streaming question", new AbortController().signal);
  expect(sent[1]).toMatchObject({
    mode: "stream",
    options: { systemContext: "host-operational-state-2" },
  });

  route = { intent: "help", category: "local", params: {}, confidence: 1 };
  await state.handleCommand("help", new AbortController().signal);
  expect(captures).toBe(2);
  expect(sent).toHaveLength(2);
});

test("a Telegram/shell health log lands in the daemon store and refreshes the cached summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-hlog-"));
  roots.push(root);
  const daemon = new CiceroDaemon({} as never) as unknown as OperationalDaemonHarness & {
    logHealthAndRefresh(metric: string, words: string[]): Promise<string>;
  };
  daemon.startedAtMs = Date.now();
  daemon.healthStore = new HealthStore(join(root, "metrics.jsonl"));
  // A stale cache from an earlier refresh — the snapshot would report this until
  // the 60s timer runs, unless the log path refreshes it.
  daemon.healthSummary = { status: "ok", summary: "STALE — before the log", asOfMs: Date.now() - 120_000 };

  const ack = await daemon.logHealthAndRefresh("weight", ["82.4", "kg"]);
  expect(ack).toContain("82.4");
  // The entry went through the daemon's OWN store (not a bypass instance)...
  expect((await daemon.healthStore!.recent(1))[0]?.value).toBe(82.4);
  // ...and the cached summary was refreshed from it, no longer stale.
  expect(daemon.healthSummary?.status).toBe("ok");
  expect(daemon.healthSummary?.summary).not.toBe("STALE — before the log");
});
