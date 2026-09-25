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
