import { expect, test } from "bun:test";
import { composeBriefing, composeBriefingDigest } from "../../src/notify/briefing";
import { render, snapshot } from "../../src/operational-state";
import { dashBus } from "../../src/dashboard/bus";
import { boundedParentIds, normalizeBoardList, type BoardPreset } from "../../src/notify/board-presets";
import { isUnstarted, listViaCli, taskLinkViaCli, taskParentsViaCli, type KanbanCommandOptions } from "../../src/notify/kanban-watch";

function fakeCommand(payload: unknown, calls: string[][] = []): NonNullable<KanbanCommandOptions["runCommand"]> {
  return async (command) => {
    calls.push([...command]);
    const text = JSON.stringify(payload);
    const stream = (text: string) => ({ text, receivedBytes: text.length, capturedBytes: text.length, limitBytes: 1024 * 1024, truncated: false });
    return { command, exitCode: 0, durationMs: 0, stdout: stream(text), stderr: stream(""),
      combined: { receivedBytes: text.length, capturedBytes: text.length, truncated: false } };
  };
}

const iso = "2026-09-24T10:00:00Z";
const seconds = Date.parse(iso) / 1000;

test("Hermes bare list keeps unix seconds and lane names, normalizes running and archived", async () => {
  const rows = [
    { id: "work", title: "Work", status: "running", assignee: "coder", created_at: seconds, started_at: seconds + 1, completed_at: null },
    { id: "old", title: "Old", status: "archived", assignee: null, created_at: seconds, started_at: null, completed_at: seconds + 2 },
  ];
  expect(await listViaCli(["fake-hermes"], { runCommand: fakeCommand(rows) })).toEqual([
    { ...rows[0], status: "in_progress" }, { ...rows[1], status: "cancelled" },
  ]);
});

test("Multica wrapped list converts ISO timestamps and uses category only for custom statuses", async () => {
  const issue = { id: "work", identifier: "DEV-1", title: "Work", status: "in_progress", assignee_type: "agent",
    assignee_id: "agent-id", parent_issue_id: "parent", created_at: iso, updated_at: "2026-09-24T11:00:00Z" };
  const payload = { issues: [issue, { ...issue, id: "custom", status: "qa_custom", status_category: "in_review" },
    { ...issue, id: "builtin", status: "todo", status_category: "done" }], total: 3, limit: 50, offset: 0, has_more: false };
  const tasks = await listViaCli(["fake-multica"], { preset: "multica", runCommand: fakeCommand(payload) });
  expect(tasks).toEqual([
    { id: "work", title: "Work", status: "in_progress", assignee: null, parent_ids: ["parent"], created_at: seconds, started_at: null, completed_at: null },
    { id: "custom", title: "Work", status: "review", assignee: null, parent_ids: ["parent"], created_at: seconds, started_at: null, completed_at: null },
    { id: "builtin", title: "Work", status: "todo", assignee: null, parent_ids: ["parent"], created_at: seconds, started_at: null, completed_at: null },
  ]);
  expect(isUnstarted(tasks[0]!)).toBe(false);
  expect(normalizeBoardList(payload, { preset: "multica", assignees: { "agent-id": "coder" } })[0]!.assignee).toBe("coder");
});

test("Paperclip camelCase timestamps, parentId, and agent/user assignee precedence", async () => {
  const row = { id: "p1", identifier: "DEV-1", title: "Work", status: "in_review", assigneeAgentId: "agent-id",
    assigneeUserId: "user-id", parentId: "p0", createdAt: iso, startedAt: iso, completedAt: null, cancelledAt: null };
  const tasks = await listViaCli(["fake-paperclip"], { preset: "paperclip", assignees: { "agent-id": "coder", "user-id": "operator" },
    runCommand: fakeCommand([row, { ...row, id: "p2", assigneeAgentId: null, parentId: null }]) });
  expect(tasks).toEqual([
    { id: "p1", title: "Work", status: "review", assignee: "coder", parent_ids: ["p0"], created_at: seconds, started_at: seconds, completed_at: null },
    { id: "p2", title: "Work", status: "review", assignee: "operator", parent_ids: [], created_at: seconds, started_at: seconds, completed_at: null },
  ]);
  expect(normalizeBoardList([row], { preset: "paperclip" })[0]!.assignee).toBeNull();
  expect(normalizeBoardList([row], { preset: "paperclip", assignees: { "user-id": "operator" } })[0]!.assignee).toBeNull();
});

