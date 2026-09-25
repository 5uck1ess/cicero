import { test, expect } from "bun:test";
import { AcpBrain } from "../../src/brain/acp";
import { permissionNotice } from "../../src/brain/approval";
import { TOOL_START_NOTICE } from "../../src/speaker/thinking-filler";
import type { SessionNotification, RequestPermissionRequest } from "@zed-industries/agent-client-protocol";

test("permission speech uses only the protocol kind, never untrusted title or raw input", () => {
  expect(permissionNotice("execute")).toBe("Waiting on your OK to run a shell command.");
  expect(permissionNotice("constructor")).toBe("Waiting on your OK to use a tool.");
  expect(permissionNotice("secret/path?token=abc")).toBe("Waiting on your OK to use a tool.");
});

test("ACP announces first tool once, before reply text, and drops cancelled turn events", async () => {
  const heard: string[] = [];
  const brain = new AcpBrain({ binary: "true" }) as any;
  const active = {
    queue: { push: () => {} }, settled: false, cancellation: null,
    onNotice: (notice: { text: string }) => heard.push(notice.text),
    toolNoticeSent: false, replyStarted: false,
  };
  const runtime = { sessionId: "s", activeTurn: active };
  brain.runtime = runtime;
  const client = brain.makeClient(runtime);
  const tool = { sessionId: "s", update: { sessionUpdate: "tool_call", toolCallId: "1", title: "secret", kind: "execute" } } as SessionNotification;
  await client.sessionUpdate(tool);
  await client.sessionUpdate(tool);
  expect(heard).toEqual([TOOL_START_NOTICE]);
  active.cancellation = Promise.resolve();
  await client.sessionUpdate(tool);
  expect(heard).toHaveLength(1);
});

test("ACP gated permission announces a sanitized kind once for each pending request", async () => {
  const heard: string[] = [];
  const brain = new AcpBrain({ binary: "true", confirmTools: ["danger"] }) as any;
  const active = {
    queue: { push: () => {} }, settled: false, cancellation: null,
    onNotice: (notice: { text: string }) => heard.push(notice.text),
    toolNoticeSent: false, replyStarted: false,
  };
  const runtime = { sessionId: "s", activeTurn: active };
  brain.runtime = runtime;
  const request = {
    sessionId: "s", toolCall: { toolCallId: "1", title: "secret /tmp/key danger", kind: "execute", rawInput: { command: "danger secret" } },
    options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
  } as RequestPermissionRequest;
  const response = await brain.makeClient(runtime).requestPermission(request);
  expect(response.outcome).toEqual({ outcome: "selected", optionId: "reject" });
  expect(heard).toEqual(["Waiting on your OK to run a shell command."]);
});
