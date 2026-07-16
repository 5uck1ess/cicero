import { test, expect } from "bun:test";
import {
  KanbanWatcher,
  listViaCli,
  spokenLine,
  taskLinkViaCli,
  type KanbanTask,
} from "../../src/notify/kanban-watch";
import { CommandAbortError, CommandDeadlineError } from "../../src/process/bounded-command";

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached before timeout");
    await Bun.sleep(5);
  }
}

function watcher(board: () => KanbanTask[], lines: string[]) {
  return new KanbanWatcher({
    list: async () => board(),
    announce: (t) => lines.push(spokenLine(t)),
    intervalMs: 60_000, // ticks driven manually in tests
  });
}

const task = (id: string, status: string, title = "Fix the thing", assignee = "coder"): KanbanTask =>
  ({ id, status, title, assignee });

test("first poll seeds silently — pre-existing done tasks are old news", async () => {
  const lines: string[] = [];
  const w = watcher(() => [task("t1", "done"), task("t2", "running")], lines);
  await w.tick();
  expect(lines).toEqual([]);
});

test("snapshot exposes only the last successful cached board read", async () => {
  let now = 1_000;
  let fail = false;
  const board = [task("t1", "blocked", "x".repeat(500))];
  const w = new KanbanWatcher({
    list: async () => { if (fail) throw new Error("board down"); return board; },
    announce: async () => {}, intervalMs: 60_000, now: () => now,
  });
  expect(w.snapshot()).toBeNull();
  await w.tick();
  const first = w.snapshot()!;
  expect(first.asOfMs).toBe(1_000);
  expect(first.truncated).toBe(false);
  expect(first.totalTasks).toBe(1);
  expect(first.tasks[0]!.title.length).toBe(240);
  (first.tasks[0] as KanbanTask).title = "mutated copy";
  expect(w.snapshot()!.tasks[0]!.title).not.toBe("mutated copy");
  now = 2_000;
  fail = true;
  await w.tick();
  expect(w.snapshot()!.asOfMs).toBe(1_000);
});

test("snapshot marks boards larger than its task cap as truncated", async () => {
  const board = Array.from({ length: 1_001 }, (_, index) => task(String(index), "todo", `Task ${index}`));
  const w = watcher(() => board, []);
  await w.tick();
  expect(w.snapshot()).toMatchObject({ truncated: true, totalTasks: 1_001 });
  expect(w.snapshot()!.tasks).toHaveLength(1_000);
});

test("a transition into done announces once and never re-announces", async () => {
  const lines: string[] = [];
  let status = "running";
  const w = watcher(() => [task("t1", status)], lines);
  await w.tick();          // seed
  status = "done";
  await w.tick();
  await w.tick();          // unchanged — silent
  expect(lines).toEqual(["The coder finished the task: Fix the thing."]);
});

test("a task first seen already-terminal (created+finished between polls) announces", async () => {
  const lines: string[] = [];
  const board: KanbanTask[] = [task("t1", "running")];
  const w = watcher(() => board, lines);
  await w.tick();          // seed
  board.push(task("t9", "done", "Ship it"));
  await w.tick();
  expect(lines).toEqual(["The coder finished the task: Ship it."]);
});

test("blocked and review get their own phrasing; plain status churn is silent", async () => {
  const lines: string[] = [];
  let s1 = "ready", s2 = "running";
  const w = watcher(() => [task("t1", s1, "Migrate the db"), task("t2", s2, "Add docs")], lines);
  await w.tick();          // seed
  s1 = "running"; s2 = "review";
  await w.tick();
  s1 = "blocked";
  await w.tick();
  expect(lines).toEqual([
    'The task "Add docs" is ready for review.',
    'The task "Migrate the db" is parked — it needs a review or an answer. Text "have coder call me" to talk it through.',
  ]);
});

test("a failing poll is swallowed and doesn't reset seeding", async () => {
  const lines: string[] = [];
  let fail = false;
  let status = "running";
  const w = new KanbanWatcher({
    list: async () => { if (fail) throw new Error("board down"); return [task("t1", status)]; },
    announce: (t) => lines.push(spokenLine(t)),
    intervalMs: 60_000,
  });
  await w.tick();          // seed
  fail = true;
  await w.tick();          // error — swallowed
  fail = false;
  status = "done";
  await w.tick();
  expect(lines).toEqual(["The coder finished the task: Fix the thing."]);
});

