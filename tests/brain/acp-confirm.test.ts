import { test, expect } from "bun:test";
import { AcpBrain } from "../../src/brain/acp";
import { isConfirmationNonce } from "../../src/brain/approval";
import type { PendingConfirmation } from "../../src/types";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@zed-industries/agent-client-protocol";

/** The ACP permission callback is pure state, so these tests need no subprocess. */
type TestBrain = {
  makeClient: () => {
    requestPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  };
  send: (message: string) => Promise<string>;
  stop: () => Promise<void>;
  noteApprovalIfPending: (message: string) => void;
  hasPendingConfirmation: () => boolean;
  pendingConfirmations: () => readonly PendingConfirmation[];
  resolvePendingConfirmation: (approved: boolean, nonce: string) => boolean;
  pendingConfirmation: { summary: string; at: number; nonce: string; operationKey: string } | null;
  confirmationGrant: { until: number; operationKey: string } | null;
};

function brain(
  confirmTools?: string[],
  onConfirmationPending?: (summary: string, nonce: string) => void | Promise<void>,
  opts: {
    autoApproveTools?: boolean;
    confirmRetry?: boolean;
    onNudgeReply?: (text: string) => void;
  } = {},
): TestBrain {
  return new AcpBrain({
    binary: "true",
    autoApproveTools: opts.autoApproveTools ?? true,
    confirmTools,
    onConfirmationPending,
    confirmRetry: opts.confirmRetry,
    onNudgeReply: opts.onNudgeReply,
  }) as unknown as TestBrain;
}

async function settleNudge(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const NORMAL_OPTIONS: RequestPermissionRequest["options"] = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

const ALLOW_ONLY_OPTIONS: RequestPermissionRequest["options"] = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
];

function permissionRequest(
  title: string,
  command: string,
  options: RequestPermissionRequest["options"] = NORMAL_OPTIONS,
  toolCallId = "t1",
): RequestPermissionRequest {
  return {
    sessionId: "s1",
    toolCall: { toolCallId, title, rawInput: { command } },
    options,
  } as RequestPermissionRequest;
}

function selected(response: RequestPermissionResponse): string | null {
  return response.outcome.outcome === "selected" ? response.outcome.optionId : null;
}

function pendingNonce(brain: TestBrain): string {
  const pending = brain.pendingConfirmations();
  expect(pending).toHaveLength(1);
  return pending[0]!.nonce;
}

test("non-matching tools keep auto-approving", async () => {
  const b = brain(["git push", "rm -rf"]);
  const response = await b.makeClient().requestPermission(permissionRequest("List files", "ls -la"));
  expect(selected(response)).toBe("allow");
});

test("no confirm_tools configured leaves the gate inert", async () => {
  const b = brain(undefined);
  const response = await b.makeClient().requestPermission(permissionRequest("Push", "git push --force"));
  expect(selected(response)).toBe("allow");
});

test("auto-approve false cancels an allow-only request instead of selecting allow", async () => {
  const b = brain(undefined, undefined, { autoApproveTools: false });
  const response = await b.makeClient().requestPermission(
    permissionRequest("Run command", "echo unsafe", ALLOW_ONLY_OPTIONS),
  );
  expect(response.outcome.outcome).toBe("cancelled");
  expect(selected(response)).toBeNull();
});

test("a guarded allow-only request is cancelled while its gate is armed", async () => {
  const b = brain(["git push"]);
  const response = await b.makeClient().requestPermission(
    permissionRequest("Push", "git push origin main", ALLOW_ONLY_OPTIONS),
  );
  expect(response.outcome.outcome).toBe("cancelled");
  expect(b.hasPendingConfirmation()).toBe(true);
});

test("a matching tool is denied and gets a globally unique UUID capability", async () => {
  const first = brain(["git push"]);
  const second = brain(["git push"]);
  const response = await first.makeClient().requestPermission(permissionRequest("Push branch", "git push origin main"));
  await second.makeClient().requestPermission(permissionRequest("Push branch", "git push origin main"));

  expect(selected(response)).toBe("reject");
  expect(first.pendingConfirmation?.summary).toBe("Push branch");
  expect(first.hasPendingConfirmation()).toBe(true);
  expect(isConfirmationNonce(pendingNonce(first))).toBe(true);
  expect(pendingNonce(first)).not.toBe(pendingNonce(second));
});

test("a newly armed gate announces its summary and exact nonce", async () => {
  const announcements: Array<{ summary: string; nonce: string }> = [];
  const b = brain(["git push"], (summary, nonce) => { announcements.push({ summary, nonce }); });
  await b.makeClient().requestPermission(permissionRequest("Push branch", "git push origin main"));
  expect(announcements).toEqual([{ summary: "Push branch", nonce: pendingNonce(b) }]);
});

