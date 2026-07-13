import { test, expect, mock } from "bun:test";
import { ClaudeCodeHookAdapter } from "../src/sidecar/claude-code-hook";
import type { SpeakService } from "../src/sidecar/types";

const TOKEN = "test-hook-token-that-is-at-least-32-bytes";
const JSON_HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
};

const makeService = (): SpeakService => ({
  speak: mock(() => Promise.resolve()),
  stop: mock(() => Promise.resolve()),
});

test("POST /speak with valid JSON triggers SpeakService.speak", async () => {
  const adapter = new ClaudeCodeHookAdapter({ port: 18084, token: TOKEN });
  const svc = makeService();
  await adapter.attach(svc);
  try {
    const res = await fetch("http://localhost:18084/speak", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: "hello world" }),
    });

    expect(res.status).toBe(202);
    expect(svc.speak).toHaveBeenCalledWith({ text: "hello world", agent: "claude-code", skipSummary: undefined });
  } finally {
    await adapter.detach();
  }
});

test("POST /speak with Claude Code's last_assistant_message field is accepted", async () => {
  const adapter = new ClaudeCodeHookAdapter({ port: 18089, token: TOKEN });
  const svc = makeService();
  await adapter.attach(svc);
  try {
    const res = await fetch("http://localhost:18089/speak", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        hook_event_name: "Stop",
        last_assistant_message: "I refactored the auth module.",
        session_id: "abc123",
      }),
    });

    expect(res.status).toBe(202);
    expect(svc.speak).toHaveBeenCalledWith({
      text: "I refactored the auth module.",
      agent: "claude-code",
      skipSummary: undefined,
    });
  } finally {
    await adapter.detach();
  }
});

test("POST /speak with skipSummary flag passes through", async () => {
  const adapter = new ClaudeCodeHookAdapter({ port: 18085, token: TOKEN });
  const svc = makeService();
  await adapter.attach(svc);
  try {
    await fetch("http://localhost:18085/speak", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: "raw", skipSummary: true }),
    });

    expect(svc.speak).toHaveBeenCalledWith({ text: "raw", agent: "claude-code", skipSummary: true });
  } finally {
    await adapter.detach();
  }
});

test("authenticated Codex bridge requests retain their source label", async () => {
  const adapter = new ClaudeCodeHookAdapter({ port: 18094, token: TOKEN });
  const svc = makeService();
  await adapter.attach(svc);
  try {
    await fetch("http://localhost:18094/speak", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: "Codex finished.", agent: "codex" }),
    });

    expect(svc.speak).toHaveBeenCalledWith({
      text: "Codex finished.",
      agent: "codex",
      skipSummary: undefined,
    });
  } finally {
    await adapter.detach();
  }
});

test("non-POST returns 405", async () => {
  const adapter = new ClaudeCodeHookAdapter({ port: 18086, token: TOKEN });
  await adapter.attach(makeService());
  try {
    const res = await fetch("http://localhost:18086/speak");
    expect(res.status).toBe(405);
  } finally {
    await adapter.detach();
  }
});

test("malformed JSON returns 400", async () => {
  const adapter = new ClaudeCodeHookAdapter({ port: 18087, token: TOKEN });
  await adapter.attach(makeService());
  try {
    const res = await fetch("http://localhost:18087/speak", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "not json",
    });
    expect(res.status).toBe(400);
  } finally {
    await adapter.detach();
  }
});

test("health returns ok when attached", async () => {
  const adapter = new ClaudeCodeHookAdapter({ port: 18088, token: TOKEN });
  expect((await adapter.health()).ok).toBe(false);
  await adapter.attach(makeService());
  try {
    expect((await adapter.health()).ok).toBe(true);
  } finally {
    await adapter.detach();
  }
});

test("rejects missing, incorrect, and browser-origin credentials", async () => {
  const adapter = new ClaudeCodeHookAdapter({ port: 18090, token: TOKEN });
  const svc = makeService();
  await adapter.attach(svc);
  try {
    const body = JSON.stringify({ text: "do not speak" });
    const missing = await fetch("http://localhost:18090/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const wrong = await fetch("http://localhost:18090/speak", {
      method: "POST",
      headers: {
        authorization: "Bearer definitely-the-wrong-token-value",
        "content-type": "application/json",
      },
      body,
    });
    const browser = await fetch("http://localhost:18090/speak", {
      method: "POST",
      headers: { ...JSON_HEADERS, origin: "https://attacker.example" },
      body,
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(browser.status).toBe(403);
    expect(svc.speak).not.toHaveBeenCalled();
  } finally {
    await adapter.detach();
  }
});

test("requires JSON and bounds text before it enters the speech queue", async () => {
  const adapter = new ClaudeCodeHookAdapter({ port: 18091, token: TOKEN });
  const svc = makeService();
  await adapter.attach(svc);
  try {
    const wrongType = await fetch("http://localhost:18091/speak", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
      body: JSON.stringify({ text: "hello" }),
    });
    const tooLong = await fetch("http://localhost:18091/speak", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: "x".repeat(128 * 1024 + 1) }),
    });
    const wrongShape = await fetch("http://localhost:18091/speak", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "null",
    });

    expect(wrongType.status).toBe(415);
    expect(tooLong.status).toBe(413);
    expect(wrongShape.status).toBe(400);
    expect(svc.speak).not.toHaveBeenCalled();
  } finally {
    await adapter.detach();
  }
});

test("serializes speech and rejects work beyond the bounded queue", async () => {
  let releaseFirst!: () => void;
  const firstSpeak = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const service: SpeakService = {
    speak: mock(() => {
      calls += 1;
      return calls === 1 ? firstSpeak : Promise.resolve();
    }),
    stop: mock(() => Promise.resolve()),
  };
  const adapter = new ClaudeCodeHookAdapter({ port: 18092, token: TOKEN });
  await adapter.attach(service);
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      const response = await fetch("http://localhost:18092/speak", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ text: `message ${i}` }),
      });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(202));
    expect(statuses[8]).toBe(429);
    expect(calls).toBe(1);
    releaseFirst();
    await Bun.sleep(20);
    expect(calls).toBe(8);
  } finally {
    releaseFirst();
    await adapter.detach();
  }
});

test("cancels a body that does not finish before the absolute read deadline", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"text":"never finishes'));
    },
  });
  const adapter = new ClaudeCodeHookAdapter({
    port: 18093,
    token: TOKEN,
    bodyReadTimeoutMs: 30,
  });
  await adapter.attach(makeService());
  try {
    const response = await fetch("http://localhost:18093/speak", {
      method: "POST",
      headers: JSON_HEADERS,
      body,
    });
    expect(response.status).toBe(408);
    expect(response.headers.get("connection")).toBe("close");
  } finally {
    await adapter.detach();
  }
});
