import { test, expect } from "bun:test";
import { runAgent } from "../../src/compute/agent-loop";
import { ToolRegistry } from "../../src/compute/registry";
import type { Tool } from "../../src/compute/tool";
import { classifyAction } from "../../src/compute/policy";

// A fake LLM that returns a scripted sequence of JSON steps — no model needed.
function scriptedLLM(steps: string[]) {
  let i = 0;
  return { async chatCompletion() { return steps[Math.min(i++, steps.length - 1)]; } };
}

const listDir: Tool = {
  name: "list_dir",
  description: "list a directory",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  async run(args) { return { ok: true, output: `entries of ${args.path}: a.txt` }; },
};

function registryWith(tool: Tool) {
  const reg = new ToolRegistry();
  reg.register(tool);
  return reg;
}

test("runs a tool then finishes, returning the summary", async () => {
  const llm = scriptedLLM([
    '{"thought":"look","action":{"tool":"list_dir","args":{"path":"."}}}',
    '{"thought":"done","action":{"tool":"finish","args":{"summary":"listed it"}}}',
  ]);
  const result = await runAgent("list the dir", {
    llm, registry: registryWith(listDir), classify: classifyAction,
    confirm: async () => true, maxSteps: 5,
  });
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("listed it");
  expect(result.steps).toHaveLength(2);
});

test("a denied action does not call the tool and is reported back", async () => {
  let ran = false;
  const shell: Tool = {
    name: "shell", description: "run shell",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    async run() { ran = true; return { ok: true, output: "" }; },
  };
  const llm = scriptedLLM([
    '{"thought":"nuke","action":{"tool":"shell","args":{"command":"rm -rf /"}}}',
    '{"thought":"ok","action":{"tool":"finish","args":{"summary":"stopped"}}}',
  ]);
  const result = await runAgent("destroy", {
    llm, registry: registryWith(shell), classify: classifyAction,
    confirm: async () => true, maxSteps: 5,
  });
  expect(ran).toBe(false);
  expect(result.summary).toBe("stopped");
});

test("declining a confirm skips the tool", async () => {
  let ran = false;
  const shell: Tool = {
    name: "shell", description: "run shell",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    async run() { ran = true; return { ok: true, output: "ran" }; },
  };
  const llm = scriptedLLM([
    '{"thought":"x","action":{"tool":"shell","args":{"command":"echo hi"}}}',
    '{"thought":"x","action":{"tool":"finish","args":{"summary":"skipped"}}}',
  ]);
  await runAgent("do it", {
    llm, registry: registryWith(shell), classify: classifyAction,
    confirm: async () => false, maxSteps: 5,
  });
  expect(ran).toBe(false);
});

test("stops at maxSteps without finishing and returns ok=false", async () => {
  const llm = scriptedLLM(['{"thought":"loop","action":{"tool":"list_dir","args":{"path":"."}}}']);
  const result = await runAgent("loop forever", {
    llm, registry: registryWith(listDir), classify: classifyAction,
    confirm: async () => true, maxSteps: 3,
  });
  expect(result.ok).toBe(false);
  expect(result.steps).toHaveLength(3);
});

test("a confirm that throws is treated as declined — the tool never runs", async () => {
  let ran = false;
  const shell: Tool = {
    name: "shell", description: "run shell",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    async run() { ran = true; return { ok: true, output: "" }; },
  };
  const llm = scriptedLLM([
    '{"thought":"x","action":{"tool":"shell","args":{"command":"echo hi"}}}',
    '{"thought":"ok","action":{"tool":"finish","args":{"summary":"could not confirm"}}}',
  ]);
  const result = await runAgent("do it", {
    llm, registry: registryWith(shell), classify: classifyAction,
    confirm: async () => { throw new Error("STT offline"); }, maxSteps: 5,
  });
  expect(ran).toBe(false);
  expect(result.summary).toBe("could not confirm");
});

