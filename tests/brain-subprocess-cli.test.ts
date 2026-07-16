import { test, expect } from "bun:test";
import {
  awaitOwnedTurnExit,
  SubprocessCLIBrain,
  type TurnProcess,
} from "../src/brain/subprocess-cli";

test("SubprocessCLIBrain spawns the configured binary with prompt", async () => {
  const brain = new SubprocessCLIBrain({ name: "test", binary: "echo", args: ["--print"] });
  await brain.start();
  const out = await brain.send("hello");
  expect(out).toContain("hello");
});

test("injected context is prepended once and completed turns become bounded history", () => {
  class InspectBrain extends SubprocessCLIBrain {
    prompt(message: string, systemContext?: string): string { return this.buildPrompt(message, systemContext); }
    complete(message: string, response: string): void { this.rememberTurn(message, response); }
  }
  const brain = new SubprocessCLIBrain({ name: "test", binary: "echo", args: [] });
  expect(brain).toBeDefined();

  const inspect = new InspectBrain({ name: "test", binary: "echo", args: [] });
  inspect.injectContext("[Command] ls\n[Output] file.txt");
  const first = inspect.prompt("what happened?");
  expect(first).toContain("file.txt");
  inspect.complete("what happened?", "The command listed one file.");

  const second = inspect.prompt("and then?");
  expect(second).not.toContain("[Output] file.txt");
  expect(second).toContain("Conversation so far:");
  expect(second).toContain("The command listed one file.");

  const operational = inspect.prompt("where is my brief?", "briefing: delivered");
  expect(operational).toContain("Host operational context");
  expect(operational).toContain("briefing: delivered");
  expect(operational.indexOf("briefing: delivered")).toBeLessThan(operational.indexOf("Current user request:"));
});

test("contextBuffer caps at 50 entries", () => {
  const brain = new SubprocessCLIBrain({ name: "test", binary: "echo", args: [] });
  for (let i = 0; i < 60; i++) brain.injectContext(`entry ${i}`);
  expect((brain as unknown as { turnContext: { pendingSize: number } }).turnContext.pendingSize).toBe(50);
});

test("sendStream yields the binary output", async () => {
  const brain = new SubprocessCLIBrain({ name: "test", binary: "echo", args: [] });
  await brain.start();
  let out = "";
  for await (const piece of brain.sendStream("streamed")) out += piece;
  expect(out).toContain("streamed");
});

test("send abort kills and reaps a silent subprocess group promptly", async () => {
  const brain = new SubprocessCLIBrain({
    name: "test",
    binary: "sh",
    args: ["-c", "trap \"\" TERM; while :; do sleep 1; done"],
  });
  const controller = new AbortController();
  const started = Date.now();
  const pending = brain.send("ignored", { signal: controller.signal });
  await Bun.sleep(30);
  controller.abort(new Error("stop subprocess"));

  await expect(pending).rejects.toThrow("stop subprocess");
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("sendStream abort kills a silent subprocess while next() is pending", async () => {
  const brain = new SubprocessCLIBrain({
    name: "test",
    binary: "sh",
    args: ["-c", "trap \"\" TERM; while :; do sleep 1; done"],
  });
  const controller = new AbortController();
  const iterator = brain.sendStream("ignored", { signal: controller.signal })[Symbol.asyncIterator]();
  const pending = iterator.next();
  await Bun.sleep(30);
  controller.abort(new Error("stop stream"));

  await expect(pending).rejects.toThrow("stop stream");
});

test.skipIf(process.platform === "win32")("a completed CLI turn reaps descendants that inherited its pipes", async () => {
  const brain = new SubprocessCLIBrain({
    name: "test",
    binary: "sh",
    args: ["-c", "sleep 100 & echo $!"],
  });
  const started = performance.now();

  const childPid = Number.parseInt(await brain.send("ignored"), 10);

  expect(Number.isInteger(childPid)).toBe(true);
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(() => process.kill(childPid, 0)).toThrow();
});

test.skipIf(process.platform === "win32")("a rejected CLI exit observer still drives fail-closed cleanup", async () => {
  const exited = Promise.reject<number>(new Error("fixture waitpid failed"));
  void exited.catch(() => { /* the owned observer consumes the same rejection */ });
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const proc: TurnProcess = {
    pid: 987_654_318,
    exited,
    kill(signal) { signals.push(signal); },
  };

  await expect(awaitOwnedTurnExit(proc)).rejects.toThrow("exit observation failed");
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test.skipIf(process.platform === "win32")("a failed batch output pipe still reaps the owned turn", async () => {
  const brain = new SubprocessCLIBrain({ name: "test", binary: "unused", args: [] });
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  let closeStderr!: () => void;
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) { closeStderr = () => controller.close(); },
  });
  const proc = {
    pid: 987_654_317,
    exited,
    stdout: new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("fixture stdout read failed")); },
    }),
    stderr,
    kill(signal?: NodeJS.Signals | number) {
      signals.push(signal);
      closeStderr();
      resolveExit(0);
    },
  };
  (brain as unknown as { spawnProc: (message: string) => typeof proc }).spawnProc = () => proc;

  await expect(brain.send("ignored")).rejects.toThrow("fixture stdout read failed");
  expect(signals).toEqual(["SIGTERM"]);
});

test("send surfaces stdout in the error when a failed process leaves stderr empty", async () => {
  // Mirrors `claude --print`: writes its real error to stdout, exits non-zero,
  // stderr empty. The cause must not be swallowed into a bare "exited with 1".
  const brain = new SubprocessCLIBrain({ name: "Claude Code", binary: "sh", args: ["-c", "echo 'Invalid API key'; exit 1"] });
  await expect(brain.send("hi")).rejects.toThrow(/Claude Code exited with 1: Invalid API key/);
});

test("sendStream surfaces stdout in the error on non-zero exit", async () => {
  const brain = new SubprocessCLIBrain({ name: "Claude Code", binary: "sh", args: ["-c", "echo 'Invalid API key'; exit 1"] });
  let err: Error | null = null;
  try {
    for await (const piece of brain.sendStream("hi")) void piece;
  } catch (e) {
    err = e as Error;
  }
  expect(err?.message).toMatch(/Claude Code exited with 1: Invalid API key/);
});

test("stderr still takes precedence over stdout in the failure message", async () => {
  const brain = new SubprocessCLIBrain({ name: "test", binary: "sh", args: ["-c", "echo out; echo problem >&2; exit 3"] });
  await expect(brain.send("hi")).rejects.toThrow(/test exited with 3: problem/);
});

test("unsetEnv removes the variable from the child process env (OAuth path)", async () => {
  process.env.CICERO_TEST_SECRET = "leaked";
  try {
    const stripped = new SubprocessCLIBrain({ name: "t", binary: "sh", args: ["-c", "echo val=$CICERO_TEST_SECRET"], unsetEnv: ["CICERO_TEST_SECRET"] });
    expect((await stripped.send("x")).trim()).toBe("val=");
    const inherited = new SubprocessCLIBrain({ name: "t", binary: "sh", args: ["-c", "echo val=$CICERO_TEST_SECRET"] });
    expect((await inherited.send("x")).trim()).toBe("val=leaked");
  } finally {
    delete process.env.CICERO_TEST_SECRET;
  }
});
