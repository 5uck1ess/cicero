import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
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

test("dashboard renders plan and tool rows and updates the matching tool row in place", () => {
  // Run the exact browser row renderer without binding a localhost port.
  const source = readFileSync(join(import.meta.dir, "../../src/dashboard/server.ts"), "utf8");
  const start = source.indexOf("const toolRows = new Map();");
  const end = source.indexOf("function setConfig(c) {", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const rows = new FakeElement();
  const addRow = runInNewContext(`${source.slice(start, end)}\naddRow`, {
    document: { createElement: () => new FakeElement() }, rows, cleared: false, time: () => "00:00:00", Map,
  }) as (event: DashEvent) => void;
  const events: DashEvent[] = [];
  const unsubscribe = dashBus.subscribe((event) => { if (event.type === "structured") events.push(event); });
  try {
    dashBus.structured({ kind: "plan", entries: [{ title: "Inspect files", status: "in_progress" }] });
    dashBus.structured({ kind: "tool_call", toolCallId: "first", title: "Search files", status: "pending" });
    dashBus.structured({ kind: "tool_call", toolCallId: "second", title: "Write patch", status: "pending" });
    dashBus.structured({ kind: "tool_call_update", toolCallId: "second", title: "Write patch", status: "completed" });
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
