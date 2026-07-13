import { expect, test } from "bun:test";
import { FallbackSTTProvider } from "../../../src/backends/stt/fallback";
import { FasterWhisperProvider } from "../../../src/backends/stt/faster-whisper";
import type {
  STTProvider,
  STTTranscriptionResult,
} from "../../../src/backends/stt/provider";

function fake(name: string, overrides: Partial<STTProvider> = {}): STTProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    calls,
    transcribe: (path: string) => { calls.push(`transcribe:${path}`); return Promise.resolve(`${name} transcript`); },
    health: () => { calls.push("health"); return Promise.resolve(true); },
    start: () => { calls.push("start"); return Promise.resolve(); },
    stop: () => { calls.push("stop"); return Promise.resolve(); },
    warmup: () => { calls.push("warmup"); return Promise.resolve(); },
    ...overrides,
  } as STTProvider & { calls: string[] };
}

function result(value: STTTranscriptionResult): () => Promise<STTTranscriptionResult> {
  return () => Promise.resolve(value);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("uses the primary transcript without invoking the fallback", async () => {
  const primary = fake("primary");
  const fallback = fake("fallback");
  const provider = new FallbackSTTProvider(primary, fallback);

  expect(await provider.transcribe("turn.wav")).toBe("primary transcript");
  expect(primary.calls).toContain("transcribe:turn.wav");
  expect(fallback.calls).not.toContain("transcribe:turn.wav");
});

test("an ambiguous legacy null remains silence instead of risking a fallback hallucination", async () => {
  let primaryResult: string | null = null;
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const provider = new FallbackSTTProvider(
      fake("primary", {
        transcribe: () => { primaryCalls++; return Promise.resolve(primaryResult); },
      }),
      fake("fallback", {
        transcribe: () => { fallbackCalls++; return Promise.resolve("fallback transcript"); },
      }),
    );

    expect(await provider.transcribe("first.wav")).toBeNull();
    primaryResult = "primary recovered";
    expect(await provider.transcribe("second.wav")).toBe("primary recovered");
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(0);
    expect(lines.some((line) => line.includes("stt primary degraded"))).toBe(false);
  } finally {
    console.log = originalLog;
  }
});

test("a structured empty primary remains silence, skips the fallback, and proves operational recovery", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    let primaryFailure = true;
    let fallbackCalls = 0;
    const provider = new FallbackSTTProvider(
      fake("primary", {
        transcribeResult: () => Promise.resolve(primaryFailure
          ? { kind: "failure" as const, reason: "offline" }
          : { kind: "empty" as const }),
      }),
      fake("fallback", {
        transcribeResult: () => {
          fallbackCalls++;
          return Promise.resolve({ kind: "transcript" as const, text: "hallucinated speech" });
        },
      }),
    );

    expect(await provider.transcribe("failed.wav")).toBe("hallucinated speech");
    primaryFailure = false;
    expect(await provider.transcribe("silence.wav")).toBeNull();
    expect(await provider.transcribe("silence-again.wav")).toBeNull();
    expect(fallbackCalls).toBe(1);
    expect(lines.filter((line) => line.includes("stt primary degraded")).length).toBe(1);
    expect(lines.filter((line) => line.includes("stt primary recovered")).length).toBe(1);
  } finally {
    console.log = originalLog;
  }
});

test("both transcription engines failing returns null instead of dropping the turn with an exception", async () => {
  const provider = new FallbackSTTProvider(
    fake("primary", { transcribe: () => Promise.reject(new Error("primary offline")) }),
    fake("fallback", { transcribe: () => Promise.reject(new Error("fallback offline")) }),
  );

  expect(await provider.transcribe("turn.wav")).toBeNull();
});

test("one degradation warning is emitted until a diagnosed primary failure recovers", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  let primaryOnline = false;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const provider = new FallbackSTTProvider(
      fake("primary", {
        transcribeResult: () => Promise.resolve(primaryOnline
          ? { kind: "transcript" as const, text: "back" }
          : { kind: "failure" as const, reason: "primary offline" }),
      }),
      fake("fallback", { transcribeResult: result({ kind: "transcript", text: "fallback transcript" }) }),
    );

    await provider.transcribe("one.wav");
    await provider.transcribe("two.wav");
    expect(lines.filter((line) => line.includes("stt primary degraded")).length).toBe(1);

    primaryOnline = true;
    await provider.transcribe("three.wav");
    primaryOnline = false;
    await provider.transcribe("four.wav");
    expect(lines.filter((line) => line.includes("stt primary degraded")).length).toBe(2);
    expect(lines.some((line) => line.includes("stt primary recovered"))).toBe(true);
  } finally {
    console.log = originalLog;
  }
});

