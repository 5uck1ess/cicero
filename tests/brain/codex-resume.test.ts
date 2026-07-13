import { expect, test } from "bun:test";
import { CodexBrain } from "../../src/brain/codex";

const THREAD_A = "11111111-1111-4111-8111-111111111111";
const THREAD_B = "22222222-2222-4222-8222-222222222222";

interface Scenario {
  events?: unknown[];
  delayMs?: number;
  exitCode?: number;
  stderr?: string;
  closeStdoutAndHang?: boolean;
}

function turn(threadId: string, answer: string): unknown[] {
  return [
    { type: "thread.started", thread_id: threadId },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: answer } },
    { type: "turn.completed", usage: {} },
  ];
}

class MockCodexBrain extends CodexBrain {
  readonly invocations: Array<{ args: string[]; message: string }> = [];

  constructor(private readonly scenarios: Scenario[], resume = true) {
    super("codex", ["-s", "workspace-write"], [], { resume });
  }

  protected override spawnWithArgs(args: string[], message: string) {
    const scenario = this.scenarios.shift();
    if (!scenario) throw new Error("Mock Codex scenario queue exhausted");
    this.invocations.push({ args: [...args], message });
    if (scenario.closeStdoutAndHang) {
      return Bun.spawn(["sh", "-c", "exec 1>&-; trap 'exit 0' TERM; while :; do sleep 1; done"], {
        detached: process.platform !== "win32",
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    }
    const script = [
      `await Bun.sleep(${scenario.delayMs ?? 0});`,
      `for (const event of ${JSON.stringify(scenario.events ?? [])}) console.log(JSON.stringify(event));`,
      scenario.stderr ? `console.error(${JSON.stringify(scenario.stderr)});` : "",
      `process.exitCode = ${scenario.exitCode ?? 0};`,
    ].join("\n");
    return Bun.spawn(["bun", "-e", script], {
      detached: process.platform !== "win32",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  args(): string[] {
    return this.argsForTurn();
  }
}

test("captures and resumes the exact Codex thread UUID instead of --last", async () => {
  const brain = new MockCodexBrain([
    { events: turn(THREAD_A, "first") },
    { events: turn(THREAD_A, "second") },
  ]);

  expect(await brain.send("one")).toBe("first");
  expect(brain.args()).toEqual([
    "exec", "--color", "never", "--skip-git-repo-check", "-s", "workspace-write", "resume", THREAD_A,
  ]);
  expect(await brain.send("two")).toBe("second");

  expect(brain.invocations[0]?.args).not.toContain("resume");
  expect(brain.invocations[1]?.args).toEqual([
    "exec", "--json", "--color", "never", "--skip-git-repo-check", "-s", "workspace-write", "resume", THREAD_A,
  ]);
  expect(brain.invocations.flatMap(({ args }) => args)).not.toContain("--last");
});

test("interleaved brain instances cannot steal each other's sessions", async () => {
  const first = new MockCodexBrain([
    { events: turn(THREAD_A, "a1") },
    { events: turn(THREAD_A, "a2") },
  ]);
  const second = new MockCodexBrain([
    { events: turn(THREAD_B, "b1") },
    { events: turn(THREAD_B, "b2") },
  ]);

  await first.send("a1");
  await second.send("b1");
  await first.send("a2");
  await second.send("b2");

  expect(first.invocations[1]?.args.at(-1)).toBe(THREAD_A);
  expect(second.invocations[1]?.args.at(-1)).toBe(THREAD_B);
});

test("resume-enabled turns are serialized before selecting their arguments", async () => {
  const brain = new MockCodexBrain([
    { events: turn(THREAD_A, "first"), delayMs: 100 },
    { events: turn(THREAD_A, "second") },
  ]);

  const first = brain.send("one");
  await Bun.sleep(10);
  const second = brain.send("two");
  await Bun.sleep(20);
  expect(brain.invocations).toHaveLength(1);

  expect(await Promise.all([first, second])).toEqual(["first", "second"]);
  expect(brain.invocations[1]?.args.at(-1)).toBe(THREAD_A);
});

test("aborting a queued turn does not strand the waiter behind it", async () => {
  const brain = new MockCodexBrain([
    { events: turn(THREAD_A, "first"), delayMs: 100 },
    { events: turn(THREAD_A, "third") },
  ]);
  const controller = new AbortController();

  const first = brain.send("one");
  await Bun.sleep(10);
  const cancelled = brain.send("two", { signal: controller.signal }).catch((error: unknown) => error);
  const third = brain.send("three");
  controller.abort(new DOMException("skip queued turn", "AbortError"));
  await Bun.sleep(20);

  expect(brain.invocations).toHaveLength(1);
  expect(await cancelled).toBeInstanceOf(DOMException);
  expect(await first).toBe("first");
  expect(await third).toBe("third");
  expect(brain.invocations.map(({ message }) => message)).toEqual(["one", "three"]);
  expect(brain.invocations[1]?.args.at(-1)).toBe(THREAD_A);
});

test("a successful turn without a valid thread event refuses unsafe resume", async () => {
  const missing = new MockCodexBrain([{ events: [{ type: "turn.completed" }] }]);
  await expect(missing.send("missing")).rejects.toThrow("without reporting its thread UUID");
  expect(missing.args()).not.toContain("resume");

  const malformed = new MockCodexBrain([{ events: turn("not-a-uuid", "answer") }]);
  await expect(malformed.send("malformed")).rejects.toThrow("valid thread UUID");
  expect(malformed.args()).not.toContain("resume");
});

test("a resumed process reporting another thread is rejected before its answer", async () => {
  const brain = new MockCodexBrain([
    { events: turn(THREAD_A, "first") },
    { events: turn(THREAD_B, "wrong") },
  ]);
  await brain.send("one");
  await expect(brain.send("two")).rejects.toThrow(`expected ${THREAD_A}`);
  expect(brain.args().at(-1)).toBe(THREAD_A);
});

test("restart is serialized between active and newly queued turns", async () => {
  const brain = new MockCodexBrain([
    { events: turn(THREAD_A, "first"), delayMs: 80 },
    { events: turn(THREAD_B, "after restart") },
  ]);

  const active = brain.send("one");
  await Bun.sleep(10);
  const restarting = brain.restart();
  const afterRestart = brain.send("two");

  expect(await active).toBe("first");
  await restarting;
  expect(await afterRestart).toBe("after restart");
  expect(brain.invocations[1]?.args).not.toContain("resume");
  expect(brain.args().at(-1)).toBe(THREAD_B);
});

test("streamProgress uses the owned session and forwards cancellation", async () => {
  const brain = new MockCodexBrain([
    { events: turn(THREAD_A, "first") },
    { events: turn(THREAD_A, "too late"), delayMs: 10_000 },
  ]);
  await brain.send("one");

  const controller = new AbortController();
  const consume = async () => {
    for await (const _chunk of brain.streamProgress("two", { signal: controller.signal })) {
      // The delayed fixture should be terminated before producing output.
    }
  };
  const started = performance.now();
  const pending = consume();
  await Bun.sleep(30);
  controller.abort(new DOMException("cancelled", "AbortError"));
  await expect(pending).rejects.toThrow("cancelled");
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(brain.invocations[1]?.args.at(-1)).toBe(THREAD_A);
});

test("non-zero JSON turns retain bounded stdout diagnostics", async () => {
  const brain = new MockCodexBrain([{
    events: [{
      type: "item.completed",
      item: { type: "error", message: `invalid credentials ${"x".repeat(10_000)}` },
    }],
    exitCode: 1,
  }]);
  const error = await brain.send("fail").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("invalid credentials");
  expect((error as Error).message.length).toBeLessThan(2_100);
  expect(brain.args()).not.toContain("resume");
});

test("non-zero JSON turns retain only a bounded stderr tail", async () => {
  const brain = new MockCodexBrain([{
    stderr: `HEAD_TOKEN${"e".repeat(20_000)}TAIL_TOKEN`,
    exitCode: 1,
  }]);
  const error = await brain.send("fail").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain("TAIL_TOKEN");
  expect(message).toContain("stderr truncated; tail retained");
  expect(message).not.toContain("HEAD_TOKEN");
  expect(message.length).toBeLessThan(8_200);
});

test.skipIf(process.platform === "win32")("a Codex process cannot stay alive after closing its JSON stream", async () => {
  const brain = new MockCodexBrain([{ closeStdoutAndHang: true }]);
  const started = performance.now();

  await expect(brain.send("hang after EOF")).rejects.toThrow("remained alive after its output stream closed");
  expect(performance.now() - started).toBeLessThan(1_750);
});

test.skipIf(process.platform === "win32")("Codex cancellation remains armed between JSON EOF and process exit", async () => {
  const brain = new MockCodexBrain([{ closeStdoutAndHang: true }]);
  const controller = new AbortController();
  const started = performance.now();
  const pending = brain.send("cancel after EOF", { signal: controller.signal });
  await Bun.sleep(50);

  controller.abort(new DOMException("cancel after Codex EOF", "AbortError"));

  await expect(pending).rejects.toThrow("cancel after Codex EOF");
  expect(performance.now() - started).toBeLessThan(450);
});

test("without resume opt-in every turn stays on the regular subprocess path", () => {
  const brain = new MockCodexBrain([], false);
  expect(brain.args()).not.toContain("resume");
});
