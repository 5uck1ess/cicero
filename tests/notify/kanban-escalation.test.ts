import { expect, test } from "bun:test";
import { kanbanChannel } from "../../src/notify/kanban-escalation";
import type { KanbanTask } from "../../src/notify/kanban-watch";

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
