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
  kanbanWatcher: {
    snapshot: () => { asOfMs: number; truncated: boolean; totalTasks: number; tasks: Array<{ id: string; title: string; status: string }> } | null;
    tick?: () => Promise<void>;
    stop?: () => Promise<void>;
    start?: () => void;
    readonly polling?: boolean;
  } | null;
  healthStore: HealthStore | null;
  promptScheduler: { snapshot: () => { asOfMs: number; heldCount: number; inFlightCount: number; next: { name: string; at: string; day: "today" } } } | null;
  initializeOperationalState(): HealthStore;
  startBoardPollingIfPending(): void;
  snapshotKnownSecrets(): string[];
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
  daemon.healthStore = new HealthStore(join(root, "metrics.jsonl"));
  await daemon.healthStore.append({
    t: now, metric: "sleep", value: 8, unit: "hours", source: "cli",
  });
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

test("daemon operational context redacts its configured web voice token", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-operational-secret-"));
  roots.push(root);
  const token = "test-token-that-is-long-enough";
  const now = Date.now();
  const config = loadConfig({}, { home: root });
  config.raw.web_voice = { enabled: true, token };
  const daemon = new CiceroDaemon(config) as unknown as OperationalDaemonHarness;
  daemon.startedAtMs = now;
  daemon.overnightStore = new OvernightStore(join(root, "overnight.json"));
  daemon.kanbanWatcher = {
    snapshot: () => ({
      asOfMs: now, truncated: false, totalTasks: 1,
      tasks: [{ id: "secret", title: `Rotate leaked web voice token ${token}`, status: "blocked" }],
    }),
  };

  expect(daemon.snapshotKnownSecrets()).toContain(token);
  const text = await daemon.operationalContext();
  expect(text).not.toContain(token);
  expect(text).toContain("Rotate leaked web voice token <redacted>");
});

test("daemon operational context redacts an env-resolved brain api key", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-operational-envsecret-"));
  roots.push(root);
  // All-letter env-resolved key: shape rules can't catch it, and only the env-var
  // NAME is in config — the daemon must resolve and redact process.env's value.
  const envName = "CICERO_TEST_REMOTE_KEY";
  const key = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
  const prior = process.env[envName];
  process.env[envName] = key;
  const now = Date.now();
  const config = loadConfig({}, { home: root });
  config.raw.brain = { backend: "openai-compatible", base_url: "https://remote/v1", model: "m", api_key_env: envName };
  const daemon = new CiceroDaemon(config) as unknown as OperationalDaemonHarness;
  daemon.startedAtMs = now;
  daemon.overnightStore = new OvernightStore(join(root, "overnight.json"));
  daemon.kanbanWatcher = {
    snapshot: () => ({
      asOfMs: now, truncated: false, totalTasks: 1,
      tasks: [{ id: "secret", title: `remote api-key=${key}`, status: "blocked" }],
    }),
  };

  try {
    expect(daemon.snapshotKnownSecrets()).toContain(key);
    const text = await daemon.operationalContext();
    expect(text).not.toContain(key);
    expect(text).toContain("<redacted>");
  } finally {
    if (prior === undefined) delete process.env[envName];
    else process.env[envName] = prior;
  }
});

test("daemon operational context redacts the llm preset's default env api key", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-operational-default-envsecret-"));
  roots.push(root);
  const key = "DefaultOpenAiCredentialAllLetters";
  const prior = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = key;
  const now = Date.now();
  const config = loadConfig({}, { home: root });
  config.raw.llm = { backend: "openai-compatible" };
  const daemon = new CiceroDaemon(config) as unknown as OperationalDaemonHarness;
  daemon.startedAtMs = now;
  daemon.kanbanWatcher = {
    snapshot: () => ({
      asOfMs: now, truncated: false, totalTasks: 1,
      tasks: [{ id: "secret", title: `Rotate leaked provider key ${key}`, status: "blocked" }],
    }),
  };

  try {
    expect(daemon.snapshotKnownSecrets()).toContain(key);
    const text = await daemon.operationalContext();
    expect(text).not.toContain(key);
    expect(text).toContain("Rotate leaked provider key <redacted>");
  } finally {
    if (prior === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prior;
  }
});

