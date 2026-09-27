import { inQuietHours, type QuietHoursConfig } from "./briefing";
import type { BoardPreset } from "./board-presets";
import type { KanbanTask } from "./kanban-watch";

export type KanbanChannel = "legacy" | "call" | "text" | "briefing";

/** Choose the channel only for priority-capable boards. Hermes keeps status routing. */
export function kanbanChannel(
  task: KanbanTask,
  escalation: "priority" | undefined,
  preset: BoardPreset | undefined,
  now: Date,
  quietHours?: QuietHoursConfig,
  timeZone?: string,
): KanbanChannel {
  if (escalation !== "priority" || (preset ?? "hermes") === "hermes") return "legacy";
  if (task.priority === "p2" || task.priority === undefined) return "briefing";
  if (task.priority === "p1") return "text";
  return quietHours && inQuietHours(now, quietHours, timeZone) ? "text" : "call";
}

/**
 * Where a "nobody's picked this up" reminder goes. Never a ring. Priority
 * boards: p2 stays quiet (the morning briefing carries the board); p1/p0 text,
 * except during quiet hours, when the reminder waits for its next slot.
 */
export function nudgeChannel(
  task: KanbanTask,
  escalation: "priority" | undefined,
  preset: BoardPreset | undefined,
  now: Date,
  quietHours?: QuietHoursConfig,
  timeZone?: string,
): "legacy" | "text" | "skip" {
  const channel = kanbanChannel(task, escalation, preset, now, quietHours, timeZone);
  if (channel === "legacy") return "legacy";
  if (channel === "briefing") return "skip";
  return quietHours && inQuietHours(now, quietHours, timeZone) ? "skip" : "text";
}
