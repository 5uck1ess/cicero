import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NudgeStateFile } from "../../src/notify/nudge-state-store";

test("nudge state file round-trips and drops malformed entries (#134)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-nudge-"));
  try {
    chmodSync(dir, 0o700);
    const file = join(dir, "kanban-nudges.json");
    const store = new NudgeStateFile(file);
    expect((await store.load()).size).toBe(0); // absent file = fresh
    await store.save(new Map([["t1", { count: 2, nextAt: 1_750_000_000_000 }]]));
    expect([...(await new NudgeStateFile(file).load())]).toEqual([["t1", { count: 2, nextAt: 1_750_000_000_000 }]]);
    writeFileSync(file, JSON.stringify({
      ok: { count: 1, nextAt: 5 }, neg: { count: -1, nextAt: 5 }, str: { count: "1", nextAt: 5 },
      nan: { count: 1, nextAt: null }, ["x".repeat(200)]: { count: 1, nextAt: 5 },
    }), { mode: 0o600 });
    expect([...(await store.load()).keys()]).toEqual(["ok"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
