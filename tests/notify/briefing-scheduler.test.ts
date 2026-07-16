import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BriefingScheduler,
  BriefingStatusStore,
  type BriefingDeliveryGate,
  type BriefingRunResult,
} from "../../src/notify/briefing-scheduler";
import { OvernightStore } from "../../src/notify/overnight-store";
import { sendTelegramText } from "../../src/notify/telegram";

const roots: string[] = [];

function statusStore(): BriefingStatusStore {
  const root = mkdtempSync(join(tmpdir(), "cicero-briefing-scheduler-"));
  roots.push(root);
  return new BriefingStatusStore(join(root, "briefing-status.json"));
}

function local(hours: number, minutes: number, day = 15): Date {
  return new Date(2026, 6, day, hours, minutes, 5);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition was not reached");
}

function scheduler(options: {
  now: () => Date;
  run: (signal: AbortSignal, beforeDelivery: BriefingDeliveryGate) => Promise<BriefingRunResult>;
  store?: BriefingStatusStore;
  at?: string;
  catchUpMinutes?: number;
  timezone?: string;
  quietHours?: { from: string; to: string };
}): { scheduler: BriefingScheduler; store: BriefingStatusStore } {
  const store = options.store ?? statusStore();
  return {
    store,
    scheduler: new BriefingScheduler({
      at: options.at ?? "08:30",
      catchUpMinutes: options.catchUpMinutes ?? 180,
      timezone: options.timezone,
      quietHours: options.quietHours,
      now: options.now,
      run: (_trigger, signal, beforeDelivery) => options.run(signal, beforeDelivery),
      store,
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("exact-minute delivery fires once", async () => {
  let now = local(8, 30);
  let calls = 0;
  const h = scheduler({ now: () => now, run: async () => { calls++; return { phase: "delivered" }; } });

  await h.scheduler.tick();
  await h.scheduler.tick();
  expect(calls).toBe(1);
  expect(await h.store.read()).toMatchObject({ phase: "delivered", trigger: "scheduled" });

  now = local(8, 30, 16);
  await h.scheduler.tick();
  expect(calls).toBe(2);
});

test("08:30 America/New_York catches up at 09:47", async () => {
  const now = new Date("2026-07-15T13:47:05Z");
  let trigger = "";
  const h = scheduler({
    now: () => now,
    timezone: "America/New_York",
    run: async () => ({ phase: "delivered", channels: { telegram: (trigger = "accepted") } }),
  });
  await h.scheduler.tick();
  expect(trigger).toBe("accepted");
  expect(await h.store.read()).toMatchObject({ day: "2026-07-15", trigger: "catch-up" });
});

test("multiple ticks while a delivery is in flight do not duplicate", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const h = scheduler({
    now: () => local(8, 30),
    run: async () => { calls++; await gate; return { phase: "delivered" }; },
  });
  const first = h.scheduler.tick();
  const second = h.scheduler.tick();
  await waitFor(() => calls === 1);
  expect(calls).toBe(1);
  release();
  await Promise.all([first, second]);
  expect(calls).toBe(1);
});

test("restart with today's persisted claim does not duplicate", async () => {
  const store = statusStore();
  const now = local(8, 31);
  expect(await store.claim({
    day: now.toDateString(), scheduledAt: "08:30", trigger: "catch-up",
    claimedAt: now.getTime(), phase: "claimed",
  })).toBe(true);
  let calls = 0;
  const h = scheduler({ store, now: () => now, run: async () => { calls++; return { phase: "delivered" }; } });
  await h.scheduler.tick();
  expect(calls).toBe(0);
  expect((await store.read())?.phase).toBe("claimed");
});

test("a corrupt status is quarantined and the next tick can claim and fire", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-briefing-corrupt-"));
  roots.push(root);
  const file = join(root, "briefing-status.json");
  writeFileSync(file, "{broken", { mode: 0o600 });
  const store = new BriefingStatusStore(file);

  expect(await store.read()).toBeNull();
  expect(readdirSync(root).some((name) => name.startsWith("briefing-status.json.corrupt-"))).toBe(true);

  let calls = 0;
  const h = scheduler({ store, now: () => local(8, 30), run: async () => { calls++; return { phase: "delivered" }; } });
  await h.scheduler.tick();
  expect(calls).toBe(1);
  expect((await store.read())?.phase).toBe("delivered");
});

test("a parseable status with a wrong-typed optional field is quarantined and does not wedge delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-briefing-structural-corrupt-"));
  roots.push(root);
  const file = join(root, "briefing-status.json");
  writeFileSync(file, JSON.stringify({
    day: "2026-07-14",
    scheduledAt: "08:30",
    trigger: "scheduled",
    claimedAt: local(8, 30, 14).getTime(),
    phase: "delivered",
    contentSummary: 7,
  }), { mode: 0o600 });
  const store = new BriefingStatusStore(file);
  let calls = 0;
  const h = scheduler({ store, now: () => local(8, 30), run: async () => { calls++; return { phase: "delivered" }; } });

  await h.scheduler.tick();

  expect(calls).toBe(1);
  expect(readdirSync(root).some((name) => name.startsWith("briefing-status.json.corrupt-"))).toBe(true);
  expect((await store.read())?.phase).toBe("delivered");
});

