import { expect, test } from "bun:test";
import { KanbanWatcher } from "../../src/notify/kanban-watch";

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test("push refreshes through the existing transition path before the poll cadence", async () => {
  let change = () => {};
  let status = "in_progress";
  const announcements: string[] = [];
  let stopped = false;
  const watcher = new KanbanWatcher({
    list: async () => [{ id: "one", title: "One", status }],
    announce: (task) => { announcements.push(task.status); },
    intervalMs: 60_000,
    realtime: {
      start(onChange: () => void) { change = onChange; },
      stop() { stopped = true; },
    },
  });
  try {
    watcher.start();
    await settle();
    status = "review";
    change();
    await settle();
    expect(announcements).toEqual(["review"]);
  } finally { await watcher.stop(); }
  expect(stopped).toBe(true);
});

import { createBoardRealtime, validRealtimeConfig, type BoardSocket, type BoardRealtimeDependencies } from "../../src/notify/board-realtime";

class FakeSocket implements BoardSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  terminated = false;
  send(data: string) { this.sent.push(data); }
  terminate() { this.terminated = true; }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
function harness(preset: "multica" | "paperclip" = "multica") {
  let clock = 0, next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sockets: FakeSocket[] = [];
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const deps: BoardRealtimeDependencies = {
    token: () => "synthetic-secret",
    socket: (url, headers) => { requests.push({ url, headers }); const s = new FakeSocket(); sockets.push(s); return s; },
    setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { at: clock + ms, fn }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: (id) => { timers.delete(id as unknown as number); },
  };
  const feed = createBoardRealtime(preset, { server_url: "https://board.example", scope_id: "scope", token_env: "BOARD_TOKEN" }, deps)!;
  const states: boolean[] = [];
  let changes = 0;
  feed.start(() => changes++, (ready) => states.push(ready));
  const advance = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); clock = due[1].at; due[1].fn();
    }
    clock = end;
  };
  return { feed, sockets, requests, states, advance, timers, changes: () => changes };
}

test("Multica waits for auth_ack, filters events, reconnects with catch-up and releases ownership", () => {
  const h = harness();
  try {
    const s = h.sockets[0]!;
    expect(h.requests[0]).toEqual({ url: "wss://board.example/ws?workspace_id=scope", headers: {} });
    s.onopen?.();
    expect(JSON.parse(s.sent[0]!)).toEqual({ type: "auth", payload: { token: "synthetic-secret" } });
    expect(h.states).toEqual([]);
    s.message({ type: "issue:updated", workspace_id: "scope" });
    expect(h.changes()).toBe(0);
    s.message({ type: "auth_ack" });
    expect(h.states).toEqual([true]);
    s.message({ type: "issue:updated", workspace_id: "other" });
    s.message({ type: "task:log", workspace_id: "scope" });
    s.onmessage?.({ data: "{" });
    expect(h.changes()).toBe(0);
    s.message({ type: "issue:updated", workspace_id: "scope" });
    expect(h.changes()).toBe(1);
    const late = s.onmessage!;
    s.onclose?.();
    expect(s.terminated).toBe(true);
    expect(h.states).toEqual([true, false]);
    h.advance(999); expect(h.sockets.length).toBe(1);
    h.advance(1); expect(h.sockets.length).toBe(2);
    late({ data: JSON.stringify({ type: "issue:updated" }) });
    expect(h.changes()).toBe(1);
    const second = h.sockets[1]!;
    second.onopen?.(); second.message({ type: "auth_ack" });
    expect(h.states).toEqual([true, false, true]);
  } finally { h.feed.stop(); }
  expect(h.sockets.every((s) => s.terminated)).toBe(true);
  expect(h.timers.size).toBe(0);
  h.advance(1_000_000); expect(h.sockets.length).toBe(2);
});

test("Paperclip authenticates in a header and invalidates only scoped activity", () => {
  const h = harness("paperclip");
  try {
    expect(h.requests[0]).toEqual({ url: "wss://board.example/api/companies/scope/events/ws", headers: { Authorization: "Bearer synthetic-secret" } });
    const s = h.sockets[0]!;
    s.onopen?.();
    expect(h.states).toEqual([true]);
    s.message({ type: "heartbeat.run.log", companyId: "scope" });
    s.message({ type: "activity.logged", companyId: "other" });
    expect(h.changes()).toBe(0);
    s.message({ type: "activity.logged", companyId: "scope", payload: { entityType: "issue", action: "issue.updated" } });
    expect(h.changes()).toBe(1);
    s.onmessage?.({ data: "x".repeat(65_537) });
    expect(h.states).toEqual([true, false]);
    expect(s.terminated).toBe(true);
  } finally { h.feed.stop(); }
});