test("spokenLine truncates long titles and handles a missing assignee", () => {
  const long = "x".repeat(100);
  expect(spokenLine({ id: "t", status: "done", title: long, assignee: null }))
    .toBe(`A worker finished the task: ${"x".repeat(77)}….`);
});

test("spokenLine speaks first-person for lane-owned tasks", () => {
  const t2 = { id: "1", title: "Fix the parser", status: "done", assignee: "coder" };
  expect(spokenLine(t2, true)).toBe("Coder here — finished: Fix the parser.");
  expect(spokenLine({ ...t2, status: "blocked" }, true)).toContain("I've parked");
  expect(spokenLine(t2, false)).toBe("The coder finished the task: Fix the parser.");
});

test("blocked announcements name the dial-back; no assignee, no hint", () => {
  const t = { id: "1", title: "Fix the parser", status: "blocked", assignee: "coder" };
  expect(spokenLine(t)).toContain('Text "have coder call me" to talk it through.');
  expect(spokenLine(t, true)).toContain('Text "have coder call me" and I\'ll walk you through it.');
  expect(spokenLine({ ...t, assignee: null })).not.toContain("call me");
});

test("nudge: an unstarted task past the threshold nudges from the first poll; back-to-back polls don't repeat", async () => {
  const nudges: string[] = [];
  const now = Math.floor(Date.now() / 1000);
  const board: KanbanTask[] = [
    { id: "old", title: "Waiting task", status: "todo", created_at: now - 2 * 3600 },        // 2h old, unstarted
    { id: "fresh", title: "New task", status: "todo", created_at: now - 60 },                // 1 min old
    { id: "live", title: "Running task", status: "running", created_at: now - 2 * 3600, started_at: now - 3600 },
    { id: "parked", title: "Blocked task", status: "blocked", created_at: now - 2 * 3600 }, // announce-worthy, not nudge-worthy
  ];
  const w = new KanbanWatcher({
    list: async () => board,
    announce: () => {},
    intervalMs: 60_000,
    nudge: (t, waited) => nudges.push(`${t.id}:${Math.round(waited)}`),
    nudgeAfterMs: 60 * 60_000,
  });
  await w.tick(); // nudges fire even on the seeding poll — a stale todo is still news at boot
  await w.tick(); // gap not elapsed — no repeat
  expect(nudges).toEqual(["old:120"]);
});

test("nudge: reminders repeat with a doubling gap and stop when someone starts the task", async () => {
  const nudges: string[] = [];
  const base = 1_750_000_000_000;
  let clock = base;
  const board: KanbanTask[] = [
    { id: "t1", title: "Waiting task", status: "todo", created_at: Math.floor(base / 1000) - 3600 }, // exactly 1h old
  ];
  const w = new KanbanWatcher({
    list: async () => board,
    announce: () => {},
    intervalMs: 60_000,
    nudge: (t, _waited, nth) => nudges.push(`${t.id}#${nth}`),
    nudgeAfterMs: 60 * 60_000,
    now: () => clock,
  });
  await w.tick();                                   // reminder 1; next allowed in 1h
  clock += 30 * 60_000; await w.tick();             // 30m — too soon
  clock += 31 * 60_000; await w.tick();             // 1h 1m — reminder 2; next gap 2h
  clock += 60 * 60_000; await w.tick();             // +1h — too soon
  clock += 61 * 60_000; await w.tick();             // +2h 1m — reminder 3; next gap 4h (cap)
  board[0] = { ...board[0]!, started_at: Math.floor(clock / 1000) };
  clock += 5 * 3600_000; await w.tick();            // started — silence, state cleared
  expect(nudges).toEqual(["t1#1", "t1#2", "t1#3"]);
});

test("nudge: off without a callback or with nudgeAfterMs 0", async () => {
  const now = Math.floor(Date.now() / 1000);
  const stale: KanbanTask = { id: "old", title: "Waiting", status: "todo", created_at: now - 24 * 3600 };
  const nudges: string[] = [];
  const w = new KanbanWatcher({
    list: async () => [stale],
    announce: () => {},
    intervalMs: 60_000,
    nudge: (t) => nudges.push(t.id),
    nudgeAfterMs: 0,
  });
  await w.tick();
  expect(nudges).toEqual([]);
});