test("daemon operational context redacts a configured Cookie credential header value", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-operational-cookie-"));
  roots.push(root);
  // A Cookie header carries a session credential but its NAME is not in the
  // token/authorization family — the gatherer must still treat its value as secret.
  const cookie = "session=abcdefghijklmnopqrstuvwxyzABCDEFG";
  const now = Date.now();
  const config = loadConfig({}, { home: root });
  config.raw.brain = { backend: "openai-compatible", base_url: "https://remote/v1", model: "m", headers: { Cookie: cookie } };
  const daemon = new CiceroDaemon(config) as unknown as OperationalDaemonHarness;
  daemon.startedAtMs = now;
  daemon.overnightStore = new OvernightStore(join(root, "overnight.json"));
  daemon.kanbanWatcher = {
    snapshot: () => ({
      asOfMs: now, truncated: false, totalTasks: 1,
      tasks: [{ id: "secret", title: `stray cookie ${cookie}`, status: "blocked" }],
    }),
  };

  expect(daemon.snapshotKnownSecrets()).toContain(cookie);
  const text = await daemon.operationalContext();
  expect(text).not.toContain(cookie);
  expect(text).toContain("stray cookie <redacted>");
});

test("daemon operational context redacts a custom-named credential header value", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-operational-xauth-"));
  roots.push(root);
  // Custom auth header (no token/authorization/cookie in the name): every configured
  // header is sent to the remote, so its value must be gathered regardless of name.
  const secret = "ZYXWVUTSRQPONMLK";
  const now = Date.now();
  const config = loadConfig({}, { home: root });
  config.raw.brain = { backend: "openai-compatible", base_url: "http://192.168.1.50:8080/v1", model: "m", headers: { "X-Auth": secret } };
  const daemon = new CiceroDaemon(config) as unknown as OperationalDaemonHarness;
  daemon.startedAtMs = now;
  daemon.overnightStore = new OvernightStore(join(root, "overnight.json"));
  daemon.kanbanWatcher = {
    snapshot: () => ({
      asOfMs: now, truncated: false, totalTasks: 1,
      tasks: [{ id: "secret", title: `leaked X-Auth ${secret}`, status: "blocked" }],
    }),
  };

  expect(daemon.snapshotKnownSecrets()).toContain(secret);
  const text = await daemon.operationalContext();
  expect(text).not.toContain(secret);
  expect(text).toContain("leaked X-Auth <redacted>");
});

test("daemon operational context redacts a short (7-char) configured api key", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-operational-shortkey-"));
  roots.push(root);
  // A real provider key can be shorter than 8 chars; config imposes no minimum, so a
  // short key must still be gathered and redacted (shape rules can't catch it either).
  const key = "Q7X9M2P";
  const now = Date.now();
  const config = loadConfig({}, { home: root });
  config.raw.brain = { backend: "openai-compatible", base_url: "http://192.168.1.50:8080/v1", model: "m", api_key: key };
  const daemon = new CiceroDaemon(config) as unknown as OperationalDaemonHarness;
  daemon.startedAtMs = now;
  daemon.overnightStore = new OvernightStore(join(root, "overnight.json"));
  daemon.kanbanWatcher = {
    snapshot: () => ({
      asOfMs: now, truncated: false, totalTasks: 1,
      tasks: [{ id: "secret", title: `custom endpoint key ${key}`, status: "blocked" }],
    }),
  };

  expect(daemon.snapshotKnownSecrets()).toContain(key);
  const text = await daemon.operationalContext();
  expect(text).not.toContain(key);
  expect(text).toContain("custom endpoint key <redacted>");
});

