import { test, expect } from "bun:test";
import { dropOffSpecUpdates } from "../../src/brain/acp";

async function through(msgs: unknown[]): Promise<unknown[]> {
  try {
    const src = new ReadableStream<unknown>({
      start(c) { for (const m of msgs) c.enqueue(m); c.close(); },
    });
    const out: unknown[] = [];
    const reader = dropOffSpecUpdates(src).getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(value);
    }
    return out;
  } catch (error: unknown) {
    throw error;
  }
}

const validUpdate = {
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "s1",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
  },
};

// hermes' context-usage extension — not in the ACP spec schema
const usageUpdate = {
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: "s1", update: { sessionUpdate: "usage_update", size: 256000, used: 709 } },
};

test("spec session updates pass through untouched", async () => {
  const out = await through([validUpdate]);
  expect(out).toEqual([validUpdate]);
});

test("off-spec session updates are dropped", async () => {
  const out = await through([usageUpdate, validUpdate, usageUpdate]);
  expect(out).toEqual([validUpdate]);
});

test("hostile JSON-shaped off-spec update kinds cannot break the receive stream", async () => {
  const hostileUpdate = {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: { sessionUpdate: { toString: "not callable", valueOf: "not callable" } },
    },
  };
  const out = await through([hostileUpdate, validUpdate]);
  expect(out).toEqual([validUpdate]);
});

test("non-session/update traffic (requests, responses) is never filtered", async () => {
  const request = { jsonrpc: "2.0", id: 1, method: "session/request_permission", params: {} };
  const response = { jsonrpc: "2.0", id: 2, result: { ok: true } };
  const out = await through([request, response]);
  expect(out).toEqual([request, response]);
});
