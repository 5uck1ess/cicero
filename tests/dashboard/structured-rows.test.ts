import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { AcpBrain } from "../../src/brain/acp";
import { dashBus, type DashEvent } from "../../src/dashboard/bus";

class FakeElement {
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  textContent = "";
  className = "";
  scrollTop = 0;
  scrollHeight = 0;
  set innerHTML(value: string) {
    this.children = value.includes("<span") ? [new FakeElement(), new FakeElement()] : [];
  }
  appendChild(child: FakeElement) { this.children.push(child); return child; }
  removeChild(child: FakeElement) { this.children.splice(this.children.indexOf(child), 1); return child; }
  get firstChild() { return this.children[0]; }
  contains(child: FakeElement) { return this.children.includes(child); }
}

function rowRenderer(rows: FakeElement): (event: DashEvent) => void {
  const source = readFileSync(join(import.meta.dir, "../../src/dashboard/server.ts"), "utf8");
  const start = source.indexOf("const toolRows = new Map();");
  const end = source.indexOf("function setConfig(c) {", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return runInNewContext(`${source.slice(start, end)}\naddRow`, {
    document: { createElement: () => new FakeElement() }, rows, cleared: false, time: () => "00:00:00", Map,
  }) as (event: DashEvent) => void;
}

async function emitTool(brain: AcpBrain, sessionId: string, toolCallId: string, title: string, rowTurnId = "turn-0"): Promise<void> {
  const activeTurn = { settled: false, cancelled: false, structured: [], rowTurnId, queue: { push: () => {} } };
  const runtime = { sessionId, activeTurn };
  const control = brain as unknown as { runtime: typeof runtime; makeClient: (runtime: typeof runtime) => { sessionUpdate: (event: unknown) => Promise<void> } };
  control.runtime = runtime;
  await control.makeClient(runtime).sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call", toolCallId, title, status: "pending" } });
}

test("dashboard renders plan and tool rows and updates the matching tool row in place", () => {
  // Run the exact browser row renderer without binding a localhost port.
  const rows = new FakeElement();
  const addRow = rowRenderer(rows);
  const events: DashEvent[] = [];
  const unsubscribe = dashBus.subscribe((event) => { if (event.type === "structured") events.push(event); });
  try {
    dashBus.structured({ kind: "plan", entries: [{ title: "Inspect files", status: "in_progress" }] });
    dashBus.structured({ kind: "tool_call", sourceId: "test-brain", turnId: "turn-1", toolCallId: "first", title: "Search files", status: "pending" });
    dashBus.structured({ kind: "tool_call", sourceId: "test-brain", turnId: "turn-1", toolCallId: "second", title: "Write patch", status: "pending" });
    dashBus.structured({ kind: "tool_call_update", sourceId: "test-brain", turnId: "turn-1", toolCallId: "second", title: "Write patch", status: "completed" });
    for (const event of events) addRow(event);
    expect(rows.children).toHaveLength(3);
    expect(rows.children[0]?.children[1]?.textContent).toMatch(/plan.*Inspect files.*in_progress/i);
    expect(rows.children[1]?.children[1]?.textContent).toMatch(/Search files.*pending/);
    expect(rows.children[2]?.children[1]?.textContent).toMatch(/Write patch.*completed/);
    expect(rows.children[0]?.children[1]?.textContent).not.toBe("•  ");
    dashBus.structured({ kind: "tool_call", toolCallId: "sensitive", title: `token=synthetic-secret ${"x".repeat(500)}`, status: "pending" });
    const sanitized = events.at(-1)!;
    addRow(sanitized);
    expect(rows.children.at(-1)?.children[1]?.textContent).not.toContain("synthetic-secret");
    expect(sanitized.message!.length).toBeLessThanOrEqual(256);
  } finally {
    unsubscribe();
  }
});

test("dashboard keeps reused tool IDs in separate turns as separate rows", async () => {
  const rows = new FakeElement();
  const addRow = rowRenderer(rows);
  const events: DashEvent[] = [];
  const unsubscribe = dashBus.subscribe((event) => { if (event.type === "structured") events.push(event); });
  try {
    const brain = new AcpBrain({ binary: "unused" });
    await emitTool(brain, "same-session", "tool-1", "First turn", "turn-1");
    await emitTool(brain, "same-session", "tool-1", "Second turn", "turn-2");
    for (const event of events) addRow(event);
    expect(rows.children).toHaveLength(2);
  } finally { unsubscribe(); }
});

test("dashboard keeps distinct UUID tool calls through ACP and the real redactor", async () => {
  const rows = new FakeElement();
  const addRow = rowRenderer(rows);
  const events: DashEvent[] = [];
  const unsubscribe = dashBus.subscribe((event) => { if (event.type === "structured") events.push(event); });
  try {
    const brain = new AcpBrain({ binary: "unused" });
    await emitTool(brain, "session-1", "550e8400-e29b-41d4-a716-446655440000", "First tool");
    await emitTool(brain, "session-1", "550e8400-e29b-41d4-a716-446655440001", "Second tool");
    for (const event of events) addRow(event);
    expect(rows.children).toHaveLength(2);
    expect(rows.children.map((row) => row.children[1]?.textContent)).toEqual(["•  tool First tool: pending", "•  tool Second tool: pending"]);
    expect(events[0]?.structured?.toolCallId).not.toBe("<redacted>");
    expect(events[0]?.structured?.toolCallId).not.toBe(events[1]?.structured?.toolCallId);
  } finally { unsubscribe(); }
});

test("dashboard keeps same tool ID from front desk and lane as separate rows", async () => {
  const rows = new FakeElement();
  const addRow = rowRenderer(rows);
  const events: DashEvent[] = [];
  const unsubscribe = dashBus.subscribe((event) => { if (event.type === "structured") events.push(event); });
  try {
    await emitTool(new AcpBrain({ binary: "unused" }), "same-session", "tool-1", "Front desk tool");
    await emitTool(new AcpBrain({ binary: "unused" }), "same-session", "tool-1", "Lane tool");
    for (const event of events) addRow(event);
    expect(rows.children).toHaveLength(2);
    expect(rows.children[0]?.children[1]?.textContent).toContain("Front desk tool");
    expect(rows.children[1]?.children[1]?.textContent).toContain("Lane tool");
    expect(events[0]?.structured?.sourceId).not.toBe("<redacted>");
    expect(events[0]?.structured?.sourceId).not.toBe(events[1]?.structured?.sourceId);
  } finally { unsubscribe(); }
});