test("a tool that throws is caught and the loop recovers to finish", async () => {
  const boom: Tool = {
    name: "list_dir", description: "throws",
    parameters: { type: "object", properties: {} },
    async run() { throw new Error("disk gone"); },
  };
  const llm = scriptedLLM([
    '{"thought":"look","action":{"tool":"list_dir","args":{"path":"."}}}',
    '{"thought":"recover","action":{"tool":"finish","args":{"summary":"recovered"}}}',
  ]);
  const result = await runAgent("list it", {
    llm, registry: registryWith(boom), classify: classifyAction,
    confirm: async () => true, maxSteps: 5,
  });
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("recovered");
});

test("an LLM error returns ok=false instead of rejecting", async () => {
  const llm = { async chatCompletion(): Promise<string> { throw new Error("rate limited"); } };
  const result = await runAgent("anything", {
    llm, registry: registryWith(listDir), classify: classifyAction,
    confirm: async () => true, maxSteps: 5,
  });
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("LLM error");
  expect(result.summary).toContain("rate limited");
});

test("invalid model output is recovered and the loop continues", async () => {
  const llm = scriptedLLM([
    "I cannot help with that.",
    '{"thought":"ok","action":{"tool":"finish","args":{"summary":"after retry"}}}',
  ]);
  const result = await runAgent("anything", {
    llm, registry: registryWith(listDir), classify: classifyAction,
    confirm: async () => true, maxSteps: 5,
  });
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("after retry");
});

test("an allowed action with no registered tool is reported and the loop continues", async () => {
  const llm = scriptedLLM([
    '{"thought":"x","action":{"tool":"ghost","args":{}}}',
    '{"thought":"done","action":{"tool":"finish","args":{"summary":"handled"}}}',
  ]);
  const result = await runAgent("anything", {
    llm, registry: registryWith(listDir),
    classify: () => "allow" as const, // force-allow so we reach the registry.get guard
    confirm: async () => true, maxSteps: 5,
  });
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("handled");
});

test("tool preflight runs before policy, confirmation, and execution", async () => {
  let classified = false;
  let confirmed = false;
  let ran = false;
  const browser: Tool = {
    name: "browser", description: "safe browser",
    parameters: { type: "object", properties: {} },
    async prepare() { throw new Error("loopback destination blocked"); },
    async run() { ran = true; return { ok: true, output: "should not run" }; },
  };
  const llm = scriptedLLM([
    '{"thought":"browse","action":{"tool":"browser","args":{"action":"navigate","url":"http://127.0.0.1"}}}',
    '{"thought":"done","action":{"tool":"finish","args":{"summary":"blocked safely"}}}',
  ]);
  const result = await runAgent("browse", {
    llm,
    registry: registryWith(browser),
    classify: () => { classified = true; return "confirm"; },
    confirm: async () => { confirmed = true; return true; },
    maxSteps: 3,
  });
  expect(result.summary).toBe("blocked safely");
  expect(classified).toBe(false);
  expect(confirmed).toBe(false);
  expect(ran).toBe(false);
});

test("trusted preflight args and summary reach policy, confirmation, and run", async () => {
  const seen: string[] = [];
  const tool: Tool = {
    name: "read_file", description: "read",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    prepare() {
      return {
        args: { path: "/workspace/.env" },
        confirmation: "read file /workspace/.env (requested through /workspace/notes)",
        security: { sensitiveRead: true },
      };
    },
    async run(args) { seen.push(`run:${String(args.path)}`); return { ok: true, output: "secret" }; },
  };
  const llm = scriptedLLM([
    '{"thought":"read","action":{"tool":"read_file","args":{"path":"notes"}}}',
    '{"thought":"done","action":{"tool":"finish","args":{"summary":"done"}}}',
  ]);
  await runAgent("read", {
    llm,
    registry: registryWith(tool),
    classify: (action) => {
      seen.push(`classify:${String(action.args.path)}:${String(action.security?.sensitiveRead)}`);
      return "confirm";
    },
    confirm: async (action) => {
      seen.push(`confirm:${action.confirmation}`);
      return true;
    },
    maxSteps: 3,
  });
  expect(seen).toEqual([
    "classify:/workspace/.env:true",
    "confirm:read file /workspace/.env (requested through /workspace/notes)",
    "run:/workspace/.env",
  ]);
});