for (const [preset, statuses, expected] of [
  ["hermes", ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"],
    ["todo", "todo", "todo", "todo", "in_progress", "blocked", "review", "done", "cancelled"]],
  ["multica", ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"],
    ["todo", "todo", "in_progress", "review", "blocked", "done", "cancelled"]],
  ["paperclip", ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"],
    ["todo", "todo", "in_progress", "review", "blocked", "done", "cancelled"]],
] as const) {
  test(`${preset} maps every built-in status`, () => {
    const rows = statuses.map((status) => ({ id: status, title: status, status }));
    expect(normalizeBoardList(preset === "multica" ? { issues: rows } : rows, { preset }).map((t) => t.status)).toEqual([...expected]);
  });
}

for (const preset of ["hermes", "multica", "paperclip"] as BoardPreset[]) {
  test(`${preset} detail parents use the correct field and arguments`, async () => {
    const calls: string[][] = [];
    const payload = { parents: ["hermes-parent"], parent_issue_id: "multica-parent", parentId: "paperclip-parent" };
    expect(await taskParentsViaCli("child", ["fake", "get"], { preset, runCommand: fakeCommand(payload, calls) })).toEqual([`${preset}-parent`]);
    expect(calls).toEqual([["fake", "get", "child", ...(preset === "multica" ? ["--output", "json"] : ["--json"])]]);
  });
}

test("non-Hermes link lookup never spawns; Hermes still extracts deliverables", async () => {
  const calls: string[][] = [];
  const runCommand = fakeCommand({ latest_summary: "See https://github.com/example/repo/pull/1", comments: [] }, calls);
  for (const preset of ["multica", "paperclip"] as const) {
    expect(await taskLinkViaCli("id", ["fake", "get"], { preset, runCommand })).toBeNull();
  }
  expect(calls).toEqual([]);
  expect(await taskLinkViaCli("id", ["fake", "show"], { runCommand })).toBe("https://github.com/example/repo/pull/1");
  expect(calls).toEqual([["fake", "show", "id", "--json"]]);
});

test("malformed lists throw and malformed fields are bounded or discarded", async () => {
  for (const payload of [null, {}, { issues: null }, { issues: {} }, []]) {
    await expect(listViaCli(["fake"], { preset: "multica", runCommand: fakeCommand(payload) })).rejects.toThrow("JSON array");
  }
  for (const preset of ["hermes", "paperclip"] as const) {
    await expect(listViaCli(["fake"], { preset, runCommand: fakeCommand({ issues: [] }) })).rejects.toThrow("JSON array");
  }
  const tasks = normalizeBoardList([null, {}, { id: 1, status: "todo" }, { id: "x".repeat(200), title: "x".repeat(300),
    status: "unknown".repeat(20), assigneeAgentId: "secret-id", parentId: "p".repeat(200), createdAt: "invalid", startedAt: 123,
    completedAt: "infinity" }], { preset: "paperclip" });
  expect(tasks).toEqual([{ id: "x".repeat(128), title: "x".repeat(240), status: "unknown".repeat(20).slice(0, 64), unknown_status: true,
    assignee: null, parent_ids: ["p".repeat(128)], created_at: null, started_at: null, completed_at: null }]);
  expect(boundedParentIds(Array(40).fill("p".repeat(200)))).toEqual(Array(32).fill("p".repeat(128)));
  expect(boundedParentIds([null, 1, "", "p"])).toEqual(["p"]);
  expect(normalizeBoardList([{ id: "x", status: "todo", created_at: Infinity, started_at: NaN }])[0]).toMatchObject({ created_at: null, started_at: null });
  expect(() => normalizeBoardList(Array(10_001).fill({ id: "x", status: "todo" }))).toThrow("exceeds");
});