test("scheduled polling never overlaps and repeated start does not fan out", async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const releases: Array<() => void> = [];
  const w = new KanbanWatcher({
    list: (signal) => new Promise<KanbanTask[]>((resolve, reject) => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      const finish = (callback: () => void): void => {
        signal.removeEventListener("abort", aborted);
        active--;
        callback();
      };
      const aborted = (): void => finish(() => reject(signal.reason));
      signal.addEventListener("abort", aborted, { once: true });
      releases.push(() => finish(() => resolve([])));
    }),
    announce: () => {},
    intervalMs: 10,
  });

  w.start();
  w.start();
  await waitUntil(() => calls === 1);
  await Bun.sleep(40);
  expect(calls).toBe(1);
  expect(maxActive).toBe(1);

  releases.shift()?.();
  await waitUntil(() => calls === 2);
  expect(maxActive).toBe(1);
  releases.shift()?.();
  await w.stop();
});

test("stop aborts an active poll, waits for settlement, and prevents post-stop announcements", async () => {
  const announcements: string[] = [];
  let phase: "seed" | "active" = "seed";
  let activeStarted = false;
  let abortObserved = false;
  let activeSettled = false;
  const w = new KanbanWatcher({
    list: async (signal) => {
      if (phase === "seed") return [task("t1", "running")];
      activeStarted = true;
      return await new Promise<KanbanTask[]>((resolve) => {
        signal.addEventListener("abort", () => {
          abortObserved = true;
          setTimeout(() => {
            activeSettled = true;
            resolve([task("t1", "done")]);
          }, 25);
        }, { once: true });
      });
    },
    announce: (t) => { announcements.push(t.status); },
    intervalMs: 5,
  });

  await w.tick();
  phase = "active";
  w.start();
  await waitUntil(() => activeStarted);
  let stopFinished = false;
  const stopping = w.stop().then(() => { stopFinished = true; });
  await waitUntil(() => abortObserved);
  expect(stopFinished).toBe(false);
  expect(activeSettled).toBe(false);
  await stopping;
  expect(activeSettled).toBe(true);
  expect(announcements).toEqual([]);
});

test("an async announcement is part of the poll and shutdown barrier", async () => {
  let status = "running";
  let listCalls = 0;
  let announceStarted = false;
  let releaseAnnouncement: (() => void) | undefined;
  const w = new KanbanWatcher({
    list: async () => {
      listCalls++;
      return [task("t1", status)];
    },
    announce: async () => {
      announceStarted = true;
      await new Promise<void>((resolve) => { releaseAnnouncement = resolve; });
    },
    intervalMs: 5,
  });

  await w.tick();
  status = "done";
  w.start();
  await waitUntil(() => announceStarted);
  await Bun.sleep(25);
  expect(listCalls).toBe(2);

  let stopFinished = false;
  const stopping = w.stop().then(() => { stopFinished = true; });
  await Bun.sleep(10);
  expect(stopFinished).toBe(false);
  releaseAnnouncement?.();
  await stopping;
  expect(stopFinished).toBe(true);
});

test("kanban list drains stderr and enforces its wall deadline", async () => {
  const command = [
    process.execPath,
    "-e",
    `process.stderr.write("d".repeat(60_000)); process.stdout.write(JSON.stringify([{ id: "1", title: "Task", status: "running" }]));`,
  ];
  await expect(listViaCli(command, { timeoutMs: 2_000 })).resolves.toEqual([
    { id: "1", title: "Task", status: "running" },
  ]);

  await expect(listViaCli([process.execPath, "-e", `setInterval(() => {}, 1_000);`], { timeoutMs: 50 }))
    .rejects.toBeInstanceOf(CommandDeadlineError);
});

test("task link drains stderr and preserves cancellation instead of swallowing it", async () => {
  const command = [
    process.execPath,
    "-e",
    `process.stderr.write("d".repeat(60_000)); process.stdout.write(JSON.stringify({ latest_summary: "ready https://github.com/acme/repo/pull/42" }));`,
  ];
  await expect(taskLinkViaCli("task-1", command, { timeoutMs: 2_000 }))
    .resolves.toBe("https://github.com/acme/repo/pull/42");

  const controller = new AbortController();
  const lookup = taskLinkViaCli(
    "task-2",
    [process.execPath, "-e", `setInterval(() => {}, 1_000);`],
    { signal: controller.signal, timeoutMs: 2_000 },
  );
  setTimeout(() => controller.abort(), 40);
  await expect(lookup).rejects.toBeInstanceOf(CommandAbortError);
});
