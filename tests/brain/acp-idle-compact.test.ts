import { test, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { AcpBrain, dropOffSpecUpdates, parseContextUsage, type AcpBrainConfig } from "../../src/brain/acp";

const MOCK_AGENT = join(import.meta.dir, "fixtures", "mock-acp-agent.ts");
const IDLE_MS = 1_000;
let brain: AcpBrain | null = null;

afterEach(async () => {
  await brain?.stop();
  brain = null;
});

function start(usage: string | null, overrides: Partial<AcpBrainConfig> = {}): { brain: AcpBrain; prompts: () => string[] } {
  const log = join(mkdtempSync(join(tmpdir(), "cicero-idle-compact-")), "prompts.jsonl");
  brain = new AcpBrain({
    binary: process.execPath,
    args: [MOCK_AGENT],
    startTimeoutMs: 15_000,
    terminateGraceMs: 100,
    env: { CICERO_TEST_ACP_PROMPT_LOG: log, ...(usage ? { CICERO_TEST_ACP_USAGE: usage } : {}) },
    idleCompact: { command: "/compress", idleMs: IDLE_MS, minUsage: 0.4 },
    ...overrides,
  });
  const prompts = (): string[] => existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string)
    : [];
  return { brain, prompts };
}

const idle = (): Promise<void> => Bun.sleep(IDLE_MS + 600);

test("a full context is compacted with the raw command once the conversation goes idle", async () => {
  const { brain, prompts } = start("45000/100000");
  await brain.start();
  await brain.send("hello there");
  expect(brain.lastContextUsage()).toEqual({ used: 45_000, size: 100_000 });
  expect(prompts().filter((p) => p === "/compress")).toHaveLength(0);
  await idle();
  expect(prompts().filter((p) => p === "/compress")).toHaveLength(1);
  // At most once per idle period: nothing re-arms the timer until a real turn.
  await idle();
  expect(prompts().filter((p) => p === "/compress")).toHaveLength(1);
}, 20_000);

test("a context under the threshold is left alone", async () => {
  const { brain, prompts } = start("30000/100000");
  await brain.start();
  await brain.send("hello there");
  await idle();
  expect(prompts()).not.toContain("/compress");
}, 20_000);

test("an agent that reports no usage is never compacted", async () => {
  const { brain, prompts } = start(null);
  await brain.start();
  await brain.send("hello there");
  await idle();
  expect(prompts()).not.toContain("/compress");
}, 20_000);

test("a turn inside the idle window restarts it instead of compacting mid-conversation", async () => {
  const { brain, prompts } = start("45000/100000");
  await brain.start();
  await brain.send("first");
  await Bun.sleep(IDLE_MS - 400);
  await brain.send("second");
  await Bun.sleep(IDLE_MS - 400);
  expect(prompts()).not.toContain("/compress");
  await Bun.sleep(1_000);
  expect(prompts()).toContain("/compress");
}, 20_000);

test("compaction leaves one-shot injected context for the next real turn", async () => {
  const { brain, prompts } = start("45000/100000");
  await brain.start();
  await brain.send("first");
  brain.injectContext("synthetic one-shot context");
  await idle();
  expect(prompts()).toContain("/compress");
  await brain.send("second");
  const last = prompts().at(-1)!;
  expect(last).toContain("synthetic one-shot context");
  expect(last).toContain("second");
}, 20_000);

test("usage reported for another session never triggers compaction", async () => {
  const { brain, prompts } = start(null);
  await brain.start();
  await brain.send("usage:10000/100000 usage-other:90000/100000");
  expect(brain.lastContextUsage()).toEqual({ used: 10_000, size: 100_000 });
  await idle();
  expect(prompts()).not.toContain("/compress");
}, 20_000);

test("a crashed session's usage does not compact its replacement", async () => {
  const { brain, prompts } = start(null);
  await brain.start();
  await brain.send("usage:90000/100000 crash now").catch(() => {});
  await Bun.sleep(300);
  await brain.start();
  expect(brain.lastContextUsage()).toBeNull();
  await brain.send("fresh session, no usage report");
  await idle();
  expect(prompts()).not.toContain("/compress");
}, 20_000);

test("a turn arriving during compaction waits instead of being refused at max_pending_turns 1", async () => {
  const { brain, prompts } = start("45000/100000", {
    maxPendingTurns: 1,
    env: {
      CICERO_TEST_ACP_USAGE: "45000/100000",
      CICERO_TEST_ACP_COMPRESS_DELAY_MS: "1500",
      CICERO_TEST_ACP_PROMPT_LOG: join(mkdtempSync(join(tmpdir(), "cicero-idle-compact-")), "prompts.jsonl"),
    },
  });
  await brain.start();
  await brain.send("first");
  await Bun.sleep(IDLE_MS + 300); // compaction is now in flight
  expect(await brain.send("second")).toContain("second");
}, 20_000);

test("stop cancels a pending idle compaction", async () => {
  const { brain: b, prompts } = start("45000/100000");
  await b.start();
  await b.send("hello there");
  await b.stop();
  brain = null;
  await idle();
  expect(prompts()).not.toContain("/compress");
}, 20_000);

test("usage parsing accepts only sane integer token counts", () => {
  expect(parseContextUsage({ used: 10, size: 100 })).toEqual({ used: 10, size: 100 });
  for (const bad of [null, "x", { used: 1 }, { used: -1, size: 10 }, { used: 1, size: 0 }, { used: 1.5, size: 10 }, { used: "1", size: 10 }, { used: 1, size: 1e12 }]) {
    expect(parseContextUsage(bad)).toBeNull();
  }
});

test("the off-spec filter reports usage and still drops the frame", async () => {
  const seen: unknown[] = [];
  const src = new ReadableStream<unknown>({
    start(c) {
      c.enqueue({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "usage_update", used: 7, size: 70 } } });
      c.close();
    },
  });
  const reader = dropOffSpecUpdates(src, (usage) => seen.push(usage)).getReader();
  expect((await reader.read()).done).toBe(true);
  expect(seen).toEqual([{ used: 7, size: 70 }]);
});

test("invalid idle compaction settings are rejected", () => {
  const base = { binary: process.execPath, args: [MOCK_AGENT] };
  expect(() => new AcpBrain({ ...base, idleCompact: { command: " ", idleMs: 60_000, minUsage: 0.4 } })).toThrow(RangeError);
  expect(() => new AcpBrain({ ...base, idleCompact: { command: "/compress", idleMs: 10, minUsage: 0.4 } })).toThrow(RangeError);
  expect(() => new AcpBrain({ ...base, idleCompact: { command: "/compress", idleMs: 60_000, minUsage: 0 } })).toThrow(RangeError);
});