test("unknown statuses warn once with a bounded warning budget and never log raw status text", () => {
  const messages: string[] = [];
  const unsubscribe = dashBus.subscribe((event) => { if (event.type === "log" && event.message?.includes("unknown hermes status")) messages.push(event.message); });
  try {
    const row = { id: "x", status: "synthetic-private-status" };
    normalizeBoardList([row, row]);
    expect(messages).toHaveLength(1);
    normalizeBoardList(Array.from({ length: 200 }, (_, i) => ({ ...row, status: `synthetic-private-status-${i}` })));
    const count = messages.length;
    expect(count).toBeLessThanOrEqual(128);
    normalizeBoardList([{ ...row, status: "another-private-status" }]);
    expect(messages).toHaveLength(count);
    expect(messages.every((message) => !message.includes("private-status"))).toBe(true);
  } finally { unsubscribe(); }
});

test("started-ness requires canonical todo and no timestamp, including epoch zero", () => {
  for (const status of ["in_progress", "review", "blocked", "done", "cancelled", "custom"]) {
    expect(isUnstarted({ id: "x", title: "X", status, started_at: null })).toBe(false);
  }
  expect(isUnstarted({ id: "x", title: "X", status: "todo", started_at: 0 })).toBe(false);
  expect(isUnstarted({ id: "x", title: "X", status: "todo", started_at: null })).toBe(true);
});


test("briefings and operational reads consume canonical tasks and exclude unknown status collisions", async () => {
  const issues = ["todo", "in_progress", "in_review", "review", "cancelled", "custom"].map((status) => ({
    id: status, identifier: "DEV-1", title: `Task ${status}`, status, created_at: iso, updated_at: iso,
    assignee_type: null, assignee_id: null, parent_issue_id: null,
  }));
  const board = normalizeBoardList({ issues, total: issues.length, limit: 50, offset: 0, has_more: false }, { preset: "multica" });
  expect(composeBriefing([], board)).toBe('Morning briefing. Waiting on review: "Task in_review".');
  expect(composeBriefingDigest([], board)).toBe('☀️ Morning briefing\n\n━━━━━ waiting on review ━━━━━\n• "Task in_review"');
  const now = new Date(iso);
  const state = await snapshot({ now: () => now, startedAtMs: now.getTime(), board: () => ({
    asOfMs: now.getTime(), tasks: board, truncated: false, totalTasks: board.length,
  }) });
  expect(render(state)).toContain('"unstarted":{"count":1,"titles":["Task todo"]}');
  expect(render(state)).toContain('"review":{"count":1,"titles":["Task in_review"]}');
  // Force the compact renderer with dense escaped titles in each displayed group.
  state.board = { asOfMs: now.getTime(), truncated: false, totalTasks: board.length + 15,
    tasks: [...board, ...["todo", "blocked", "review"].flatMap((status) => Array.from({ length: 5 }, (_, i) => ({
      id: `${status}-${i}`, title: '"'.repeat(500), status,
    })))],
  };
  const compact = render(state);
  expect(compact).toContain('"unstarted_count":6');
  expect(compact).toContain('"review_count":6');
});

test("list failures do not expose board bodies or stderr", async () => {
  const secret = "synthetic-private-body";
  const runCommand: NonNullable<KanbanCommandOptions["runCommand"]> = async (command, options) => {
    const result = await fakeCommand({})(command, options);
    result.stdout.text = `{ invalid ${secret}`;
    return result;
  };
  await expect(listViaCli(["fake"], { runCommand })).rejects.toThrow("kanban list returned invalid JSON");
  const failing: NonNullable<KanbanCommandOptions["runCommand"]> = async (command, options) => {
    const result = await fakeCommand({})(command, options);
    result.exitCode = 1;
    result.stderr.text = secret;
    return result;
  };
  await expect(listViaCli(["fake"], { runCommand: failing })).rejects.toThrow("kanban list command exited 1");
});
