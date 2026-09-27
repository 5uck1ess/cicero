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
 * boards: p2 goes to the morning briefing (the caller queues only the first
 * reminder per task); p1/p0 text, except during quiet hours, when the reminder
 * waits for its next slot.
 */
export function nudgeChannel(
  task: KanbanTask,
  escalation: "priority" | undefined,
  preset: BoardPreset | undefined,
  now: Date,
  quietHours?: QuietHoursConfig,
  timeZone?: string,
): "legacy" | "text" | "briefing" | "skip" {
  const channel = kanbanChannel(task, escalation, preset, now, quietHours, timeZone);
  if (channel === "legacy") return "legacy";
  if (channel === "briefing") return "briefing";
  return quietHours && inQuietHours(now, quietHours, timeZone) ? "skip" : "text";
}

/** Delivery for one due reminder; the daemon injects the real channels. */
export async function deliverNudge(
  args: { task: KanbanTask; line: string; nth: number; escalation: "priority" | undefined; preset: BoardPreset | undefined; now: Date; quietHours?: QuietHoursConfig; timeZone?: string },
  deliver: { legacy: (line: string) => Promise<unknown>; briefing: (line: string) => Promise<unknown>; text: (line: string) => Promise<unknown> },
): Promise<void> {
  const channel = nudgeChannel(args.task, args.escalation, args.preset, args.now, args.quietHours, args.timeZone);
  if (channel === "legacy") await deliver.legacy(args.line);
  // The briefing lists only blocked/review tasks, so a P2 reminder must be queued
  // to reach the operator. First reminder only: the persisted nudge count keeps
  // later reminders from piling up in the digest.
  else if (channel === "briefing") { if (args.nth === 1) await deliver.briefing(args.line); }
  else if (channel === "text") await deliver.text(args.line);
}
