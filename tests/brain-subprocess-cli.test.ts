import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { chmodSync } from "node:fs";
import {
  awaitOwnedTurnExit,
  isBatchShim,
  pathFromEnv,
  promptGoesToStdin,
  resolveCommandBinary,
  SubprocessCLIBrain,
  type TurnProcess,
} from "../src/brain/subprocess-cli";

type FakeTurnProcess = TurnProcess & {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
};

function controlledTurnProcess(pid: number) {
  let resolveExit!: (code: number) => void;
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  let stdoutSettled = false;
  let finished = false;
  const proc: FakeTurnProcess = {
    pid,
    exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
    stdout: new ReadableStream<Uint8Array>({
      start(controller) { stdoutController = controller; },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) { stderrController = controller; },
    }),
    kill() {},
  };
  return {
    proc,
    failStdout(error: unknown) {
      stdoutSettled = true;
      stdoutController.error(error);
    },
    finish() {
      if (finished) return;
      finished = true;
      if (!stdoutSettled) stdoutController.close();
      stderrController.close();
      resolveExit(0);
    },
  };
}

function reapFailingBrain(
  proc: FakeTurnProcess,
  finishTurn: () => void,
  reapFailure: Error,
) {
  const brain = new SubprocessCLIBrain({
    name: "test",
    binary: "unused",
    args: [],
    rememberTurns: false,
  });
  let terminationCalls = 0;
  const injected = brain as unknown as {
    spawnProc: () => FakeTurnProcess;
    terminateTurnProcess: (proc: TurnProcess) => Promise<void>;
  };
  injected.spawnProc = () => proc;
  injected.terminateTurnProcess = () => {
    terminationCalls++;
    finishTurn();
    return Promise.reject(reapFailure);
  };
  return { brain, terminationCalls: () => terminationCalls };
}

function captureConsoleLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]): void => { lines.push(values.map(String).join(" ")); };
  return { lines, restore: () => { console.log = original; } };
}

test("SubprocessCLIBrain spawns the configured binary with prompt", async () => {
  const brain = new SubprocessCLIBrain({ name: "test", binary: "echo", args: ["--print"] });
  await brain.start();
  const out = await brain.send("hello");
  expect(out).toContain("hello");
});

// The shim lookup itself needs Windows, but its decision logic must not go
// unexercised on a POSIX CI run — these drive the win32 branch with an
// injected platform and `which`.
test("PATH lookup is case-insensitive and the last spelling wins", () => {
  expect(pathFromEnv({ PATH: "/usr/bin" })).toBe("/usr/bin");
  expect(pathFromEnv({ Path: "C:\\tools" })).toBe("C:\\tools");
  // buildEnv() spreads config.env last, so a configured PATH must beat the
  // inherited one whichever casing each side used.
  expect(pathFromEnv({ Path: "C:\\inherited", PATH: "C:\\configured" })).toBe("C:\\configured");
  expect(pathFromEnv({ PATH: "C:\\inherited", Path: "C:\\configured" })).toBe("C:\\configured");
  expect(pathFromEnv({ HOME: "/root" })).toBeUndefined();
});

test("command resolution is a no-op off Windows and resolves shims on it", () => {
  const seen: Array<{ command: string; PATH?: string }> = [];
  const which = ((command: string, options?: { PATH?: string }) => {
    seen.push({ command, PATH: options?.PATH });
    return command === "codex" ? "C:\\shims\\codex.cmd" : null;
  }) as typeof Bun.which;

  // POSIX spawns already search PATH — the binary must pass through untouched
  // and cost nothing.
  expect(resolveCommandBinary("codex", { PATH: "/usr/bin" }, "linux", which)).toBe("codex");
  expect(seen).toHaveLength(0);

  expect(resolveCommandBinary("codex", { Path: "C:\\shims" }, "win32", which)).toBe("C:\\shims\\codex.cmd");
  expect(seen).toEqual([{ command: "codex", PATH: "C:\\shims" }]);

  // An unresolvable name falls back to the raw binary so the spawn reports the
  // failure itself instead of this layer inventing one.
  expect(resolveCommandBinary("missing", { Path: "C:\\shims" }, "win32", which)).toBe("missing");
});

