import { test, expect, afterAll } from "bun:test";
import {
  MAX_CONCURRENT_DASHBOARD_CONTROLS,
  MAX_DASHBOARD_CLIENTS,
  MAX_DASHBOARD_CONTROL_JSON_BYTES,
  MAX_DASHBOARD_WS_PAYLOAD_BYTES,
  startDashboard,
  type VoiceControlAction,
} from "../../src/dashboard/server";
import { dashBus, type DashEvent } from "../../src/dashboard/bus";

// port 0 → OS picks a free port, so the test never collides with a real daemon.
const controlCalls: VoiceControlAction[] = [];
const TOKEN = "dashboard-test-token";
const dash = startDashboard({ port: 0, token: TOKEN, onControl: (a) => controlCalls.push(a) });
if (!dash) throw new Error("dashboard failed to start");
afterAll(() => dash.stop());

test("serves the dashboard HTML at /", async () => {
  const res = await fetch(`${dash.url}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  const body = await res.text();
  expect(body).toContain("CICERO");
  expect(body).toContain(`const dashboardToken = "${TOKEN}"`);
  expect(body).not.toContain("__CICERO_DASHBOARD_TOKEN__");
});

test("404s unknown paths", async () => {
  const res = await fetch(`${dash.url}/does-not-exist`);
  expect(res.status).toBe(404);
});

test("dashboard page does not expose its socket token cross-origin", () => {
  return fetch(`${dash.url}/`, { headers: { Origin: "https://evil.example" } })
    .then((res) => {
      expect(res.status).toBe(403);
      return res.text();
    })
    .then((body) => { expect(body).not.toContain(TOKEN); })
    .catch((err: unknown) => { throw err; });
});

const TRUSTED = { "Content-Type": "application/json", "X-Cicero-Dashboard": "1" } as const;

test("POST /api/voice forwards a valid action to onControl", async () => {
  controlCalls.length = 0;
  const res = await fetch(`${dash.url}/api/voice`, {
    method: "POST",
    headers: TRUSTED,
    body: JSON.stringify({ action: "toggle" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(true);
  expect(controlCalls).toEqual(["toggle"]);
});

test("POST /api/voice rejects an unknown action without calling onControl", async () => {
  controlCalls.length = 0;
  const res = await fetch(`${dash.url}/api/voice`, {
    method: "POST",
    headers: TRUSTED,
    body: JSON.stringify({ action: "explode" }),
  });
  expect(res.status).toBe(400);
  expect(controlCalls).toEqual([]);
});

test("POST /api/voice rejects malformed JSON", async () => {
  controlCalls.length = 0;
  const res = await fetch(`${dash.url}/api/voice`, {
    method: "POST",
    headers: TRUSTED,
    body: "{not json",
  });
  expect(res.status).toBe(400);
  expect(controlCalls).toEqual([]);
});

test("POST /api/voice accepts an exact-cap valid control body", async () => {
  try {
    controlCalls.length = 0;
    const prefix = '{"action":"toggle","padding":"';
    const suffix = '"}';
    const body = prefix + "x".repeat(MAX_DASHBOARD_CONTROL_JSON_BYTES - Buffer.byteLength(prefix + suffix)) + suffix;
    expect(Buffer.byteLength(body)).toBe(MAX_DASHBOARD_CONTROL_JSON_BYTES);
    const res = await fetch(`${dash.url}/api/voice`, {
      method: "POST",
      headers: TRUSTED,
      body,
    });
    expect(res.status).toBe(200);
    expect(controlCalls).toEqual(["toggle"]);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
});

test("POST /api/voice rejects the first byte above its exact body cap", async () => {
  controlCalls.length = 0;
  const res = await fetch(`${dash.url}/api/voice`, {
    method: "POST",
    headers: TRUSTED,
    body: new Uint8Array(MAX_DASHBOARD_CONTROL_JSON_BYTES + 1),
  });
  expect(res.status).toBe(413);
  expect(res.headers.get("connection")).toBe("close");
  expect(controlCalls).toEqual([]);
});

test("POST /api/voice applies one absolute deadline to a stalled chunked body", async () => {
  let calls = 0;
  const local = startDashboard({
    port: 0,
    token: "dashboard-body-timeout",
    bodyReadTimeoutMs: 20,
    onControl: () => { calls += 1; },
  });
  if (!local) throw new Error("body-timeout dashboard failed to start");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"action":"'));
    },
  });
  try {
    const res = await fetch(`${local.url}/api/voice`, {
      method: "POST",
      headers: TRUSTED,
      body,
    });
    expect(res.status).toBe(408);
    expect(res.headers.get("connection")).toBe("close");
    expect(calls).toBe(0);
  } finally {
    await local.stop();
  }
});

test("dashboard control admission is capped before stalled bodies accumulate", async () => {
  let calls = 0;
  const local = startDashboard({
    port: 0,
    token: "dashboard-admission-test",
    onControl: () => { calls += 1; },
  });
  if (!local) throw new Error("admission-test dashboard failed to start");
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const requests: Array<Promise<Response>> = [];
  try {
    for (let index = 0; index < MAX_CONCURRENT_DASHBOARD_CONTROLS; index++) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller);
          controller.enqueue(new TextEncoder().encode('{"action":"'));
        },
      });
      requests.push(fetch(`${local.url}/api/voice`, {
        method: "POST",
        headers: TRUSTED,
        body,
      }));
    }
    await Bun.sleep(50);

    const overflow = await fetch(`${local.url}/api/voice`, {
      method: "POST",
      headers: TRUSTED,
      body: JSON.stringify({ action: "toggle" }),
    });
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get("connection")).toBe("close");

    for (const controller of controllers) {
      controller.enqueue(new TextEncoder().encode('toggle"}'));
      controller.close();
    }
    const responses = await Promise.all(requests);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(calls).toBe(MAX_CONCURRENT_DASHBOARD_CONTROLS);
  } finally {
    for (const controller of controllers) {
      try { controller.close(); } catch { /* already closed */ }
    }
    await local.stop();
  }
});

test("POST /api/voice rejects a request missing the dashboard header (CSRF guard)", async () => {
  controlCalls.length = 0;
  const res = await fetch(`${dash.url}/api/voice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "toggle" }),
  });
  expect(res.status).toBe(403);
  expect(res.headers.get("connection")).toBe("close");
  expect(controlCalls).toEqual([]);
});