test("an oversized status is quarantined instead of wedging future claims", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-briefing-oversized-"));
  roots.push(root);
  const file = join(root, "briefing-status.json");
  writeFileSync(file, `"${"x".repeat(1_000_001)}"`, { mode: 0o600 });
  const store = new BriefingStatusStore(file);

  expect(await store.read()).toBeNull();
  expect(readdirSync(root).some((name) => name.startsWith("briefing-status.json.corrupt-"))).toBe(true);
  expect(await store.claim({
    day: local(8, 30).toDateString(), scheduledAt: "08:30", trigger: "scheduled",
    claimedAt: local(8, 30).getTime(), phase: "claimed",
  })).toBe(true);
});

test("a valid same-day claim is not quarantined", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-briefing-valid-"));
  roots.push(root);
  const file = join(root, "briefing-status.json");
  const store = new BriefingStatusStore(file);
  const now = local(8, 30);
  await store.claim({
    day: now.toDateString(), scheduledAt: "08:30", trigger: "scheduled",
    claimedAt: now.getTime(), phase: "claimed",
  });

  expect((await store.read())?.day).toBe(now.toDateString());
  expect(readdirSync(root).some((name) => name.includes(".corrupt-"))).toBe(false);
});

test("restart after the catch-up window records missed and sends nothing", async () => {
  let calls = 0;
  const h = scheduler({
    now: () => local(11, 31),
    catchUpMinutes: 180,
    run: async () => { calls++; return { phase: "delivered" }; },
  });
  await h.scheduler.tick();
  expect(calls).toBe(0);
  expect(await h.store.read()).toMatchObject({ phase: "missed", trigger: "catch-up" });
});

test("quiet hours delay catch-up until they end", async () => {
  let now = local(9, 47);
  let calls = 0;
  const h = scheduler({
    now: () => now,
    catchUpMinutes: 180,
    quietHours: { from: "23:00", to: "10:00" },
    run: async () => { calls++; return { phase: "delivered" }; },
  });
  await h.scheduler.tick();
  expect(calls).toBe(0);
  expect(await h.store.read()).toBeNull();
  now = local(10, 0);
  await h.scheduler.tick();
  expect(calls).toBe(1);
});

test("quiet hours extending past the cutoff miss instead of making a late call", async () => {
  let now = local(10, 29);
  let calls = 0;
  const h = scheduler({
    now: () => now,
    catchUpMinutes: 120,
    quietHours: { from: "23:00", to: "10:31" },
    run: async () => { calls++; return { phase: "delivered" }; },
  });
  await h.scheduler.tick();
  now = local(10, 31);
  await h.scheduler.tick();
  expect(calls).toBe(0);
  expect((await h.store.read())?.phase).toBe("missed");
});

test("spring-forward gaps resolve later while normal and fall-back times retain catch-up behavior", async () => {
  let springNow = new Date("2026-03-08T06:45:00Z");
  let springCalls = 0;
  const spring = scheduler({
    at: "02:30",
    catchUpMinutes: 0,
    timezone: "America/New_York",
    now: () => springNow,
    run: async () => { springCalls++; return { phase: "delivered" }; },
  });
  await spring.scheduler.tick();
  expect(springCalls).toBe(0);
  expect(await spring.store.read()).toBeNull();

  springNow = new Date("2026-03-08T07:30:00Z");
  await spring.scheduler.tick();
  expect(springCalls).toBe(1);
  expect((await spring.store.read())?.trigger).toBe("catch-up");

  springNow = new Date("2026-03-09T06:30:00Z");
  await spring.scheduler.tick();
  expect(springCalls).toBe(2);
  expect(await spring.store.read()).toMatchObject({ day: "2026-03-09", trigger: "scheduled" });

  let fallNow = new Date("2026-11-01T05:45:00Z");
  let fallCalls = 0;
  const fall = scheduler({
    at: "01:30",
    timezone: "America/New_York",
    now: () => fallNow,
    run: async () => { fallCalls++; return { phase: "delivered" }; },
  });
  await fall.scheduler.tick();
  expect((await fall.store.read())?.trigger).toBe("catch-up");
  fallNow = new Date("2026-11-01T06:45:00Z");
  await fall.scheduler.tick();
  expect(fallCalls).toBe(1);
});