test("daemon operational context redacts the default CICERO_TELEGRAM_TOKEN credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-operational-tgdefault-"));
  roots.push(root);
  // Telegram configured with no token / token_env: telegramToken() falls back to the
  // default CICERO_TELEGRAM_TOKEN env var, so the gatherer must resolve it the same way.
  const token = "AllLetterTelegramCredential";
  const prior = process.env.CICERO_TELEGRAM_TOKEN;
  process.env.CICERO_TELEGRAM_TOKEN = token;
  const now = Date.now();
  const config = loadConfig({}, { home: root });
  config.raw.notify = { telegram: { chat_id: "123" } };
  const daemon = new CiceroDaemon(config) as unknown as OperationalDaemonHarness;
  daemon.startedAtMs = now;
  daemon.overnightStore = new OvernightStore(join(root, "overnight.json"));
  daemon.kanbanWatcher = {
    snapshot: () => ({
      asOfMs: now, truncated: false, totalTasks: 1,
      tasks: [{ id: "secret", title: `rotate ${token}`, status: "blocked" }],
    }),
  };

  try {
    expect(daemon.snapshotKnownSecrets()).toContain(token);
    const text = await daemon.operationalContext();
    expect(text).not.toContain(token);
    expect(text).toContain("rotate <redacted>");
  } finally {
    if (prior === undefined) delete process.env.CICERO_TELEGRAM_TOKEN;
    else process.env.CICERO_TELEGRAM_TOKEN = prior;
  }
});

test("daemon health snapshot reports unreadable and truly empty stores differently", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-health-status-"));
  roots.push(root);
  const unreadableFile = join(root, "unreadable", "metrics.jsonl");
  const unreadable = new HealthStore(unreadableFile);
  mkdirSync(unreadableFile);
  const daemon = new CiceroDaemon({} as never) as unknown as OperationalDaemonHarness;
  daemon.startedAtMs = Date.now();
  daemon.overnightStore = new OvernightStore(join(root, "overnight.json"));
  daemon.healthStore = unreadable;

  // Unreadable store: the fresh read fails, so the snapshot degrades to "unknown".
  expect(await daemon.operationalContext()).toContain('health: "unknown"');

  daemon.healthStore = new HealthStore(join(root, "empty", "metrics.jsonl"));
  expect(await daemon.operationalContext()).toContain('"summary":"no recent entries"');
});

test("daemon health snapshot uses the newest entry timestamp and reports aged data as stale", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-health-freshness-"));
  roots.push(root);
  const now = Date.now();
  const newestEntryMs = now - 5 * 60_000;
  const health = new HealthStore(join(root, "metrics.jsonl"));
  // Deliberately append out of timestamp order to verify the snapshot takes the maximum.
  await health.append({ t: newestEntryMs, metric: "sleep", value: 8, unit: "hours", source: "cli" });
  await health.append({ t: now - 10 * 60_000, metric: "weight", value: 80, unit: "kg", source: "cli" });
  const daemon = new CiceroDaemon({} as never) as unknown as OperationalDaemonHarness;
  daemon.startedAtMs = now;
  daemon.healthStore = health;

  expect(await daemon.operationalContext()).toContain(
    `health: {"as_of":"${new Date(newestEntryMs).toISOString()}","freshness":"stale"`,
  );
});

test("operational context reads health entries written out-of-process", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-health-external-"));
  roots.push(root);
  const now = Date.now();
  const file = join(root, "metrics.jsonl");
  const daemon = new CiceroDaemon({} as never) as unknown as OperationalDaemonHarness;
  daemon.startedAtMs = now;
  daemon.healthStore = new HealthStore(file);

  // Simulate `cicero health log` writing through a separate process/store. There
  // is no daemon-side cache, so the snapshot reads it fresh on the very next turn.
  await new HealthStore(file).append({
    t: now, metric: "sleep", value: 9, unit: "hours", source: "cli",
  });

  expect(await daemon.operationalContext()).toContain("Health log: sleep 9 hours.");
});

