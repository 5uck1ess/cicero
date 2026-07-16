import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CiceroDaemon } from "../src/daemon";
import { HealthStore } from "../src/health/store";
import { BriefingStatusStore } from "../src/notify/briefing-scheduler";
import { OvernightStore } from "../src/notify/overnight-store";
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