test("preflight receives cancellation context and an aborted preflight cannot execute", async () => {
  try {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let classified = false;
    let ran = false;
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    let releasePrepare!: () => void;
    const tool: Tool = {
      name: "read_file",
      description: "preflight gate",
      parameters: { type: "object", properties: {} },
      prepare(_args, context) {
        receivedSignal = context?.signal;
        announceStarted();
        return new Promise((resolve) => {
          releasePrepare = () => resolve({ args: { path: "/trusted/path" } });
        });
      },
      async run() {
        ran = true;
        return { ok: true, output: "must not run" };
      },
    };
    const running = runAgent("read", {
      llm: scriptedLLM([
        '{"thought":"read","action":{"tool":"read_file","args":{"path":"untrusted"}}}',
      ]),
      registry: registryWith(tool),
      classify: () => { classified = true; return "allow"; },
      confirm: async () => true,
      signal: controller.signal,
    });

    await started;
    controller.abort(new Error("barge-in during preflight"));
    releasePrepare();

    expect(await running).toMatchObject({ ok: false, summary: "agent run cancelled" });
    expect(receivedSignal).toBe(controller.signal);
    expect(classified).toBe(false);
    expect(ran).toBe(false);
  } catch (error) {
    throw new Error("preflight cancellation regression failed", { cause: error });
  }
});

test("passes the run AbortSignal into tools and stops when already cancelled", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const tool: Tool = {
    name: "list_dir",
    description: "captures context",
    parameters: { type: "object", properties: {} },
    async run(_args, context) {
      received = context?.signal;
      return { ok: true, output: "done" };
    },
  };
  const llm = scriptedLLM([
    '{"thought":"look","action":{"tool":"list_dir","args":{}}}',
    '{"thought":"done","action":{"tool":"finish","args":{"summary":"complete"}}}',
  ]);
  const result = await runAgent("run", {
    llm,
    registry: registryWith(tool),
    classify: classifyAction,
    confirm: async () => true,
    signal: controller.signal,
  });
  expect(result.ok).toBe(true);
  expect(received).toBe(controller.signal);

  controller.abort();
  const cancelled = await runAgent("do not start", {
    llm,
    registry: registryWith(tool),
    classify: classifyAction,
    confirm: async () => true,
    signal: controller.signal,
  });
  expect(cancelled).toMatchObject({ ok: false, summary: "agent run cancelled", steps: [] });
});

test("passes cancellation into model planning and reports an aborted plan as cancellation", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const llm = {
    async chatCompletion(
      _messages: unknown[],
      options?: { signal?: AbortSignal },
    ): Promise<string> {
      received = options?.signal;
      return new Promise<string>((_resolve, reject) => {
        const onAbort = () => reject(options?.signal?.reason);
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        if (options?.signal?.aborted) onAbort();
      });
    },
  };

  const running = runAgent("wait", {
    llm,
    registry: registryWith(listDir),
    classify: classifyAction,
    confirm: async () => true,
    signal: controller.signal,
  });
  await Bun.sleep(5);
  controller.abort(new Error("barge-in"));

  expect(await running).toMatchObject({ ok: false, summary: "agent run cancelled", steps: [] });
  expect(received).toBe(controller.signal);
});

test("cancellation while confirmation is pending cannot fall through into the tool", async () => {
  const controller = new AbortController();
  let ran = false;
  let releaseConfirm!: (approved: boolean) => void;
  const shell: Tool = {
    name: "shell",
    description: "must not run",
    parameters: { type: "object", properties: {} },
    async run() {
      ran = true;
      return { ok: true, output: "unexpected" };
    },
  };
  const running = runAgent("confirm", {
    llm: scriptedLLM(['{"thought":"ask","action":{"tool":"shell","args":{"command":"echo hi"}}}']),
    registry: registryWith(shell),
    classify: classifyAction,
    confirm: () => new Promise<boolean>((resolve) => { releaseConfirm = resolve; }),
    signal: controller.signal,
  });
  await Bun.sleep(5);
  controller.abort(new Error("barge-in"));
  releaseConfirm(true);

  expect(await running).toMatchObject({ ok: false, summary: "agent run cancelled" });
  expect(ran).toBe(false);
});