test("POST /api/voice rejects a cross-origin request", async () => {
  controlCalls.length = 0;
  const res = await fetch(`${dash.url}/api/voice`, {
    method: "POST",
    headers: { ...TRUSTED, Origin: "https://evil.example" },
    body: JSON.stringify({ action: "toggle" }),
  });
  expect(res.status).toBe(403);
  expect(controlCalls).toEqual([]);
});

test("WebSocket receives a snapshot then live state events", async () => {
  const ws = new WebSocket(`${dash.url.replace("http", "ws")}/ws?token=${TOKEN}`);
  const messages: DashEvent[] = [];
  ws.addEventListener("message", (ev) => {
    messages.push(JSON.parse((ev as MessageEvent).data as string) as DashEvent);
  });
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));

  async function waitFor(pred: (e: DashEvent) => boolean, ms = 3000): Promise<DashEvent> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = messages.find(pred);
      if (hit) return hit;
      await Bun.sleep(20);
    }
    throw new Error("timed out waiting for matching dashboard event");
  }

  const snap = await waitFor((e) => e.type === "snapshot");
  expect(snap.type).toBe("snapshot");

  // Force a state transition and confirm it streams to the client.
  dashBus.setState("idle");
  dashBus.setState("listening");
  const st = await waitFor((e) => e.type === "state" && e.state === "listening");
  expect(st.state).toBe("listening");

  ws.close();
});

test("dashboard WebSocket closes clients that send to its read-only channel", async () => {
  const ws = new WebSocket(`${dash.url.replace("http", "ws")}/ws?token=${TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("dashboard websocket failed to open")), { once: true });
  });
  const closed = new Promise<CloseEvent>((resolve) => {
    ws.addEventListener("close", (event) => resolve(event), { once: true });
  });
  ws.send("{}");
  const event = await closed;
  expect(event.code).toBe(1008);
  expect(event.reason).toContain("read-only");
});

test("dashboard WebSocket rejects the first byte above its payload cap", async () => {
  const ws = new WebSocket(`${dash.url.replace("http", "ws")}/ws?token=${TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("dashboard websocket failed to open")), { once: true });
  });
  const closed = new Promise<CloseEvent>((resolve) => {
    ws.addEventListener("close", (event) => resolve(event), { once: true });
  });
  ws.send("x".repeat(MAX_DASHBOARD_WS_PAYLOAD_BYTES + 1));
  const event = await closed;
  expect([1009, 1006]).toContain(event.code);
});

