import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverNudge, kanbanChannel, nudgeChannel } from "../../src/notify/kanban-escalation";
import { KanbanWatcher, type KanbanTask } from "../../src/notify/kanban-watch";
import { OvernightStore } from "../../src/notify/overnight-store";

const task = (priority?: KanbanTask["priority"], status = "blocked"): KanbanTask =>
  ({ id: "one", title: "Broken deploy", status, priority });

test("priority routing covers all six day and quiet-hour cells, including blocked P0", () => {
  const q = { from: "23:00", to: "08:00" };
  const day = new Date("2026-09-25T16:00:00Z"); // 12:00 in New York
  const night = new Date("2026-09-26T03:00:00Z"); // 23:00 in New York
  for (const [priority, daytime, nighttime] of [
    ["p0", "call", "text"], ["p1", "text", "text"], ["p2", "briefing", "briefing"],
  ] as const) {
    expect(kanbanChannel(task(priority), "priority", "multica", day, q, "America/New_York")).toBe(daytime);
    expect(kanbanChannel(task(priority), "priority", "multica", night, q, "America/New_York")).toBe(nighttime);
  }
  expect(kanbanChannel(task("p0"), "priority", "multica", day, q, "America/New_York")).toBe("call");
});

test("quiet-hour edges use configured timezone, including a window across midnight", () => {
  const q = { from: "23:00", to: "08:00" };
  const channel = (iso: string) => kanbanChannel(task("p0"), "priority", "paperclip",
    new Date(iso), q, "America/New_York");
  expect(channel("2026-09-26T02:59:00Z")).toBe("call");  // 22:59
  expect(channel("2026-09-26T03:00:00Z")).toBe("text");  // from 23:00
  expect(channel("2026-09-26T11:59:00Z")).toBe("text");  // 07:59
  expect(channel("2026-09-26T12:00:00Z")).toBe("call");  // to 08:00
});

test("Hermes and unset escalation retain legacy status routing", () => {
  const now = new Date("2026-09-25T16:00:00Z");
  for (const status of ["done", "review", "blocked"]) {
    for (const preset of ["hermes", "multica", "paperclip"] as const) {
      expect(kanbanChannel(task("p0", status), undefined, preset, now)).toBe("legacy");
    }
    expect(kanbanChannel(task(undefined, status), "priority", "hermes", now)).toBe("legacy");
  }
  expect(kanbanChannel(task(undefined), "priority", "multica", now)).toBe("briefing");
});

test("nudges follow priority: p2 goes to the briefing, p1/p0 text by day and wait out quiet hours, legacy unchanged (#134)", () => {
  const q = { from: "23:00", to: "08:00" };
  const day = new Date("2026-09-25T16:00:00Z"); // 12:00 in New York
  const night = new Date("2026-09-26T03:00:00Z"); // 23:00 in New York
  const todo = (priority?: KanbanTask["priority"]) => task(priority, "todo");
  for (const [priority, daytime, nighttime] of [
    ["p0", "text", "skip"], ["p1", "text", "skip"], ["p2", "briefing", "briefing"], [undefined, "briefing", "briefing"],
  ] as const) {
    expect(nudgeChannel(todo(priority), "priority", "multica", day, q, "America/New_York")).toBe(daytime);
    expect(nudgeChannel(todo(priority), "priority", "multica", night, q, "America/New_York")).toBe(nighttime);
  }
  expect(nudgeChannel(todo("p0"), undefined, "multica", day, q)).toBe("legacy");
  expect(nudgeChannel(todo(undefined), "priority", "hermes", day, q)).toBe("legacy");
});

test("a due P2 todo reminder reaches the morning briefing store once, not on every repeat (#134)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-nudge-brief-"));
  try {
    chmodSync(dir, 0o700);
    const store = new OvernightStore(join(dir, "overnight.json"));
    const texts: string[] = [];
    const base = Date.parse("2026-09-25T16:00:00Z"); // 12:00 in New York
    let clock = base;
    const board: KanbanTask[] = [{ id: "m1", title: "Normal fix", status: "todo", priority: "p2", created_at: Math.floor(base / 1000) - 2 * 3600 }];
    const watcher = new KanbanWatcher({
      list: async () => board,
      announce: () => {},
      intervalMs: 60_000,
      nudgeAfterMs: 60 * 60_000,
      now: () => clock,
      nudge: (t, waited, nth) => deliverNudge(
        { task: t, line: `reminder ${t.id} #${nth}`, nth, escalation: "priority", preset: "multica",
          now: new Date(clock), quietHours: { from: "23:00", to: "08:00" }, timeZone: "America/New_York" },
        { legacy: async () => {}, text: async (line) => { texts.push(line); }, briefing: (line) => store.enqueue(line) },
      ),
    });
    await watcher.tick();
    clock += 61 * 60_000; await watcher.tick(); // second reminder is due but must not pile up
    expect((await store.peek()).map((item) => item.text)).toEqual(["reminder m1 #1"]);
    expect(texts).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
