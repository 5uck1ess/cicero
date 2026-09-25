import { expect, test } from "bun:test";
import { AcpBrain } from "../../src/brain/acp";
import { SpeculativePermissionHold, MAX_HELD_PERMISSIONS } from "../../src/brain/speculative-permissions";
import { FallbackBrain } from "../../src/brain/fallback";
import { SwitchboardBrain } from "../../src/brain/switchboard";
import { DialBackBrain } from "../../src/brain/dial-back";
import { QuickIntentsBrain } from "../../src/brain/quick-intents";
import { RoutingBrain } from "../../src/brain/routing";
import type { Brain, BrainTurnOptions } from "../../src/types";
import { makeSpeculator, pcmToWav } from "../../src/web-voice/speculative";
import { streamWebTurn, type WebReplySink } from "../../src/web-voice/turn";
import { dashBus } from "../../src/dashboard/bus";
import type { Client, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@zed-industries/agent-client-protocol";

const request = (id: string): RequestPermissionRequest => ({
  sessionId: "session",
  toolCall: { toolCallId: id, title: "Write file" },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
} as RequestPermissionRequest);

function client(hold: SpeculativePermissionHold, opts: { autoApproveTools?: boolean; confirmTools?: string[] } = {}) {
  const brain = new AcpBrain({ binary: "unused", autoApproveTools: opts.autoApproveTools ?? true, confirmTools: opts.confirmTools });
  const active = { permissionHold: hold, cancelled: false, settled: false };
  const runtime = { stopping: false, sessionId: "session", activeTurn: active };
  const state = brain as unknown as { runtime: typeof runtime; makeClient: (runtime: typeof runtime) => {
    requestPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  }; hasPendingConfirmation: () => boolean };
  state.runtime = runtime;
  return { requestPermission: state.makeClient(runtime).requestPermission, state, active };
}

test("adoption releases held ACP requests through the normal approval policy", async () => {
  const hold = new SpeculativePermissionHold();
  const { requestPermission } = client(hold);
  let resolved = false;
  const pending = requestPermission(request("one")).then((result) => { resolved = true; return result; });
  await Promise.resolve();
  expect(resolved).toBe(false);
  hold.adopt();
  expect((await pending).outcome).toEqual({ outcome: "selected", optionId: "allow" });
});

test("adoption applies confirm_tools only after the held request is released", async () => {
  const hold = new SpeculativePermissionHold();
  const { requestPermission, state } = client(hold, { confirmTools: ["write file"] });
  const pending = requestPermission(request("one"));
  expect(state.hasPendingConfirmation()).toBe(false);
  hold.adopt();
  expect((await pending).outcome).toEqual({ outcome: "selected", optionId: "reject" });
  expect(state.hasPendingConfirmation()).toBe(true);
});

test("adoption preserves auto_approve_tools false", async () => {
  const hold = new SpeculativePermissionHold();
  const { requestPermission } = client(hold, { autoApproveTools: false });
  const pending = requestPermission(request("one"));
  hold.adopt();
  expect((await pending).outcome).toEqual({ outcome: "selected", optionId: "reject" });
});

test("discard and abort cancel every held request, including a late adoption", async () => {
  for (const abort of [false, true]) {
    const hold = new SpeculativePermissionHold();
    const { requestPermission, active } = client(hold);
    const pending = [requestPermission(request("one")), requestPermission(request("two"))];
    if (abort) active.cancelled = true;
    hold.cancel();
    hold.adopt();
    for (const result of await Promise.all(pending)) expect(result.outcome.outcome).toBe("cancelled");
    expect((await requestPermission(request("late"))).outcome.outcome).toBe("cancelled");
  }
});

test("held permission count is bounded and overflow fails closed", async () => {
  const hold = new SpeculativePermissionHold();
  const { requestPermission } = client(hold);
  const pending = Array.from({ length: MAX_HELD_PERMISSIONS }, (_, i) => requestPermission(request(String(i))));
  let firstResolved = false;
  void pending[0]!.then(() => { firstResolved = true; });
  expect((await requestPermission(request("overflow"))).outcome.outcome).toBe("cancelled");
  await Promise.resolve();
  expect(firstResolved).toBe(false);
  hold.adopt();
  for (const result of await Promise.all(pending)) expect(result.outcome).toEqual({ outcome: "selected", optionId: "allow" });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** ACP prompt/permission callback with a fake in-memory runtime and no child process. */
function fakeAcp(confirmTools?: string[]) {
  const brain = new AcpBrain({ binary: "unused", autoApproveTools: true, confirmTools });
  const started = deferred<void>();
  const prompt = deferred<{ stopReason: "end_turn" }>();
  const runtime = {
    generation: 1,
    sessionId: "session",
    sessionIdentity: null,
    stopping: false,
    activeTurn: null,
    stopped: new Promise<void>(() => {}),
    conn: {
      prompt: () => { started.resolve(); return prompt.promise; },
      cancel: async () => {},
    },
  };
  const state = brain as unknown as {
    runtime: typeof runtime;
    makeClient: (runtime: typeof runtime) => Pick<Client, "requestPermission" | "sessionUpdate">;
  };
  state.runtime = runtime;
  const client = state.makeClient(runtime);
  brain.start = async () => {};
  return {
    brain,
    started: started.promise,
    permission: (id: string) => client.requestPermission(request(id)),
    update: (update: SessionNotification["update"]) => client.sessionUpdate({ sessionId: "session", update }),
    finish: () => prompt.resolve({ stopReason: "end_turn" }),
    fail: () => prompt.reject(new Error("first ACP tier failed")),
  };
}

const front = {
  start: async () => {}, stop: async () => {}, restart: async () => {},
  health: async () => true, injectContext: () => {}, send: async () => "front",
} satisfies Brain;

test("routing, dial-back and quick-intent wrappers forward the whole speculative option set", async () => {
  const seen: BrainTurnOptions[] = [];
  const notices: string[] = [];
  const hold = new SpeculativePermissionHold();
  const leaf: Brain = {
    ...front,
    sendStream: async function* (_message, options) {
      seen.push(options!);
      options?.onNotice?.({ type: "tool", text: "Starting a tool." });
      yield "ok";
    },
  };
  const options: BrainTurnOptions = {
    speculative: true,
    speculativePermissionHold: hold,
    systemContext: "snapshot",
    onNotice: (notice) => notices.push(notice.text),
  };
  for (const wrapper of [
    new DialBackBrain(leaf),
    new QuickIntentsBrain(leaf, []),
    new RoutingBrain(leaf, leaf),
  ]) {
    expect(await Array.fromAsync(wrapper.sendStream!("hello", options))).toEqual(["ok"]);
    expect(seen.at(-1)).toBe(options);
  }
  expect(notices).toEqual(["Starting a tool.", "Starting a tool.", "Starting a tool."]);
});

test("parallel ACP standup lanes keep each other's permissions pending until adoption", async () => {
  const a = fakeAcp();
  const b = fakeAcp();
  const hold = new SpeculativePermissionHold();
  const board = new SwitchboardBrain(front, { a: { brain: a.brain }, b: { brain: b.brain } });
  (board as unknown as { started: Set<string> }).started = new Set(["a", "b"]);
  const iterator = board.sendStream("standup", {
    speculative: true, speculativePermissionHold: hold,
  })[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toBe("Getting status from the team.");
  const next = iterator.next();
  await Promise.all([a.started, b.started]);
  const pendingB = b.permission("b-tool");
  a.finish();
  expect((await next).value).toContain("A:");
  let resolved = false;
  void pendingB.then(() => { resolved = true; });
  await Promise.resolve();
  expect(resolved).toBe(false);
  hold.adopt();
  expect((await pendingB).outcome).toEqual({ outcome: "selected", optionId: "allow" });
  b.finish();
  expect((await iterator.next()).value).toContain("B:");
  expect((await iterator.next()).done).toBe(true);
});

test("failed ACP fallback tier cannot cancel the next tier's permission hold", async () => {
  const first = fakeAcp();
  const second = fakeAcp();
  const hold = new SpeculativePermissionHold();
  const fallback = new FallbackBrain([first.brain, second.brain], "coder");
  const output = Array.fromAsync(fallback.sendStream("do work", {
    speculative: true, speculativePermissionHold: hold,
  }));
  await first.started;
  const firstPermission = first.permission("first-tool");
  first.fail();
  await second.started;
  expect((await firstPermission).outcome.outcome).toBe("cancelled");
  const secondPermission = second.permission("second-tool");
  hold.adopt();
  expect((await secondPermission).outcome).toEqual({ outcome: "selected", optionId: "allow" });
  second.finish();
  await output;
});

test("adopted ACP confirm_tools request emits its spoken notice", async () => {
  const acp = fakeAcp(["write file"]);
  const samples = new Float32Array(16_000);
  const wav = pcmToWav(samples, 16_000);
  const bytes = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
  const spec = makeSpeculator({
    stt: { transcribe: async () => "please write file" },
    brain: acp.brain,
    isLocalFastPath: () => false,
    minProbability: 0.85,
  })(samples, 16_000, 1000, 0.95)!;
  await spec.transcript();
  await acp.started;
  const permission = acp.permission("guarded-tool");
  const notices: string[] = [];
  const rows: string[] = [];
  const unsubscribe = dashBus.subscribe((event) => {
    if (event.structured?.toolCallId === "adopted-row") rows.push("tool");
    if (event.structured?.entries?.[0]?.title === "Adopted plan") rows.push("plan");
  });
  const sink: WebReplySink = {
    transcript: () => {}, sentence: () => {}, notice: (text) => { notices.push(text); },
    audio: () => {}, control: () => {}, done: () => {}, error: () => {}, aborted: () => false,
  };
  const running = streamWebTurn(bytes, {
    stt: { transcribe: async () => "unused" },
    brain: acp.brain,
    tts: { generateAudio: async () => bytes },
  }, sink, spec);
  try {
    expect((await permission).outcome).toEqual({ outcome: "selected", optionId: "reject" });
    await acp.update({ sessionUpdate: "plan", entries: [{ content: "Adopted plan", priority: "high", status: "pending" }] });
    await acp.update({ sessionUpdate: "tool_call", toolCallId: "adopted-row", title: "Write file", status: "pending" });
    acp.finish();
    await running;
    expect(notices).toEqual(["Waiting on your OK to use a tool."]);
    expect(rows).toEqual(["plan", "tool"]);
  } finally {
    unsubscribe();
  }
});
