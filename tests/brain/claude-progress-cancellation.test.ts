import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { ClaudeCodeBrain } from "../../src/brain/claude-code";

type FixtureMode = "silent" | "term-tree" | "early-return" | "stdout-close" | "stderr-flood" | "remembered-cap";

const FIXTURE = fileURLToPath(new URL("./fixtures/claude-progress-child.ts", import.meta.url));

class FixtureClaudeBrain extends ClaudeCodeBrain {
  readonly invocations: string[][] = [];
  readonly spawnedPids: number[] = [];
  readonly rememberedResponses: string[] = [];

  constructor(
    private readonly modes: FixtureMode[],
    extraArgs: string[] = [],
  ) {
    super("claude", extraArgs);
  }

  protected override spawnWithArgs(args: string[], message: string) {
    const mode = this.modes.shift();
    if (!mode) throw new Error("Claude progress fixture queue exhausted");
    this.invocations.push([...args]);
    this.buildPrompt(message);
    const command = mode === "stdout-close"
      ? ["sh", "-c", "exec 1>&-; trap 'exit 0' TERM; while :; do sleep 1; done"]
      : [process.execPath, FIXTURE, mode];
    const proc = Bun.spawn(command, {
      detached: process.platform !== "win32",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.spawnedPids.push(proc.pid);
    return proc;
  }

  protected override rememberTurn(message: string, response: string): void {
    this.rememberedResponses.push(response);
    super.rememberTurn(message, response);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parsePid(chunk: string, label: "PARENT" | "CHILD"): number {
  const match = chunk.match(new RegExp(`${label}=(\\d+)`));
  if (!match?.[1]) throw new Error(`missing ${label} pid in ${chunk}`);
  return Number.parseInt(match[1], 10);
}

async function consume(brain: ClaudeCodeBrain, signal?: AbortSignal): Promise<void> {
  try {
    for await (const _chunk of brain.streamProgress("fixture prompt", { signal })) {
      // Drain all narration so process completion and diagnostics are observed.
    }
  } catch (error: unknown) {
    throw error;
  }
}

test("silent Claude narration observes abort and reaps promptly", async () => {
  const brain = new FixtureClaudeBrain(["silent"]);
  const controller = new AbortController();
  const iterator = brain.streamProgress("wait", { signal: controller.signal })[Symbol.asyncIterator]();
  const pending = iterator.next();
  await Bun.sleep(30);
  const started = performance.now();
  controller.abort(new DOMException("stop silent narration", "AbortError"));

  await expect(pending).rejects.toThrow("stop silent narration");
  expect(performance.now() - started).toBeLessThan(1_500);
  expect(processExists(brain.spawnedPids[0]!)).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "TERM-resistant Claude process groups escalate to KILL and reap descendants",
  async () => {
    const brain = new FixtureClaudeBrain(["term-tree"]);
    const controller = new AbortController();
    const iterator = brain.streamProgress("tree", { signal: controller.signal })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const parentPid = parsePid(first.value, "PARENT");
    const childPid = parsePid(first.value, "CHILD");
    const pending = iterator.next();
    const started = performance.now();
    controller.abort(new DOMException("stop process tree", "AbortError"));

    await expect(pending).rejects.toThrow("stop process tree");
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(1_750);
    expect(processExists(parentPid)).toBe(false);
    expect(processExists(childPid)).toBe(false);
  },
);

test("consumer early return terminates and reaps Claude narration", async () => {
  const brain = new FixtureClaudeBrain(["early-return"]);
  let parentPid = 0;
  const started = performance.now();
  for await (const chunk of brain.streamProgress("one chunk")) {
    parentPid = parsePid(chunk, "PARENT");
    break;
  }

  expect(parentPid).toBeGreaterThan(0);
  expect(performance.now() - started).toBeLessThan(1_500);
  expect(processExists(parentPid)).toBe(false);
});

test.skipIf(process.platform === "win32")("a Claude process cannot stay alive after closing its progress stream", async () => {
  const brain = new FixtureClaudeBrain(["stdout-close"]);
  const started = performance.now();
  const error = await consume(brain).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("remained alive after its output stream closed");
  expect(performance.now() - started).toBeLessThan(1_750);
  expect(processExists(brain.spawnedPids[0]!)).toBe(false);
});

test.skipIf(process.platform === "win32")("abort remains armed after Claude closes stdout but before process exit", async () => {
  const brain = new FixtureClaudeBrain(["stdout-close"]);
  const controller = new AbortController();
  const started = performance.now();
  const pending = consume(brain, controller.signal);
  await Bun.sleep(50);

  controller.abort(new DOMException("cancel after Claude EOF", "AbortError"));

  await expect(pending).rejects.toThrow("cancel after Claude EOF");
  expect(performance.now() - started).toBeLessThan(450);
  expect(processExists(brain.spawnedPids[0]!)).toBe(false);
});

test("stderr floods drain without deadlock and retain only a bounded diagnostic tail", async () => {
  const brain = new FixtureClaudeBrain(["stderr-flood"]);
  const started = performance.now();
  const error = await consume(brain).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain("Claude Code exited with 7");
  expect(message).toContain("TAIL_TOKEN");
  expect(message).toContain("stderr truncated; tail retained");
  expect(message).not.toContain("HEAD_TOKEN");
  expect(message.length).toBeLessThan(8_200);
  expect(performance.now() - started).toBeLessThan(2_000);
});

test("remembered progress is capped while safe Claude flags remain unchanged", async () => {
  const flags = ["--dangerously-skip-permissions", "--model", "sonnet"];
  const brain = new FixtureClaudeBrain(["remembered-cap"], flags);
  let chunks = 0;
  for await (const _chunk of brain.streamProgress("large narration")) chunks++;

  expect(chunks).toBe(64);
  expect(brain.rememberedResponses[0]?.length).toBe(8_000);
  expect(brain.rememberedResponses[0]).toContain("chunk-63");
  expect(brain.invocations[0]).toEqual([
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    ...flags,
  ]);
});