test("an async confirmation-notification failure is observed and the gate stays fail-closed", async () => {
  const b = brain(["git push"], () => Promise.reject(new Error("telegram unavailable")));
  const response = await b.makeClient().requestPermission(permissionRequest("Push branch", "git push origin main"));
  await Promise.resolve();
  expect(selected(response)).toBe("reject");
  expect(b.hasPendingConfirmation()).toBe(true);
});

test("missing and mismatched nonces cannot resolve a pending gate", async () => {
  const b = brain(["git push"]);
  await b.makeClient().requestPermission(permissionRequest("Push branch", "git push origin main"));
  const nonce = pendingNonce(b);

  expect(b.resolvePendingConfirmation(true, crypto.randomUUID())).toBe(false);
  const idlessResolve = b.resolvePendingConfirmation.bind(b) as unknown as (approved: boolean) => boolean;
  expect(idlessResolve(true)).toBe(false);
  expect(pendingNonce(b)).toBe(nonce);
});

test("pending confirmation can be cancelled without opening a grant", async () => {
  const b = brain(["git push"]);
  const client = b.makeClient();
  await client.requestPermission(permissionRequest("Push branch", "git push origin main"));

  expect(b.resolvePendingConfirmation(false, pendingNonce(b))).toBe(true);
  expect(b.pendingConfirmation).toBeNull();
  expect(b.confirmationGrant).toBeNull();

  const retry = await client.requestPermission(permissionRequest("Push branch", "git push origin main"));
  expect(selected(retry)).toBe("reject");
});

test("approved confirmation nudges the owning ACP brain exactly once", async () => {
  const replies: string[] = [];
  const b = brain(["git push"], undefined, { onNudgeReply: (text) => replies.push(text) });
  const sent: string[] = [];
  b.send = async (message: string) => {
    sent.push(message);
    return "retry complete";
  };
  await b.makeClient().requestPermission(permissionRequest("Push branch", "git push origin main"));

  expect(b.resolvePendingConfirmation(true, pendingNonce(b))).toBe(true);
  await settleNudge();

  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("Push branch");
  expect(sent[0]).toContain("Proceed now");
  expect(replies).toEqual(["retry complete"]);
});

test("denied confirmation does not nudge the ACP brain", async () => {
  const b = brain(["git push"]);
  const sent: string[] = [];
  b.send = async (message: string) => {
    sent.push(message);
    return "unused";
  };
  await b.makeClient().requestPermission(permissionRequest("Push branch", "git push origin main"));

  expect(b.resolvePendingConfirmation(false, pendingNonce(b))).toBe(true);
  await settleNudge();
  expect(sent).toEqual([]);
});

test("confirm_retry false opens the exact-operation grant without nudging", async () => {
  const b = brain(["git push"], undefined, { confirmRetry: false });
  const sent: string[] = [];
  b.send = async (message: string) => {
    sent.push(message);
    return "unused";
  };
  await b.makeClient().requestPermission(permissionRequest("Push branch", "git push origin main"));

  expect(b.resolvePendingConfirmation(true, pendingNonce(b))).toBe(true);
  await settleNudge();
  expect(b.confirmationGrant?.until).toBeGreaterThan(Date.now());
  expect(sent).toEqual([]);
});

test("approval nudge failure is handled without revoking the bound grant", async () => {
  const replies: string[] = [];
  const b = brain(["git push"], undefined, { onNudgeReply: (text) => replies.push(text) });
  b.send = async () => { throw new Error("agent unavailable"); };
  await b.makeClient().requestPermission(permissionRequest("Push branch", "git push origin main"));

  expect(b.resolvePendingConfirmation(true, pendingNonce(b))).toBe(true);
  await settleNudge();
  expect(b.confirmationGrant?.until).toBeGreaterThan(Date.now());
  expect(replies).toEqual([]);
});

test("an exact spoken yes opens a one-shot grant for the same operation", async () => {
  const b = brain(["git push"]);
  b.send = async () => "nudged";
  const client = b.makeClient();
  await client.requestPermission(permissionRequest("Push branch", "git push origin main", NORMAL_OPTIONS, "attempt-1"));

  b.noteApprovalIfPending("Yes.");
  await settleNudge();
  expect(b.pendingConfirmation).toBeNull();

  // Transport ids may change on retry; the semantic operation stays bound.
  const retry = await client.requestPermission(permissionRequest("Push branch", "git push origin main", NORMAL_OPTIONS, "attempt-2"));
  expect(selected(retry)).toBe("allow");

  const third = await client.requestPermission(permissionRequest("Push branch", "git push origin main", NORMAL_OPTIONS, "attempt-3"));
  expect(selected(third)).toBe("reject");
});