test("web-voice-disabled daemon state initializes real briefing and health snapshot sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-no-web-operational-"));
  roots.push(root);
  const now = Date.now();
  const config = loadConfig({}, { home: root });
  config.raw.web_voice = { enabled: false };
  config.raw.notify = { timezone: "UTC", briefing: { at: "08:15", catch_up_minutes: 90 } };
  const daemon = new CiceroDaemon(config) as unknown as OperationalDaemonHarness;
  const status = new BriefingStatusStore(join(root, "briefing.json"));
  const health = new HealthStore(join(root, "metrics.jsonl"));
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(now));
  await status.claim({
    day, scheduledAt: "08:15", trigger: "scheduled", claimedAt: now - 2_000,
    completedAt: now - 1_000, phase: "delivered", contentSummary: "Telegram briefing delivered.",
  });
  await health.append({
    t: now - 500, metric: "sleep", value: 8, unit: "hours", source: "cli",
  });
  daemon.briefingStatusStore = status;
  daemon.healthStore = health;
  daemon.overnightStore = new OvernightStore(join(root, "overnight.json"));
  daemon.startedAtMs = now - 10_000;

  daemon.initializeOperationalState();
  const text = await daemon.operationalContext();

  expect(config.web_voice?.enabled ?? false).toBe(false);
  expect(text).toContain("Telegram briefing delivered");
  expect(text).toContain("sleep");
  expect(text).not.toContain('health: "unavailable"');
});

test("web-voice-disabled daemon polls a configured kanban board for operational context", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-no-web-board-"));
  roots.push(root);
  const config = loadConfig({}, { home: root });
  config.raw.web_voice = { enabled: false };
  config.raw.notify = {
    kanban: {
      command: [
        process.execPath,
        "-e",
        `process.stdout.write(JSON.stringify([{ id: "task-1", title: "Ship non-web snapshot", status: "blocked" }]));`,
      ],
      interval_seconds: 60,
    },
  };
  const daemon = new CiceroDaemon(config) as unknown as OperationalDaemonHarness;

  daemon.initializeOperationalState();
  try {
    await daemon.kanbanWatcher?.tick?.();
    const text = await daemon.operationalContext();

    expect(config.web_voice?.enabled ?? false).toBe(false);
    expect(text).toContain("Ship non-web snapshot");
    expect(text).not.toContain('board: "unavailable"');
  } finally {
    await daemon.kanbanWatcher?.stop?.();
  }
});

test("web-voice-enabled daemon constructs the kanban watcher but defers polling until the web voice sink exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-web-board-defer-"));
  roots.push(root);
  const config = loadConfig({}, { home: root });
  config.raw.web_voice = { enabled: true };
  config.raw.notify = {
    kanban: {
      command: [
        process.execPath,
        "-e",
        `process.stdout.write(JSON.stringify([{ id: "task-1", title: "Ship web snapshot", status: "done" }]));`,
      ],
      interval_seconds: 60,
    },
  };
  const daemon = new CiceroDaemon(config) as unknown as OperationalDaemonHarness;

  daemon.initializeOperationalState();
  try {
    // The watcher is constructed so the board snapshot source can reference it,
    // but it must NOT be polling yet: on a web deployment the announce/nudge
    // callbacks no-op while this.webVoice is still null, and the watcher advances
    // its delivery state as it polls — a transition consumed during the startup
    // gap would be lost, not replayed. Polling starts only after webVoice exists.
    expect(config.web_voice?.enabled).toBe(true);
    expect(daemon.kanbanWatcher).toBeTruthy();
    expect(daemon.kanbanWatcher?.polling).toBe(false);

    // The web voice block starts it once the sink is up (start() is idempotent).
    daemon.kanbanWatcher?.start?.();
    expect(daemon.kanbanWatcher?.polling).toBe(true);
  } finally {
    await daemon.kanbanWatcher?.stop?.();
  }
});