test.skipIf(process.platform !== "win32")("a resolved Windows shim is spawned, and the prompt never reaches its command line", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cicero-brain-shim-"));
  try {
    // Reports the argv cmd.exe actually parsed, then drains stdin so the write
    // side never sees a closed pipe. `more` exits 0 whether or not it read
    // anything, keeping the turn's exit status about the spawn.
    writeFileSync(join(directory, "cicero-brain-shim.cmd"), "@echo off\r\necho ARGS:%*\r\nmore >nul 2>&1\r\n");
    class InspectBrain extends SubprocessCLIBrain {
      spawnExplicit(message: string) {
        return this.spawnWithArgs(["--stream"], message);
      }
    }
    const brain = new InspectBrain({
      name: "test",
      binary: "cicero-brain-shim",
      args: ["--print"],
      env: { PATH: `${directory}${delimiter}${process.env.PATH ?? ""}` },
      rememberTurns: false,
    });

    // Reaching a shim's command line, `%PATH%` would expand and `&` would start
    // a second command. Both spawn paths must keep the prompt off it entirely;
    // that it still arrives intact over stdin is covered on POSIX above, where
    // CI can actually run it.
    const prompt = "hello %PATH% & echo INJECTED";
    const sent = await brain.send(prompt);
    expect(sent).toContain("ARGS:--print");
    expect(sent).not.toContain("hello");
    expect(sent).not.toContain("INJECTED");

    const explicit = brain.spawnExplicit(prompt);
    const output = await new Response(explicit.stdout).text();
    expect(await awaitOwnedTurnExit(explicit)).toBe(0);
    expect(output).toContain("ARGS:--stream");
    expect(output).not.toContain("hello");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A Windows `.cmd`/`.bat` shim runs through cmd.exe, which reinterprets argv
// (CVE-2024-24576). A turn's prompt is untrusted, so it must never be a command
// -line value on that path. The decision is pure so it is exercised off Windows.
test("a batch shim is recognized by extension, case-insensitively", () => {
  expect(isBatchShim("C:\\shims\\codex.cmd")).toBe(true);
  expect(isBatchShim("C:\\shims\\CODEX.CMD")).toBe(true);
  expect(isBatchShim("C:\\shims\\run.bat")).toBe(true);
  // A real executable carries no cmd.exe parsing, and a name that merely
  // contains "cmd" is not a shim.
  expect(isBatchShim("codex")).toBe(false);
  expect(isBatchShim("C:\\bin\\codex.exe")).toBe(false);
  expect(isBatchShim("/usr/bin/cmdtool")).toBe(false);
});

test("the prompt is routed to stdin for a Windows shim, and POSIX is left alone", () => {
  // An explicitly configured stdin brain (qwen/gemini) always pipes.
  expect(promptGoesToStdin("qwen", true, "linux")).toBe(true);
  // The argv brains (codex/claude) must switch to stdin once resolution has
  // handed them a shim.
  expect(promptGoesToStdin("C:\\shims\\codex.cmd", undefined, "win32")).toBe(true);
  // A real Windows executable keeps the existing argv path.
  expect(promptGoesToStdin("C:\\bin\\codex.exe", undefined, "win32")).toBe(false);
  // POSIX behavior must be unchanged even for an operator who configured a
  // binary that happens to end in .cmd — there is no cmd.exe to reinterpret it.
  expect(promptGoesToStdin("/opt/bin/weird.cmd", undefined, "linux")).toBe(false);
});

/** A probe that reports how it received its argv and stdin. */
function writeProbe(directory: string, name: string): string {
  const path = join(directory, name);
  writeFileSync(path, '#!/bin/sh\necho "ARGS:$*"\necho "STDIN:$(cat)"\n');
  chmodSync(path, 0o755);
  return path;
}

test.skipIf(process.platform === "win32")("spawnWithArgs pipes the prompt instead of putting it in argv", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cicero-stdin-probe-"));
  try {
    class InspectBrain extends SubprocessCLIBrain {
      spawnExplicit(message: string) { return this.spawnWithArgs(["--stream"], message); }
    }
    // The progress path ignored promptViaStdin and always appended the prompt to
    // argv, so a stdin brain still leaked its prompt onto the command line.
    const brain = new InspectBrain({
      name: "test",
      binary: writeProbe(directory, "probe.sh"),
      args: ["--print"],
      promptViaStdin: true,
      rememberTurns: false,
    });

    const proc = brain.spawnExplicit("secret prompt");
    const output = await new Response(proc.stdout).text();
    expect(await awaitOwnedTurnExit(proc)).toBe(0);
    expect(output).toContain("STDIN:secret prompt");
    expect(output).toContain("ARGS:--stream");
    expect(output).not.toContain("ARGS:--stream secret prompt");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test("send keeps the caller abort reason when reap confirmation fails", async () => {
  const turn = controlledTurnProcess(987_654_316);
  const reapFailure = new Error("fixture tree reap was not confirmed");
  const injected = reapFailingBrain(turn.proc, turn.finish, reapFailure);
  const controller = new AbortController();
  const abortReason = new Error("fixture caller abort");
  const captured = captureConsoleLogs();
  try {
    const pending = injected.brain.send("ignored", { signal: controller.signal });
    controller.abort(abortReason);
    await expect(pending).rejects.toBe(abortReason);
  } finally {
    captured.restore();
  }

  expect(injected.terminationCalls()).toBe(1);
  const reapLogs = captured.lines.filter((line) => line.includes(reapFailure.message));
  expect(reapLogs).toHaveLength(1);
  expect(reapLogs[0]).toContain(`turn process ${turn.proc.pid}`);
});

test("sendStream keeps the caller abort reason when reap confirmation fails", async () => {
  const turn = controlledTurnProcess(987_654_315);
  const reapFailure = new Error("fixture streaming tree reap was not confirmed");
  const injected = reapFailingBrain(turn.proc, turn.finish, reapFailure);
  const controller = new AbortController();
  const abortReason = new Error("fixture streaming caller abort");
  const captured = captureConsoleLogs();
  try {
    const iterator = injected.brain.sendStream("ignored", { signal: controller.signal })[Symbol.asyncIterator]();
    const pending = iterator.next();
    controller.abort(abortReason);
    await expect(pending).rejects.toBe(abortReason);
  } finally {
    captured.restore();
  }

  expect(injected.terminationCalls()).toBe(1);
  const reapLogs = captured.lines.filter((line) => line.includes(reapFailure.message));
  expect(reapLogs).toHaveLength(1);
  expect(reapLogs[0]).toContain(`turn process ${turn.proc.pid}`);
});

test("a non-abort pipe teardown still propagates a reap failure", async () => {
  const turn = controlledTurnProcess(987_654_314);
  const pipeFailure = new Error("fixture stdout read failed before teardown");
  const reapFailure = new Error("fixture non-abort tree reap was not confirmed");
  const injected = reapFailingBrain(turn.proc, turn.finish, reapFailure);
  turn.failStdout(pipeFailure);
  const captured = captureConsoleLogs();
  try {
    await expect(injected.brain.send("ignored")).rejects.toBe(reapFailure);
  } finally {
    captured.restore();
  }

  expect(injected.terminationCalls()).toBe(1);
  expect(captured.lines.some((line) => line.includes(reapFailure.message))).toBe(true);
  expect(captured.lines.some((line) => line.includes(pipeFailure.message))).toBe(false);
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
