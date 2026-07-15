import { expect, test } from "bun:test";
import { HermesGatewayBrain } from "../../src/brain/hermes-gateway";

type RequestFrame = {
  id: number;
  method: string;
  params: Record<string, unknown>;
};

class FakeGatewaySocket extends EventTarget {
  readyState = WebSocket.CONNECTING;
  readonly requests: RequestFrame[] = [];

  constructor(
    private readonly onRequest: (request: RequestFrame, socket: FakeGatewaySocket) => void,
    autoOpen = true,
  ) {
    super();
    if (autoOpen) {
      queueMicrotask(() => {
        this.readyState = WebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      });
    }
  }

  send(raw: string): void {
    const request = JSON.parse(raw) as RequestFrame;
    this.requests.push(request);
    this.onRequest(request, this);
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }

  respond(request: RequestFrame, result: unknown): void {
    this.frame({ jsonrpc: "2.0", id: request.id, result });
  }

  event(type: string, sessionId: string, payload: Record<string, unknown> = {}): void {
    this.frame({
      jsonrpc: "2.0",
      method: "event",
      params: { type, session_id: sessionId, payload },
    });
  }

  private frame(frame: unknown): void {
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })));
  }
}

function liveSession() {
  return { id: "live-1", session_key: "20260715_main", title: "main", status: "idle" };
}

test("attaches to the named live Hermes session and streams its real agent reply", async () => {
  let prompt = "";
  let activeLists = 0;
  let socket!: FakeGatewaySocket;
  socket = new FakeGatewaySocket((request, peer) => {
    if (request.method === "session.active_list") {
      activeLists++;
      peer.respond(request, {
        sessions: [{ ...liveSession(), title: activeLists === 1 ? "main" : "auto-generated title" }],
      });
    } else if (request.method === "session.activate") peer.respond(request, { session_id: "live-1" });
    else if (request.method === "prompt.submit") {
      prompt = String(request.params.text);
      peer.respond(request, { status: "streaming" });
      peer.event("message.delta", "live-1", { text: "same " });
      peer.event("message.delta", "live-1", { text: "agent" });
      peer.event("message.complete", "live-1", { text: "same agent", status: "complete" });
    }
  });
  const brain = new HermesGatewayBrain({
    url: "ws://127.0.0.1:9119/api/ws?token=secret",
    session: "main",
    socketFactory: () => socket as unknown as WebSocket,
  });

  await brain.start();
  brain.injectContext("The voice user is looking at the deploy screen.");
  expect(await brain.send("what changed?")).toBe("same agent");
  expect(prompt).toContain("The voice user is looking at the deploy screen.");
  expect(prompt).toContain("what changed?");
  expect(socket.requests.filter((request) => request.method === "session.create")).toHaveLength(0);
  expect(socket.requests.filter((request) => request.method === "session.activate")).toHaveLength(1);
  expect(socket.requests.find((request) => request.method === "prompt.submit")?.params.session_id).toBe("live-1");
});

test("fails closed instead of creating a standalone session when the selector misses", async () => {
  const socket = new FakeGatewaySocket((request, peer) => {
    if (request.method === "session.active_list") peer.respond(request, { sessions: [liveSession()] });
  });
  const brain = new HermesGatewayBrain({
    url: "ws://127.0.0.1:9119/api/ws?token=secret",
    session: "other",
    socketFactory: () => socket as unknown as WebSocket,
  });

  await expect(brain.start()).rejects.toThrow(/live Hermes session 'other' was not found.*main/);
  expect(socket.requests.some((request) => request.method === "session.create")).toBe(false);
});

test("fails immediately when the gateway closes during startup", async () => {
  const socket = new FakeGatewaySocket(() => undefined, false);
  queueMicrotask(() => socket.close());
  const brain = new HermesGatewayBrain({
    url: "ws://127.0.0.1:9119/api/ws?token=secret",
    session: "main",
    connectTimeoutMs: 1_000,
    socketFactory: () => socket as unknown as WebSocket,
  });

  await expect(brain.start()).rejects.toThrow("Hermes gateway connection closed during startup");
});

test("resolves Hermes approval requests on the attached session", async () => {
  const socket = new FakeGatewaySocket((request, peer) => {
    if (request.method === "session.active_list") peer.respond(request, { sessions: [liveSession()] });
    else if (request.method === "session.activate") peer.respond(request, {});
    else if (request.method === "prompt.submit") {
      peer.respond(request, { status: "streaming" });
      peer.event("approval.request", "live-1", { command: "git status" });
    } else if (request.method === "approval.respond") {
      peer.respond(request, { resolved: true });
      peer.event("message.complete", "live-1", { text: "done", status: "complete" });
    }
  });
  const brain = new HermesGatewayBrain({
    url: "ws://127.0.0.1:9119/api/ws?token=secret",
    session: "main",
    autoApproveTools: true,
    socketFactory: () => socket as unknown as WebSocket,
  });

  await brain.start();
  expect(await brain.send("check it")).toBe("done");
  expect(socket.requests.find((request) => request.method === "approval.respond")?.params).toEqual({
    session_id: "live-1",
    choice: "once",
  });
});

test("does not interrupt or queue behind a TUI turn that is already running", async () => {
  const socket = new FakeGatewaySocket((request, peer) => {
    if (request.method === "session.active_list") {
      peer.respond(request, { sessions: [{ ...liveSession(), status: "working" }] });
    } else if (request.method === "session.activate") peer.respond(request, {});
  });
  const brain = new HermesGatewayBrain({
    url: "ws://127.0.0.1:9119/api/ws?token=secret",
    session: "main",
    socketFactory: () => socket as unknown as WebSocket,
  });

  await brain.start();
  await expect(brain.send("voice turn")).rejects.toThrow(/session 'main' is working/);
  expect(socket.requests.some((request) => request.method === "prompt.submit")).toBe(false);
  expect(socket.requests.some((request) => request.method === "session.interrupt")).toBe(false);
});

test("interrupts only the attached Hermes turn when cancelled", async () => {
  const socket = new FakeGatewaySocket((request, peer) => {
    if (request.method === "session.active_list") peer.respond(request, { sessions: [liveSession()] });
    else if (request.method === "session.activate") peer.respond(request, {});
    else if (request.method === "prompt.submit") peer.respond(request, { status: "streaming" });
    else if (request.method === "session.interrupt") peer.respond(request, { status: "interrupted" });
  });
  const brain = new HermesGatewayBrain({
    url: "ws://127.0.0.1:9119/api/ws?token=secret",
    session: "main",
    socketFactory: () => socket as unknown as WebSocket,
  });
  await brain.start();
  const controller = new AbortController();
  const turn = brain.send("keep going", { signal: controller.signal });
  await Bun.sleep(0);
  controller.abort();

  await expect(turn).rejects.toThrow(/Aborted/);
  await Bun.sleep(0);
  expect(socket.requests.find((request) => request.method === "session.interrupt")?.params.session_id).toBe("live-1");
});