test("web-voice-enabled-but-unbound daemon still starts board polling for the surviving surfaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-web-board-unbound-"));
  roots.push(root);
  const config = loadConfig({}, { home: root });
  config.raw.web_voice = { enabled: true };
  config.raw.notify = {
    kanban: {
      command: [
        process.execPath,
        "-e",
        `process.stdout.write(JSON.stringify([{ id: "task-1", title: "Ship board despite bind failure", status: "done" }]));`,
      ],
      interval_seconds: 60,
    },
  };
  const daemon = new CiceroDaemon(config) as unknown as OperationalDaemonHarness;

  daemon.initializeOperationalState();
  try {
    // Web voice enabled but this.webVoice stays null (EADDRINUSE bind failure): the
    // deferred start must still fire so host-mic / Telegram turns keep getting the
    // board. This simulates the post-web-voice-block call in start() with no sink.
    expect(daemon.kanbanWatcher?.polling).toBe(false);
    daemon.startBoardPollingIfPending();
    expect(daemon.kanbanWatcher?.polling).toBe(true);

    // Sanity: a second call is a no-op (idempotent, no double-start).
    daemon.startBoardPollingIfPending();
    expect(daemon.kanbanWatcher?.polling).toBe(true);
  } finally {
    await daemon.kanbanWatcher?.stop?.();
  }
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

test("runOperatorChatTurn owned by an aborted signal neither invokes the brain nor appends history", async () => {
  // The Telegram onChat turn is now run under the daemon lifecycle signal, so a
  // shutdown mid-turn must not publish: no brain call, no history append, no reply.
  const controller = new AbortController();
  controller.abort();
  let brainCalls = 0;
  let appends = 0;
  await expect(runOperatorChatTurn("late turn during shutdown", {
    brain: { send: async () => { brainCalls += 1; return "should never be sent"; } },
    history: { append: async () => { appends += 1; } },
    operationalContext: async () => null,
  }, controller.signal)).rejects.toThrow();
  expect(brainCalls).toBe(0);
  expect(appends).toBe(0);
});

test("host mic captures once for brain and local-llm paths and skips a local fast path", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-host-operational-"));
  roots.push(root);
  const config = loadConfig({}, { home: root });
  config.ttsEnabled = false;
  config.brain.thinking_filler = false;
  const daemon = new CiceroDaemon(config);
  const contextStore = new ContextStore();
  const sent: Array<{ mode: "send" | "stream"; options?: BrainTurnOptions }> = [];
  const localSystemPrompts: string[] = [];
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
    {
      name: "local-test",
      chatCompletion: async (messages) => {
        localSystemPrompts.push(messages[0]?.content ?? "");
        return "local reply.";
      },
      chatCompletionStream: (messages) => {
        localSystemPrompts.push(messages[0]?.content ?? "");
        return (async function* () { yield "local reply."; })();
      },
      health: async () => true,
    },
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

  route = { intent: "simple_question", category: "local-llm", params: {}, confidence: 1 };
  await state.handleCommand("local model question", new AbortController().signal);
  expect(localSystemPrompts).toHaveLength(1);
  expect(localSystemPrompts[0]).toContain("host-operational-state-3");

  route = { intent: "help", category: "local", params: {}, confidence: 1 };
  await state.handleCommand("help", new AbortController().signal);
  expect(captures).toBe(3);
  expect(sent).toHaveLength(2);
});

test("a Telegram/shell health log lands in the daemon store and is visible to the snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-daemon-hlog-"));
  roots.push(root);
  const daemon = new CiceroDaemon({} as never) as unknown as OperationalDaemonHarness & {
    logHealth(metric: string, words: string[]): Promise<string>;
  };
  daemon.startedAtMs = Date.now();
  daemon.healthStore = new HealthStore(join(root, "metrics.jsonl"));

  const ack = await daemon.logHealth("weight", ["82.4", "kg"]);
  expect(ack).toContain("82.4");
  // The entry went through the daemon's OWN store (not a bypass instance)...
  expect((await daemon.healthStore!.recent(1))[0]?.value).toBe(82.4);
  // ...and is immediately visible to the snapshot, which reads the store fresh.
  expect(await daemon.operationalContext()).toContain("weight 82.4");
});