test("concrete provider diagnostics suppress repeated per-turn warnings inside the wrapper", async () => {
  const originalLog = console.log;
  const originalFetch = globalThis.fetch;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  globalThis.fetch = (() => Promise.resolve(new Response("down", { status: 500 }))) as typeof fetch;
  try {
    const provider = new FallbackSTTProvider(
      new FasterWhisperProvider({ backend: "faster-whisper" }),
      fake("fallback", { transcribeResult: result({ kind: "transcript", text: "heard" }) }),
    );

    expect(await provider.transcribe("one.wav")).toBe("heard");
    expect(await provider.transcribe("two.wav")).toBe("heard");
    expect(lines.filter((line) => line.includes("⚠️")).length).toBe(1);
    expect(lines.filter((line) => /⚠️ faster-whisper returned 500$/.test(line)).length).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("an older fallback completion cannot overwrite a newer primary recovery", async () => {
  const fallbackGate = deferred();
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const provider = new FallbackSTTProvider(
      fake("primary", {
        transcribeResult: (path: string) => Promise.resolve(path === "old.wav"
          ? { kind: "failure" as const, reason: "old failure" }
          : { kind: "transcript" as const, text: "new primary" }),
      }),
      fake("fallback", {
        transcribeResult: async () => {
          try {
            await fallbackGate.promise;
            return { kind: "transcript", text: "late fallback" } as const;
          } catch (error: unknown) {
            throw error;
          }
        },
      }),
    );

    const old = provider.transcribe("old.wav");
    await Bun.sleep(0);
    expect(await provider.transcribe("new.wav")).toBe("new primary");
    fallbackGate.resolve();
    expect(await old).toBe("late fallback");
    expect(await provider.transcribe("newer.wav")).toBe("new primary");
    expect(lines.some((line) => line.includes("degraded") || line.includes("recovered"))).toBe(false);
  } finally {
    console.log = originalLog;
  }
});

test("a stale fallback failure cannot suppress a later current unavailability warning", async () => {
  const fallbackGate = deferred();
  const originalLog = console.log;
  const lines: string[] = [];
  let currentPath = "old.wav";
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const provider = new FallbackSTTProvider(
      fake("primary", {
        transcribeResult: (path: string) => Promise.resolve(path === "old.wav"
          ? { kind: "failure" as const, reason: "old primary failure" }
          : { kind: "empty" as const }),
        health: () => Promise.resolve(true),
      }),
      fake("fallback", {
        transcribeResult: async () => {
          try {
            await fallbackGate.promise;
            return { kind: "failure", reason: "stale fallback failure" } as const;
          } catch (error: unknown) {
            throw error;
          }
        },
        health: () => Promise.resolve(false),
      }),
    );

    const old = provider.transcribe(currentPath);
    await Bun.sleep(0);
    currentPath = "new.wav";
    expect(await provider.transcribe(currentPath)).toBeNull();
    fallbackGate.resolve();
    expect(await old).toBeNull();

    expect(await provider.health()).toBe(true);
    expect(lines.filter((line) => line.includes("stt fallback fallback unavailable")).length).toBe(1);
  } finally {
    console.log = originalLog;
  }
});

test("health verifies both seats and later returns to the recovered primary", async () => {
  let primaryHealthy = false;
  let fallbackHealthCalls = 0;
  const provider = new FallbackSTTProvider(
    fake("primary", { health: () => Promise.resolve(primaryHealthy) }),
    fake("fallback", { health: () => { fallbackHealthCalls++; return Promise.resolve(true); } }),
  );

  expect(await provider.health()).toBe(true);
  primaryHealthy = true;
  expect(await provider.health()).toBe(true);
  expect(fallbackHealthCalls).toBe(2);
});

test("start only succeeds when health verifies at least one live engine", async () => {
  const primary = fake("primary", {
    start: () => Promise.reject(new Error("no primary binary")),
    health: () => Promise.resolve(false),
    warmup: () => Promise.reject(new Error("primary cold failure")),
  });
  const fallback = fake("fallback");
  const provider = new FallbackSTTProvider(primary, fallback);

  await provider.start();
  await provider.warmup();
  await provider.stop();
  expect(fallback.calls).toEqual(expect.arrayContaining(["health", "warmup", "stop"]));

  let primaryStops = 0;
  let fallbackStops = 0;
  const dead = new FallbackSTTProvider(
    fake("primary", {
      start: () => Promise.resolve(),
      health: () => Promise.resolve(false),
      stop: () => { primaryStops++; return Promise.resolve(); },
    }),
    fake("fallback", {
      start: () => Promise.resolve(),
      health: () => Promise.resolve(false),
      stop: () => { fallbackStops++; return Promise.resolve(); },
    }),
  );
  await expect(dead.start()).rejects.toThrow("both STT engines are unavailable after start");
  expect(primaryStops).toBe(1);
  expect(fallbackStops).toBe(1);
});

test("concurrent starts coalesce and a restart waits for the intervening stop", async () => {
  const startGate = deferred();
  const stopGate = deferred();
  let primaryStarts = 0;
  let fallbackStarts = 0;
  let primaryStops = 0;
  let fallbackStops = 0;
  const primary = fake("primary", {
    start: async () => {
      try {
        primaryStarts++;
        if (primaryStarts === 1) await startGate.promise;
      } catch (error: unknown) {
        throw error;
      }
    },
    stop: async () => {
      try {
        primaryStops++;
        if (primaryStops === 1) await stopGate.promise;
      } catch (error: unknown) {
        throw error;
      }
    },
  });
  const fallback = fake("fallback", {
    start: async () => {
      try {
        fallbackStarts++;
        if (fallbackStarts === 1) await startGate.promise;
      } catch (error: unknown) {
        throw error;
      }
    },
    stop: () => { fallbackStops++; return Promise.resolve(); },
  });
  const provider = new FallbackSTTProvider(primary, fallback);

  const first = provider.start();
  const duplicate = provider.start();
  await Bun.sleep(0);
  expect(primaryStarts).toBe(1);
  expect(fallbackStarts).toBe(1);

  const stopping = provider.stop();
  const restarting = provider.start();
  await Bun.sleep(0);
  expect(primaryStarts).toBe(1);

  startGate.resolve();
  await first;
  await duplicate;
  await Bun.sleep(0);
  expect(primaryStops).toBe(1);
  expect(fallbackStops).toBe(1);

  stopGate.resolve();
  await stopping;
  await restarting;
  expect(primaryStarts).toBe(2);
  expect(fallbackStarts).toBe(2);
  await provider.stop();
});

test("lifecycle preserves every non-adjacent intent and finishes at the last requested state", async () => {
  const firstStartGate = deferred();
  let starts = 0;
  let stops = 0;
  const provider = new FallbackSTTProvider(
    fake("primary", {
      start: async () => {
        try {
          starts++;
          if (starts === 1) await firstStartGate.promise;
        } catch (error: unknown) {
          throw error;
        }
      },
      stop: () => { stops++; return Promise.resolve(); },
    }),
    fake("fallback"),
  );

  const firstStart = provider.start();
  const firstStop = provider.stop();
  const restart = provider.start();
  const finalStop = provider.stop();
  await Bun.sleep(0);
  expect(starts).toBe(1);

  firstStartGate.resolve();
  await Promise.all([firstStart, firstStop, restart, finalStop]);
  expect(starts).toBe(2);
  expect(stops).toBe(2);
});

test("a start requested during warmup waits until both warmups settle", async () => {
  const warmupGate = deferred();
  const events: string[] = [];
  const provider = new FallbackSTTProvider(
    fake("primary", {
      warmup: async () => {
        try {
          events.push("primary:warmup:start");
          await warmupGate.promise;
          events.push("primary:warmup:end");
        } catch (error: unknown) {
          throw error;
        }
      },
      start: () => { events.push("primary:start"); return Promise.resolve(); },
    }),
    fake("fallback", {
      warmup: async () => {
        try {
          await warmupGate.promise;
        } catch (error: unknown) {
          throw error;
        }
      },
      start: () => { events.push("fallback:start"); return Promise.resolve(); },
    }),
  );

  const warming = provider.warmup();
  await Bun.sleep(0);
  const starting = provider.start();
  await Bun.sleep(0);
  expect(events).not.toContain("primary:start");

  warmupGate.resolve();
  await warming;
  await starting;
  expect(events).toEqual([
    "primary:warmup:start",
    "primary:warmup:end",
    "primary:start",
    "fallback:start",
  ]);
  await provider.stop();
});

test("a failed child cleanup blocks replacement startup instead of risking overlapping owners", async () => {
  let primaryStarts = 0;
  let primaryStops = 0;
  const provider = new FallbackSTTProvider(
    fake("primary", {
      start: () => { primaryStarts++; return Promise.resolve(); },
      stop: () => {
        primaryStops++;
        return primaryStops === 1
          ? Promise.reject(new Error("primary child was not reaped"))
          : Promise.resolve();
      },
    }),
    fake("fallback"),
  );

  await provider.start();
  const stopping = provider.stop().catch((error: unknown) => error);
  const racedRestart = provider.start().catch((error: unknown) => error);
  const stopError = await stopping;
  const restartError = await racedRestart;
  expect(stopError).toBeInstanceOf(AggregateError);
  expect(String(stopError)).toContain("one or more STT engines failed to stop");
  expect(String(restartError)).toContain("prior cleanup failed");
  await expect(provider.start()).rejects.toThrow("prior cleanup failed");
  expect(primaryStarts).toBe(1);

  await expect(provider.stop()).resolves.toBeUndefined();
  await expect(provider.start()).resolves.toBeUndefined();
  expect(primaryStops).toBe(2);
  expect(primaryStarts).toBe(2);
  await provider.stop();
});