test("contradictory approval text never opens the gate", async () => {
  const b = brain(["git push"]);
  const client = b.makeClient();
  await client.requestPermission(permissionRequest("Push", "git push origin main"));
  const nonce = pendingNonce(b);

  b.noteApprovalIfPending("yes, but do not do it");
  expect(pendingNonce(b)).toBe(nonce);
  expect(b.confirmationGrant).toBeNull();
  expect(selected(await client.requestPermission(permissionRequest("Push", "git push origin main")))).toBe("reject");
});

test("a grant for one guarded operation cannot authorize a different one", async () => {
  const b = brain(["git push"], undefined, { confirmRetry: false });
  const client = b.makeClient();
  await client.requestPermission(permissionRequest("Push branch", "git push origin main"));
  expect(b.resolvePendingConfirmation(true, pendingNonce(b))).toBe(true);

  const mismatch = await client.requestPermission(permissionRequest("Push branch", "git push origin release"));
  expect(selected(mismatch)).toBe("reject");
  const mismatchNonce = pendingNonce(b);

  // Seeing operation B also invalidates A's old one-shot grant.
  const original = await client.requestPermission(permissionRequest("Push branch", "git push origin main"));
  expect(selected(original)).toBe("reject");
  expect(pendingNonce(b)).not.toBe(mismatchNonce);
});

test("prototype-shaped tool fields remain part of the bound operation", async () => {
  const b = brain(["git push"], undefined, { confirmRetry: false });
  const client = b.makeClient();
  const request = (marker: string, toolCallId: string): RequestPermissionRequest => ({
    sessionId: "s1",
    toolCall: {
      toolCallId,
      title: "Push branch",
      rawInput: { command: "git push origin main" },
      ["__proto__"]: { marker },
    },
    options: NORMAL_OPTIONS,
  } as unknown as RequestPermissionRequest);

  await client.requestPermission(request("approved-operation", "attempt-1"));
  expect(b.resolvePendingConfirmation(true, pendingNonce(b))).toBe(true);

  expect(selected(await client.requestPermission(request("different-operation", "attempt-2")))).toBe("reject");
});

test("a non-approval utterance leaves the gate closed", async () => {
  const b = brain(["rm -rf"]);
  const client = b.makeClient();
  await client.requestPermission(permissionRequest("Delete dir", "rm -rf build"));
  b.noteApprovalIfPending("wait, what would that delete?");
  expect(b.confirmationGrant).toBeNull();
  expect(selected(await client.requestPermission(permissionRequest("Delete dir", "rm -rf build")))).toBe("reject");
});

test("matching is case-insensitive across the whole tool payload", async () => {
  const b = brain(["SUDO"]);
  const response = await b.makeClient().requestPermission(permissionRequest("Install", "sudo apt install foo"));
  expect(selected(response)).toBe("reject");
});

test("a stale pending confirmation expires instead of accepting a late yes", async () => {
  const b = brain(["git push"]);
  await b.makeClient().requestPermission(permissionRequest("Push", "git push"));
  if (b.pendingConfirmation) b.pendingConfirmation.at = Date.now() - 10 * 60 * 1000;
  expect(b.hasPendingConfirmation()).toBe(false);
  b.noteApprovalIfPending("yes");
  expect(b.confirmationGrant).toBeNull();
  expect(b.pendingConfirmation).toBeNull();
});

test("stop or restart invalidates old capabilities and replay cannot hit a new gate", async () => {
  const b = brain(["git push"], undefined, { confirmRetry: false });
  const client = b.makeClient();
  await client.requestPermission(permissionRequest("Push", "git push origin main"));
  const oldNonce = pendingNonce(b);

  await b.stop();
  expect(b.resolvePendingConfirmation(true, oldNonce)).toBe(false);

  await client.requestPermission(permissionRequest("Push", "git push origin main"));
  const newNonce = pendingNonce(b);
  expect(newNonce).not.toBe(oldNonce);
  expect(b.resolvePendingConfirmation(true, oldNonce)).toBe(false);
  expect(pendingNonce(b)).toBe(newNonce);

  expect(b.resolvePendingConfirmation(true, newNonce)).toBe(true);
  expect(b.resolvePendingConfirmation(true, newNonce)).toBe(false);
});
