import { expect, test } from "bun:test";
import { AcpBrain } from "../../src/brain/acp";
import { SpeculativePermissionHold, MAX_HELD_PERMISSIONS } from "../../src/brain/speculative-permissions";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@zed-industries/agent-client-protocol";

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
  expect((await requestPermission(request("overflow"))).outcome.outcome).toBe("cancelled");
  for (const result of await Promise.all(pending)) expect(result.outcome.outcome).toBe("cancelled");
  hold.adopt();
  expect((await requestPermission(request("after overflow"))).outcome.outcome).toBe("cancelled");
});
