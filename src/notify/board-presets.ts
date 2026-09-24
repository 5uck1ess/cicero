import { log } from "../logger";
import type { KanbanTask } from "./kanban-watch";

export type CanonicalKanbanStatus = "todo" | "in_progress" | "review" | "blocked" | "done" | "cancelled";
export type BoardPreset = "hermes" | "multica" | "paperclip";
export interface BoardNormalizationOptions {
  preset?: BoardPreset;
  assignees?: Record<string, string>;
}

export const MAX_BOARD_ASSIGNEES = 256;
const MAX_LIST_TASKS = 10_000;
const MAX_UNKNOWN_STATUSES = 128;
const unknownStatuses = new Set<string>();
const hermesStatuses: Record<string, CanonicalKanbanStatus> = {
  triage: "todo", todo: "todo", scheduled: "todo", ready: "todo",
  running: "in_progress", review: "review", blocked: "blocked", done: "done", archived: "cancelled",
};
const issueStatuses: Record<string, CanonicalKanbanStatus> = {
  backlog: "todo", todo: "todo", in_progress: "in_progress", in_review: "review",
  blocked: "blocked", done: "done", cancelled: "cancelled",
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function detailArgs(preset: BoardPreset = "hermes"): string[] {
  return preset === "multica" ? ["--output", "json"] : ["--json"];
}

export function boundedParentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => id.slice(0, 128));
}

export function detailParentIds(value: unknown, preset: BoardPreset = "hermes"): string[] {
  if (!record(value)) return [];
  return boundedParentIds(preset === "hermes" ? value.parents
    : [preset === "multica" ? value.parent_issue_id : value.parentId]);
}

function timestamp(value: unknown, preset: BoardPreset): number | null {
  const seconds = preset === "hermes" ? value
    : typeof value === "string" && value.length <= 64 ? Date.parse(value) / 1000 : null;
  return typeof seconds === "number" && Number.isFinite(seconds) ? seconds : null;
}

/** Normalize only bounded CLI output; retain no board-specific payload on tasks. */
export function normalizeBoardList(value: unknown, options: BoardNormalizationOptions = {}): KanbanTask[] {
  const preset = options.preset ?? "hermes";
  if (!["hermes", "multica", "paperclip"].includes(preset)) throw new Error("unsupported kanban preset");
  const rows = preset === "multica" && record(value) ? value.issues : value;
  if (!Array.isArray(rows) || (preset === "multica" && !record(value))) {
    throw new Error("kanban list did not return a JSON array or preset list wrapper");
  }
  if (rows.length > MAX_LIST_TASKS) throw new Error("kanban list exceeds 10000 tasks");
  const statuses = preset === "hermes" ? hermesStatuses : issueStatuses;
  const tasks: KanbanTask[] = [];
  for (const row of rows) {
    if (!record(row) || typeof row.id !== "string" || !row.id || typeof row.status !== "string") continue;
    const mapped = Object.hasOwn(statuses, row.status) ? statuses[row.status]
      : preset === "multica" && typeof row.status_category === "string" && Object.hasOwn(statuses, row.status_category)
        ? statuses[row.status_category] : undefined;
    const status = mapped ?? row.status.slice(0, 64);
    if (!mapped) {
      const key = `${preset}:${status}`;
      if (!unknownStatuses.has(key) && unknownStatuses.size < MAX_UNKNOWN_STATUSES) {
        unknownStatuses.add(key);
        // Do not log arbitrary status text: it can contain credentials or terminal escapes.
        log("warn", `kanban watch: unknown ${preset} status; announcements and nudges suppressed`);
      }
    }
    const rawAssignee = preset === "hermes" ? row.assignee : preset === "multica" ? row.assignee_id
      : typeof row.assigneeAgentId === "string" && row.assigneeAgentId ? row.assigneeAgentId : row.assigneeUserId;
    const name = typeof rawAssignee === "string" && options.assignees && Object.hasOwn(options.assignees, rawAssignee)
      ? options.assignees[rawAssignee] : preset === "hermes" ? rawAssignee : null;
    tasks.push({
      id: row.id.slice(0, 128),
      title: typeof row.title === "string" ? row.title.slice(0, 240) : "(untitled)",
      status,
      ...(mapped ? {} : { unknown_status: true }),
      assignee: typeof name === "string" ? name.slice(0, 128) : null,
      created_at: timestamp(preset === "paperclip" ? row.createdAt : row.created_at, preset),
      started_at: timestamp(preset === "paperclip" ? row.startedAt : preset === "hermes" ? row.started_at : null, preset),
      completed_at: timestamp(preset === "paperclip" ? row.completedAt : preset === "hermes" ? row.completed_at : null, preset),
      ...(preset === "hermes" ? {} : { parent_ids: detailParentIds(row, preset) }),
    });
  }
  return tasks;
}