function socketOpens(url: string, headers?: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* upgrade was rejected */ }
      resolve(opened);
    };
    const timer = setTimeout(() => finish(false), 2000);
    ws.addEventListener("open", () => finish(true));
    ws.addEventListener("error", () => finish(false));
    ws.addEventListener("close", () => finish(false));
  });
}

test("dashboard WebSocket admission caps opened and pending clients", async () => {
  const localToken = "dashboard-client-cap-token";
  const local = startDashboard({ port: 0, token: localToken });
  if (!local) throw new Error("client-cap dashboard failed to start");
  const sockets: WebSocket[] = [];
  const url = `${local.url.replace("http", "ws")}/ws?token=${localToken}`;
  try {
    for (let index = 0; index < MAX_DASHBOARD_CLIENTS; index++) {
      const ws = new WebSocket(url);
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("dashboard websocket failed to open")), { once: true });
      });
    }
    expect(await socketOpens(url)).toBe(false);
  } finally {
    for (const ws of sockets) ws.close();
    await local.stop();
  }
});

test("WebSocket rejects unauthenticated clients before sending history", () => {
  return socketOpens(`${dash.url.replace("http", "ws")}/ws`)
    .then((opened) => { expect(opened).toBe(false); })
    .catch((err: unknown) => { throw err; });
});

test("WebSocket rejects cross-origin clients even with a valid token", () => {
  return socketOpens(
    `${dash.url.replace("http", "ws")}/ws?token=${TOKEN}`,
    { Origin: "https://evil.example" },
  )
    .then((opened) => { expect(opened).toBe(false); })
    .catch((err: unknown) => { throw err; });
});

test("logger-style messages derive the state pill", () => {
  dashBus.setState("idle");
  dashBus.log("🔊", "Speaking result (summary)...");
  expect(dashBus.state).toBe("speaking");
  dashBus.log("🎤", 'Heard: "what time is it"');
  expect(dashBus.state).toBe("thinking");
});

test("stop quiesces the dashboard and waits for an active control transition", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const controlStarted = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const local = startDashboard({
    port: 0,
    token: "shutdown-test-token",
    onControl: () => {
      calls += 1;
      started();
      return gate;
    },
  });
  if (!local) throw new Error("shutdown-test dashboard failed to start");

  const request = fetch(`${local.url}/api/voice`, {
    method: "POST",
    headers: TRUSTED,
    body: JSON.stringify({ action: "activate" }),
  }).catch(() => null);
  await controlStarted;

  const stopping = local.stop();
  let settled = false;
  void stopping.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await Bun.sleep(10);
  expect(settled).toBe(false);
  expect(calls).toBe(1);

  release();
  await stopping;
  await request;
  expect(settled).toBe(true);
  await expect(local.stop()).resolves.toBeUndefined();
});

test("a dashboard drain timeout stays fail-closed and a later stop retries", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const controlStarted = new Promise<void>((resolve) => { started = resolve; });
  const local = startDashboard({
    port: 0,
    token: "shutdown-retry-token",
    shutdownDrainTimeoutMs: 20,
    onControl: () => {
      started();
      return gate;
    },
  });
  if (!local) throw new Error("shutdown-retry dashboard failed to start");
  const request = fetch(`${local.url}/api/voice`, {
    method: "POST",
    headers: TRUSTED,
    body: JSON.stringify({ action: "activate" }),
  }).catch(() => null);

  try {
    await controlStarted;
    await expect(local.stop()).rejects.toThrow("did not drain within 20ms");
    release();
    await request;
    await expect(local.stop()).resolves.toBeUndefined();
  } finally {
    release();
    await request;
    await local.stop().catch(() => {});
  }
});