test("fall-back catch-up uses real elapsed time instead of repeated wall-clock minutes", async () => {
  let calls = 0;
  const h = scheduler({
    at: "00:30",
    catchUpMinutes: 120,
    timezone: "America/New_York",
    now: () => new Date("2026-11-01T07:15:00Z"),
    run: async () => { calls++; return { phase: "delivered" }; },
  });

  await h.scheduler.tick();

  expect(calls).toBe(0);
  expect(await h.store.read()).toMatchObject({ day: "2026-11-01", phase: "missed" });
});

test("spring-forward catch-up stays open for its real elapsed window", async () => {
  let calls = 0;
  const h = scheduler({
    at: "01:30",
    catchUpMinutes: 90,
    timezone: "America/New_York",
    now: () => new Date("2026-03-08T07:15:00Z"),
    run: async () => { calls++; return { phase: "delivered" }; },
  });

  await h.scheduler.tick();

  expect(calls).toBe(1);
  expect(await h.store.read()).toMatchObject({ day: "2026-03-08", phase: "delivered", trigger: "catch-up" });
});

test("non-transition catch-up retains the configured elapsed window", async () => {
  let now = new Date("2026-07-15T14:30:00Z");
  let calls = 0;
  const h = scheduler({
    at: "08:30",
    catchUpMinutes: 120,
    timezone: "America/New_York",
    now: () => now,
    run: async () => { calls++; return { phase: "delivered" }; },
  });

  await h.scheduler.tick();
  expect(calls).toBe(1);
  expect(await h.store.read()).toMatchObject({ phase: "delivered", trigger: "catch-up" });

  now = new Date("2026-07-16T14:31:00Z");
  await h.scheduler.tick();
  expect(calls).toBe(1);
  expect(await h.store.read()).toMatchObject({ day: "2026-07-16", phase: "missed" });
});

test("shutdown abort prevents late completion and drains the owned run", async () => {
  let aborted = false;
  let started = false;
  const h = scheduler({
    now: () => local(8, 30),
    run: (signal) => new Promise((resolve) => {
      started = true;
      signal.addEventListener("abort", () => { aborted = true; resolve({ phase: "delivered" }); }, { once: true });
    }),
  });
  const ticking = h.scheduler.tick();
  await waitFor(() => started);
  await h.scheduler.stop();
  await ticking;
  expect(aborted).toBe(true);
  expect((await h.store.read())?.phase).toBe("claimed");
});

test("aborting an in-flight Telegram briefing cancels the send and preserves its overnight snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-briefing-abort-"));
  roots.push(root);
  const overnight = new OvernightStore(join(root, "overnight.json"), () => 1_700_000_000_000, () => "item-1");
  await overnight.enqueue("queued overnight");
  let requestStarted = false;
  let requestAborted = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
    requestStarted = true;
    const signal = init?.signal;
    const aborted = (): void => {
      requestAborted = true;
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
  });
  const h = scheduler({
    now: () => local(8, 30),
    run: async (signal, beforeDelivery) => {
      const snapshot = await overnight.peek();
      beforeDelivery();
      const accepted = await sendTelegramText(
        { token: "tok", chat_id: 42 },
        "briefing",
        "http://telegram.test",
        {},
        signal,
      );
      if (accepted && !signal.aborted) await overnight.ack(snapshot.map((item) => item.id));
      signal.throwIfAborted();
      return { phase: accepted ? "delivered" : "failed" };
    },
  });

  try {
    const ticking = h.scheduler.tick();
    await waitFor(() => requestStarted);
    await h.scheduler.stop();
    await ticking;
    await waitFor(() => requestAborted);
    expect((await overnight.peek()).map((item) => item.text)).toEqual(["queued overnight"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a lookup that crosses the cutoff or local midnight cannot deliver late", async () => {
  for (const afterLookup of [local(11, 31), local(0, 1, 16)]) {
    let now = local(8, 30);
    let delivered = false;
    const h = scheduler({
      now: () => now,
      catchUpMinutes: 180,
      run: async (_signal, beforeDelivery) => {
        now = afterLookup;
        beforeDelivery();
        delivered = true;
        return { phase: "delivered" };
      },
    });

    await h.scheduler.tick();
    expect(delivered).toBe(false);
    expect((await h.store.read())?.phase).toBe("missed");
  }
});

test("partial and failure statuses are durable and do not retry the same day", async () => {
  for (const result of [
    { phase: "partial", channels: { telegram: "accepted", voice: "failed" }, errorKind: "Voice Provider: body" },
    { phase: "failed", channels: { telegram: "failed" }, errorKind: "Telegram provider body" },
  ] satisfies BriefingRunResult[]) {
    let calls = 0;
    const h = scheduler({
      now: () => local(8, 30),
      run: async () => { calls++; return result; },
    });
    await h.scheduler.tick();
    await h.scheduler.tick();
    expect(calls).toBe(1);
    const persisted = await h.store.read();
    expect(persisted?.phase).toBe(result.phase);
    expect(persisted?.errorKind).toMatch(/^[a-z0-9_-]+$/);
  }
});
