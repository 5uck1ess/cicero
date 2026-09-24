import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, SessionNotification } from "@zed-industries/agent-client-protocol";
import { AcpBrain, openAcpSession, resumableAcpSession, type AcpStructuredUpdate } from "../../src/brain/acp";
import { readAcpSession, writeAcpSession } from "../../src/brain/acp-session-store";
import { buildResumePrimer } from "../../src/web-voice/resume";
import { dashBus } from "../../src/dashboard/bus";
import { resolveAcpMcpServers } from "../../src/brain";

test("explicit ACP restart discards a completed turn's persisted pointer", async () => {
  const sessionFile = join(mkdtempSync(join(tmpdir(), "cicero-acp-explicit-reset-")), "session.json");
  await writeAcpSession(sessionFile, "identity", "completed-session", 1234);
  const brain = new AcpBrain({ binary: "unused", sessionFile });
  const control = brain as unknown as {
    stopCurrentRuntime: () => Promise<void>;
    ensureStarted: () => Promise<void>;
    skipStoredSession: boolean;
  };
  control.stopCurrentRuntime = async () => {};
  control.ensureStarted = async () => {};
  await brain.restart();
  const stored = await readAcpSession(sessionFile, "identity");
  expect(stored).toBeNull();
  expect(control.skipStoredSession).toBe(true);
  const calls: string[] = [];
  const connection = {
    loadSession: async () => { calls.push("load"); return {}; },
    newSession: async () => { calls.push("new"); return { sessionId: "fresh" }; },
  } as unknown as Parameters<typeof openAcpSession>[0];
  await openAcpSession(connection, { cwd: "/work", mcpServers: [] }, stored?.sessionId ?? null, true,
    async <T>(operation: Promise<T>): Promise<T> => operation);
  expect(calls).toEqual(["new"]);
});

test("ACP MCP environment names resolve to bounded protocol values without diagnostics containing values", () => {
  const configured = [{ name: "search", command: "search-mcp", args: ["--stdio"], env: ["SEARCH_TOKEN"] }];
  expect(resolveAcpMcpServers(configured, { SEARCH_TOKEN: "synthetic-secret" }))
    .toEqual([{ name: "search", command: "search-mcp", args: ["--stdio"], env: [{ name: "SEARCH_TOKEN", value: "synthetic-secret" }] }]);
  expect(() => resolveAcpMcpServers(configured, {})).toThrow(/SEARCH_TOKEN is unavailable/);
  expect(() => resolveAcpMcpServers(configured, { SEARCH_TOKEN: "x".repeat(4097) })).toThrow(/too long/);
});

test("ACP constructor rejects unsupported or oversized MCP server lists", () => {
  const server = { name: "search", command: "search-mcp", args: [], env: [] };
  expect(() => new AcpBrain({ binary: "unused", mcpServers: Array.from({ length: 9 }, (_, index) => ({ ...server, name: `server-${index}` })) })).toThrow(/at most 8/);
  expect(() => new AcpBrain({ binary: "unused", mcpServers: [{ ...server, type: "http" } as never] })).toThrow(/invalid stdio/);
});

test("ACP session setup loads only with capability and falls back after refusal", async () => {
  const calls: Array<{ method: string; id?: string; servers: number }> = [];
  let refuse = false;
  const connection = {
    loadSession: async (request: { sessionId: string; mcpServers: unknown[] }) => {
      calls.push({ method: "load", id: request.sessionId, servers: request.mcpServers.length });
      if (refuse) throw new Error("refused");
      return {};
    },
    newSession: async (request: { mcpServers: unknown[] }) => {
      calls.push({ method: "new", servers: request.mcpServers.length });
      return { sessionId: "fresh" };
    },
  } as unknown as Parameters<typeof openAcpSession>[0];
  const request = { cwd: "/work", mcpServers: [{ name: "search", command: "search-mcp", args: [], env: [] }] };
  const run = async <T>(operation: Promise<T>): Promise<T> => operation;
  expect(await openAcpSession(connection, request, "stored", true, run)).toEqual({ sessionId: "stored", restored: true });
  expect(calls).toEqual([{ method: "load", id: "stored", servers: 1 }]);
  calls.length = 0;
  expect(await openAcpSession(connection, request, "stored", false, run)).toEqual({ sessionId: "fresh", restored: false });
  expect(calls).toEqual([{ method: "new", servers: 1 }]);
  calls.length = 0;
  refuse = true;
  expect(await openAcpSession(connection, request, "stored", true, run)).toEqual({ sessionId: "fresh", restored: false });
  expect(calls.map((call) => call.method)).toEqual(["load", "new"]);
});

test("ACP session selection uses an injected clock and routes stale sessions to recap", async () => {
  let now = 20 * 3_600_000;
  const stored = { sessionId: "stored", lastUsedAt: now - 11 * 3_600_000 };
  const calls: string[] = [];
  const connection = {
    loadSession: async () => { calls.push("load"); return {}; },
    newSession: async () => { calls.push("new"); return { sessionId: "replacement" }; },
  } as unknown as Parameters<typeof openAcpSession>[0];
  const request = { cwd: "/work", mcpServers: [] };
  const run = async <T>(operation: Promise<T>): Promise<T> => operation;
  const open = async (enabled: boolean) => openAcpSession(connection, request, resumableAcpSession(stored, enabled, 12, now), true, run);
  expect(await open(true)).toEqual({ sessionId: "stored", restored: true });
  expect(buildResumePrimer([{ user: "hello", assistant: "hi" }], true)).toBeNull();
  now += 2 * 3_600_000;
  expect(await open(true)).toEqual({ sessionId: "replacement", restored: false });
  expect(buildResumePrimer([{ user: "hello", assistant: "hi" }], false)).not.toBeNull();
  expect(await open(false)).toEqual({ sessionId: "replacement", restored: false });
  expect(calls).toEqual(["load", "new", "new"]);
});