test("connect/auth deadlines and repeated failures use capped backoff, then stop cancels retry", () => {
  const h = harness();
  try {
    h.advance(10_000);
    expect(h.sockets[0]!.terminated).toBe(true);
    expect(h.states).toEqual([false]);
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const count = h.sockets.length;
      h.advance(delay - 1); expect(h.sockets.length).toBe(count);
      h.advance(1); expect(h.sockets.length).toBe(count + 1);
      h.sockets.at(-1)!.onopen?.();
      h.sockets.at(-1)!.message({ error: "synthetic-secret" });
    }
  } finally { h.feed.stop(); }
  expect(h.timers.size).toBe(0);
});

test("optional transport leaves Hermes unchanged and rejects unsafe configuration", () => {
  expect(createBoardRealtime("hermes", undefined)).toBeUndefined();
  const good = { server_url: "https://board.example", scope_id: "scope", token_env: "BOARD_TOKEN" };
  expect(validRealtimeConfig(good)).toBe(true);
  for (const server_url of ["https://user:secret@board.example", "https://board.example?token=secret", "ftp://board.example", "https://board.example/path"]) {
    expect(validRealtimeConfig({ ...good, server_url })).toBe(false);
  }
  expect(() => createBoardRealtime("hermes", good)).toThrow("invalid kanban realtime configuration");
});

test("event bursts during an in-flight read trigger one subsequent authoritative read", async () => {
  let change = () => {};
  let ready = (_value: boolean) => {};
  let finish: ((tasks: { id: string; title: string; status: string }[]) => void) | undefined;
  let reads = 0;
  const announcements: string[] = [];
  const watcher = new KanbanWatcher({
    intervalMs: 60_000,
    list: async () => {
      reads++;
      if (reads === 2) return new Promise((resolve) => { finish = resolve; });
      return [{ id: "one", title: "One", status: reads === 1 ? "in_progress" : "done" }];
    },
    announce: (task) => { announcements.push(task.status); },
    realtime: { start(c, r) { change = c; ready = r; }, stop() {} },
  });
  try {
    watcher.start(); await settle();
    ready(true); await settle();
    expect(reads).toBe(2);
    for (let i = 0; i < 100; i++) change();
    finish!([{ id: "one", title: "One", status: "in_progress" }]);
    await settle();
    expect(reads).toBe(3);
    expect(announcements).toEqual(["done"]);
    ready(false); await settle();
    expect(reads).toBe(4);
  } finally { await watcher.stop(); }
  change(); ready(true); await settle();
  expect(reads).toBe(4);
});

test("Bun client sends Paperclip's bearer header and terminates a real local socket", async () => {
  let authorization: string | null = null;
  let opened!: () => void;
  const open = new Promise<void>((resolve) => { opened = resolve; });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) {
      authorization = req.headers.get("authorization");
      if (server.upgrade(req)) return;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: { message() {} },
  });
  const feed = createBoardRealtime("paperclip", { server_url: `http://127.0.0.1:${server.port}`, scope_id: "scope", token_env: "BOARD_TOKEN" }, { token: () => "synthetic-secret" })!;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    feed.start(() => {}, (ready) => { if (ready) opened(); });
    await Promise.race([open, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("local socket did not open")), 1000); })]);
    expect(authorization).toBe("Bearer synthetic-secret");
  } finally { clearTimeout(deadline); feed.stop(); await server.stop(true); }
});

test("connected boards suppress short cadence polling and disconnected boards resume it", async () => {
  let ready = (_value: boolean) => {};
  let reads = 0;
  const watcher = new KanbanWatcher({
    intervalMs: 10,
    list: async () => { reads++; return []; },
    announce() {},
    realtime: { start(_c, r) { ready = r; r(true); }, stop() {} },
  });
  try {
    watcher.start(); await settle();
    const caughtUp = reads;
    await settle(); expect(reads).toBe(caughtUp);
    ready(false); await settle();
    expect(reads).toBeGreaterThan(caughtUp + 1);
  } finally { await watcher.stop(); }
});

test("absent credentials and constructor failure fall back without escaping provider errors", () => {
  for (const token of [undefined, "synthetic-secret"]) {
    let scheduled = 0;
    const states: boolean[] = [];
    const feed = createBoardRealtime("multica", { server_url: "https://board.example", scope_id: "scope", token_env: "BOARD_TOKEN" }, {
      token: () => token,
      socket() { throw new Error("synthetic-secret"); },
      setTimeout: () => { scheduled++; return 1; },
      clearTimeout: () => { scheduled--; },
    })!;
    expect(() => feed.start(() => {}, (ready) => states.push(ready))).not.toThrow();
    expect(states).toEqual([false]);
    expect(scheduled).toBe(1);
    feed.stop(); expect(scheduled).toBe(0);
  }
});