test("ACP ignores load-history and stale-session updates, and bounds structured turn events", async () => {
  const chunks: string[] = [];
  const observed: AcpStructuredUpdate[] = [];
  const perTurn: AcpStructuredUpdate[] = [];
  const dashboard: AcpStructuredUpdate[] = [];
  const brain = new AcpBrain({ binary: "unused", onStructuredUpdate: (update) => observed.push(update) });
  const runtime = { sessionId: null as string | null, activeTurn: null as unknown };
  const control = brain as unknown as { runtime: typeof runtime; makeClient: (runtime: typeof runtime) => Client };
  control.runtime = runtime;
  const client = control.makeClient(runtime);
  const unsubscribe = dashBus.subscribe((event) => { if (event.structured) dashboard.push(event.structured); });
  const send = (sessionId: string, update: SessionNotification["update"]) => client.sessionUpdate({ sessionId, update });
  try {
    await send("session-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old speech" } });
    runtime.sessionId = "session-1";
    runtime.activeTurn = { settled: false, cancelled: false, structured: [], onStructuredUpdate: (update: AcpStructuredUpdate) => perTurn.push(update), queue: { push: (text: string) => chunks.push(text) } };
    await send("stale-session", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stale speech" } });
    await send("stale-session", { sessionUpdate: "tool_call", toolCallId: "stale", title: "stale", status: "failed" });
    await send("session-1", { sessionUpdate: "plan", entries: Array.from({ length: 100 }, (_, index) => ({ content: `Task ${index} ${"x".repeat(500)}`, priority: "high", status: "pending" })) });
    for (let index = 0; index < 100; index++) {
      await send("session-1", { sessionUpdate: "tool_call", toolCallId: `tool-${index}`, title: "token=synthetic-secret", kind: "search", status: "pending", rawInput: { secret: "synthetic-secret" } });
    }
    expect(chunks).toEqual([]);
    expect(observed).toHaveLength(64);
    expect(dashboard).toHaveLength(64);
    expect(perTurn).toHaveLength(64);
    expect(observed[0]?.entries).toHaveLength(32);
    expect(observed[0]?.entries?.[0]?.title.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(observed)).not.toContain("synthetic-secret");
    expect(JSON.stringify(observed)).not.toContain("stale");
    runtime.activeTurn = { settled: false, cancelled: true, structured: [], onStructuredUpdate: (update: AcpStructuredUpdate) => perTurn.push(update), queue: { push: (text: string) => chunks.push(text) } };
    await send("session-1", { sessionUpdate: "tool_call_update", toolCallId: "late", status: "completed" });
    expect(observed).toHaveLength(64);
  } finally {
    unsubscribe();
  }
});

test("status-only ACP tool updates retain identity and replace the matching bounded turn entry", async () => {
  const callbacks: AcpStructuredUpdate[] = [];
  const busEvents: AcpStructuredUpdate[] = [];
  const brain = new AcpBrain({ binary: "unused" });
  const activeTurn = { settled: false, cancelled: false, structured: [] as AcpStructuredUpdate[], queue: { push: () => {} }, onStructuredUpdate: (update: AcpStructuredUpdate) => callbacks.push(update) };
  const runtime = { sessionId: "session-1", activeTurn };
  const control = brain as unknown as { runtime: typeof runtime; makeClient: (runtime: typeof runtime) => Client };
  control.runtime = runtime;
  const client = control.makeClient(runtime);
  const unsubscribe = dashBus.subscribe((event) => { if (event.structured) busEvents.push(event.structured); });
  try {
    await client.sessionUpdate({ sessionId: "session-1", update: { sessionUpdate: "tool_call", toolCallId: "first", title: "Search files", status: "pending" } });
    await client.sessionUpdate({ sessionId: "session-1", update: { sessionUpdate: "tool_call", toolCallId: "second", title: "Write patch", status: "pending" } });
    for (let index = 0; index < 62; index++) {
      await client.sessionUpdate({ sessionId: "session-1", update: { sessionUpdate: "plan", entries: [] } });
    }
    await client.sessionUpdate({ sessionId: "session-1", update: { sessionUpdate: "tool_call_update", toolCallId: "second", status: "completed" } });
    expect(activeTurn.structured).toHaveLength(64);
    expect(activeTurn.structured[0]).toMatchObject({ toolCallId: "first", title: "Search files", status: "pending" });
    expect(activeTurn.structured[1]).toMatchObject({ toolCallId: "second", title: "Write patch", status: "completed" });
    expect(callbacks.at(-1)).toMatchObject({ toolCallId: "second", title: "Write patch", status: "completed" });
    expect(busEvents.at(-1)).toMatchObject({ toolCallId: "second", title: "Write patch", status: "completed" });
    for (let index = 0; index < 100; index++) {
      await client.sessionUpdate({ sessionId: "session-1", update: { sessionUpdate: "tool_call_update", toolCallId: "second", status: index % 2 ? "completed" : "in_progress" } });
    }
    expect(activeTurn.structured).toHaveLength(64);
    expect(callbacks).toHaveLength(128);
    expect(busEvents).toHaveLength(128);
  } finally {
    unsubscribe();
  }
});
