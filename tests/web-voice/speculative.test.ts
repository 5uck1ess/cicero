import { test, expect } from "bun:test";
import {
  MAX_SPECULATIVE_TOKEN_BYTES,
  MAX_SPECULATIVE_TOKEN_ITEMS,
  makeSpeculator,
  pcmToWav,
  type SpeculatorDeps,
} from "../../src/web-voice/speculative";
import { wavDurationMs, isLocalFastPath } from "../../src/web-voice/turn";

/** One second of 16 kHz silence-ish PCM. */
function pcm(ms: number, sampleRate = 16000): Float32Array {
  return new Float32Array(Math.round((sampleRate * ms) / 1000));
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function deps(overrides: Partial<SpeculatorDeps> & { transcript?: string; tokens?: string[] } = {}): {
  deps: SpeculatorDeps;
  brainCalls: string[];
  brainFinalized: () => boolean;
} {
  const brainCalls: string[] = [];
  let finalized = false;
  const tokens = overrides.tokens ?? ["Hello ", "there."];
  const d: SpeculatorDeps = {
    stt: overrides.stt ?? { transcribe: async () => overrides.transcript ?? "what time is it in tokyo" },
    brain: overrides.brain ?? {
      sendStream: (message: string) => {
        brainCalls.push(message);
        return (async function* () {
          try {
            for (const t of tokens) yield t;
          } finally {
            finalized = true;
          }
        })();
      },
    },
    isLocalFastPath: overrides.isLocalFastPath ?? isLocalFastPath,
    minProbability: overrides.minProbability ?? 0.85,
    claimTimeoutMs: overrides.claimTimeoutMs ?? 5000,
    operationalContext: overrides.operationalContext,
  };
  return { deps: d, brainCalls, brainFinalized: () => finalized };
}

async function drain(src: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const t of src) out += t;
  return out;
}

test("declines below the probability gate, on a truncated tail, and behind a pending confirmation", () => {
  const { deps: d } = deps();
  const spec = makeSpeculator(d);
  // confident enough, full coverage — baseline sanity that the gates are what decline
  expect(spec(pcm(2000), 16000, 2000, 0.9)).not.toBeNull();
  // low probability
  expect(spec(pcm(2000), 16000, 2000, 0.7)).toBeNull();
  // tail (2s) doesn't cover the utterance (9s) — probe window truncated it
  expect(spec(pcm(2000), 16000, 9000, 0.95)).toBeNull();
  // a spoken confirmation gate is armed — nothing speculative may reach the brain
  const gated = deps({ brain: { sendStream: async function* () { yield "x"; }, hasPendingConfirmation: () => true } });
  expect(makeSpeculator(gated.deps)(pcm(2000), 16000, 2000, 0.95)).toBeNull();
});

test("happy path: transcribes the tail, starts the brain, and hands over buffered tokens", async () => {
  const { deps: d, brainCalls } = deps({ transcript: "what's on the board today", tokens: ["Three ", "cards."] });
  const turn = makeSpeculator(d)(pcm(1500), 16000, 1500, 0.92)!;
  expect(turn.claim()).toBe(true);
  // final WAV a touch longer (confirm round trip) — still the same utterance
  expect(turn.coverageOk(1500 + 300)).toBe(true);
  expect(await turn.transcript()).toBe("what's on the board today");
  expect(brainCalls).toEqual(["what's on the board today"]);
  const tokens = turn.tokens();
  expect(tokens).not.toBeNull();
  expect(await drain(tokens!)).toBe("Three cards.");
});

test("speculation captures one immutable snapshot and attaches it to its brain stream", async () => {
  let captures = 0;
  const seen: Array<string | undefined> = [];
  const d = deps({
    transcript: "where is my brief",
    operationalContext: async () => `spec-state-${++captures}`,
    brain: {
      sendStream: (_message, options) => {
        seen.push(options?.systemContext);
        return (async function* () { yield "Delivered."; })();
      },
    },
  }).deps;
  const turn = makeSpeculator(d)(pcm(800), 16_000, 800, 0.95)!;
  expect(turn.claim()).toBe(true);
  await turn.transcript();
  expect(await drain(turn.tokens()!)).toBe("Delivered.");
  expect(captures).toBe(1);
  expect(seen).toEqual(["spec-state-1"]);
});

test("a hung speculative snapshot is bounded and does not block the brain turn", async () => {
  const seen: Array<string | undefined> = [];
  const d = deps({
    transcript: "where is my brief",
    // Never resolves: without the bounded capture helper the speculative turn
    // would await this forever and wedge the serial turn drain. The deadline must
    // abandon it and start the brain with no operational context.
    operationalContext: () => new Promise<string>(() => {}),
    brain: {
      sendStream: (_message, options) => {
        seen.push(options?.systemContext);
        return (async function* () { yield "Delivered."; })();
      },
    },
    claimTimeoutMs: 60_000,
  }).deps;
  const turn = makeSpeculator(d)(pcm(800), 16_000, 800, 0.95)!;
  expect(turn.claim()).toBe(true);
  await turn.transcript();
  expect(await drain(turn.tokens()!)).toBe("Delivered.");
  expect(seen).toEqual([undefined]);
});

test("abort after speculative snapshot capture prevents a late brain invocation", async () => {
  let brainCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const d = deps({
    transcript: "slow snapshot",
    operationalContext: async () => { await gate; return "doomed-state"; },
    brain: { sendStream: async function* () { brainCalls++; yield "late"; } },
    claimTimeoutMs: 60_000,
  }).deps;
  const turn = makeSpeculator(d)(pcm(800), 16_000, 800, 0.95)!;
  await Bun.sleep(5);
  const aborted = turn.abort();
  release();
  await aborted;
  expect(brainCalls).toBe(0);
  expect(turn.claim()).toBe(false);
});

test("a synchronous speculative brain failure closes the adopted token stream", async () => {
  const turn = makeSpeculator(deps({
    transcript: "start the agent",
    brain: {
      sendStream: () => { throw new Error("brain stream construction failed"); },
    },
    claimTimeoutMs: 60_000,
  }).deps)(pcm(800), 16_000, 800, 0.95)!;

  expect(turn.claim()).toBe(true);
  expect(await turn.transcript()).toBe("start the agent");
  const tokenStream = turn.tokens();
  expect(tokenStream).not.toBeNull();
  await expect(drain(tokenStream!)).rejects.toThrow("brain stream construction failed");
  await expect(turn.closed).resolves.toBeUndefined();
});

test("coverage gate rejects a final WAV that grew past the slack — the user kept talking", () => {
  const { deps: d } = deps();
  const turn = makeSpeculator(d)(pcm(1500), 16000, 1500, 0.92)!;
  expect(turn.coverageOk(1500 + 2500)).toBe(false);
});

test("local fast-path utterances never start a brain turn", async () => {
  const { deps: d, brainCalls } = deps({ transcript: "louder" });
  const turn = makeSpeculator(d)(pcm(800), 16000, 800, 0.95)!;
  expect(turn.claim()).toBe(true);
  expect(await turn.transcript()).toBe("louder");
  expect(turn.tokens()).toBeNull();
  expect(brainCalls).toEqual([]);
});

test("dry or failed STT resolves a null transcript and starts nothing", async () => {
  const dry = deps({ transcript: "" });
  const dryTurn = makeSpeculator(dry.deps)(pcm(800), 16000, 800, 0.95)!;
  expect(await dryTurn.transcript()).toBeNull();
  expect(dry.brainCalls).toEqual([]);

  const failing = deps({ stt: { transcribe: async () => { throw new Error("stt server down"); } } });
  const failTurn = makeSpeculator(failing.deps)(pcm(800), 16000, 800, 0.95)!;
  expect(await failTurn.transcript()).toBeNull();
  expect(failing.brainCalls).toEqual([]);
});

/** A brain that streams steadily until finalized — lets tests observe that the
 * pump's fire-and-forget return() actually reaches the generator's finally. */
function chattyBrain() {
  const state = { finalized: false };
  const brain = {
    sendStream: () =>
      (async function* () {
        try {
          while (true) { yield "tok "; await Bun.sleep(5); }
        } finally {
          state.finalized = true;
        }
      })(),
  };
  return { brain, state };
}

test("abort cancels an in-flight brain turn through generator finalization", async () => {
  const { brain, state } = chattyBrain();
  const slow = deps({ transcript: "tell me everything", brain });
  const turn = makeSpeculator(slow.deps)(pcm(800), 16000, 800, 0.95)!;
  await turn.transcript(); // brain is now pumping
  await turn.abort();
  await Bun.sleep(50); // return() lands once the generator's pending await resolves
  expect(state.finalized).toBe(true);
  expect(turn.claim()).toBe(false); // aborted turns can't be adopted
});

test("abort signals a speculative brain even while its first token is silent", async () => {
  const state = { receivedSignal: false, cancelled: false };
  const brain = {
    sendStream: (_message: string, options?: { signal?: AbortSignal }) =>
      (async function* () {
        await new Promise<void>((resolve) => {
          const signal = options?.signal;
          state.receivedSignal = signal !== undefined;
          if (signal?.aborted) { state.cancelled = true; resolve(); return; }
          signal?.addEventListener("abort", () => { state.cancelled = true; resolve(); }, { once: true });
        });
      })(),
  };
  const turn = makeSpeculator(deps({ transcript: "do the slow thing", brain }).deps)(pcm(800), 16000, 800, 0.95)!;
  await turn.transcript();
  await turn.abort();
  expect(state.receivedSignal).toBe(true);
  expect(state.cancelled).toBe(true);
});

test("abort drains speculative STT and the losing tone classifier before resolving", async () => {
  const sttStarted = deferred();
  const releaseStt = deferred();
  const toneStarted = deferred();
  const releaseTone = deferred();
  let sttFinished = false;
  let toneFinished = false;
  let brainCalls = 0;
  const turn = makeSpeculator({
    stt: {
      transcribe: async () => {
        try {
          sttStarted.resolve();
          await releaseStt.promise;
          sttFinished = true;
          return "hello";
        } catch (error) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      },
    },
    brain: { sendStream: async function* () { brainCalls += 1; yield "late"; } },
    isLocalFastPath: () => false,
    minProbability: 0.5,
    claimTimeoutMs: 60_000,
    tone: {
      tag: async () => {
        try {
          toneStarted.resolve();
          await releaseTone.promise;
          toneFinished = true;
          return null;
        } catch (error) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      },
    },
  })(pcm(800), 16_000, 800, 0.99)!;
  await Promise.all([sttStarted.promise, toneStarted.promise]);

  let settled = false;
  const aborting = turn.abort().then(() => { settled = true; });
  await Bun.sleep(0);
  expect(settled).toBe(false);
  releaseStt.resolve();
  await Bun.sleep(10);
  expect(sttFinished).toBe(true);
  expect(toneFinished).toBe(false);
  expect(settled).toBe(false);

  releaseTone.resolve();
  await aborting;
  expect(toneFinished).toBe(true);
  expect(brainCalls).toBe(0);
});

test("abort waits for the speculative brain generator's async finalizer", async () => {
  const finalizerStarted = deferred();
  const releaseFinalizer = deferred();
  const brain = {
    sendStream: (_message: string, options?: { signal?: AbortSignal }) =>
      (async function* () {
        try {
          yield "buffered";
          await new Promise<void>((resolve) => {
            const signal = options?.signal;
            if (signal?.aborted) { resolve(); return; }
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally {
          finalizerStarted.resolve();
          await releaseFinalizer.promise;
        }
      })(),
  };
  const turn = makeSpeculator(deps({ transcript: "finish cleanly", brain }).deps)(pcm(800), 16_000, 800, 0.95)!;
  await turn.transcript();
  await Bun.sleep(0);

  let settled = false;
  const aborting = turn.abort().then(() => { settled = true; });
  await finalizerStarted.promise;
  expect(settled).toBe(false);
  releaseFinalizer.resolve();
  await aborting;
  expect(settled).toBe(true);
});

test("speculative token buffers accept the exact item cap", async () => {
  try {
    const turn = makeSpeculator(deps({
      transcript: "exact items",
      tokens: Array.from({ length: MAX_SPECULATIVE_TOKEN_ITEMS }, () => "x"),
      claimTimeoutMs: 60_000,
    }).deps)(pcm(800), 16_000, 800, 0.95)!;
    await turn.transcript();
    await Bun.sleep(50);
    expect(turn.claim()).toBe(true);
    expect((await drain(turn.tokens()!)).length).toBe(MAX_SPECULATIVE_TOKEN_ITEMS);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
});

test("speculative token buffers accept the exact UTF-8 byte cap", async () => {
  try {
    const turn = makeSpeculator(deps({
      transcript: "exact bytes",
      tokens: ["x".repeat(MAX_SPECULATIVE_TOKEN_BYTES)],
      claimTimeoutMs: 60_000,
    }).deps)(pcm(800), 16_000, 800, 0.95)!;
    await turn.transcript();
    await Bun.sleep(20);
    expect(turn.claim()).toBe(true);
    expect(Buffer.byteLength(await drain(turn.tokens()!))).toBe(MAX_SPECULATIVE_TOKEN_BYTES);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
});

test("speculative token buffers fail closed above the exact item cap", async () => {
  const turn = makeSpeculator(deps({
    transcript: "overflow items",
    tokens: Array.from({ length: MAX_SPECULATIVE_TOKEN_ITEMS + 1 }, () => "x"),
    claimTimeoutMs: 60_000,
  }).deps)(pcm(800), 16_000, 800, 0.95)!;
  await turn.transcript();
  await Bun.sleep(50);
  expect(turn.claim()).toBe(false);
  await turn.abort();
});

test("speculative token buffers fail closed above the exact UTF-8 byte cap", async () => {
  const turn = makeSpeculator(deps({
    transcript: "overflow bytes",
    tokens: ["x".repeat(MAX_SPECULATIVE_TOKEN_BYTES), "y"],
    claimTimeoutMs: 60_000,
  }).deps)(pcm(800), 16_000, 800, 0.95)!;
  await turn.transcript();
  await Bun.sleep(20);
  expect(turn.claim()).toBe(false);
  await turn.abort();
});

test("an unclaimed speculation self-aborts after the timeout", async () => {
  const { brain, state } = chattyBrain();
  const { deps: d } = deps({ transcript: "hello", claimTimeoutMs: 50, brain });
  const turn = makeSpeculator(d)(pcm(800), 16000, 800, 0.95)!;
  await turn.transcript();
  await turn.closed;
  expect(turn.claim()).toBe(false);
  expect(state.finalized).toBe(true);
});

test("a consumer that stops early tears the pump (and agent turn) down", async () => {
  const { brain, state } = chattyBrain();
  const d = deps({ transcript: "long answer please", brain }).deps;
  const turn = makeSpeculator(d)(pcm(800), 16000, 800, 0.95)!;
  expect(turn.claim()).toBe(true);
  await turn.transcript();
  const tokens = turn.tokens()!;
  for await (const t of tokens) { void t; break; } // barge-in: consumer bails after one token
  await Bun.sleep(400); // pump poll granularity
  expect(state.finalized).toBe(true);
});

test("pcmToWav output round-trips through wavDurationMs", () => {
  const wav = pcmToWav(pcm(1000), 16000);
  const buf = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
  const ms = wavDurationMs(buf);
  expect(ms).not.toBeNull();
  expect(Math.abs(ms! - 1000)).toBeLessThan(2);
});

test("isLocalFastPath covers the no-brain utterances and nothing else", () => {
  for (const t of ["louder", "Slower, please.", "repeat that", "details", "continue", "go on"]) {
    expect(isLocalFastPath(t)).toBe(true);
  }
  for (const t of ["what time is it", "pass me to remy", "how's the board looking"]) {
    expect(isLocalFastPath(t)).toBe(false);
  }
});

// --- streamWebTurn adoption (the integration seam) ---

import { streamWebTurn, type WebStreamDeps, type WebReplySink } from "../../src/web-voice/turn";
import type { SpeculativeTurn } from "../../src/web-voice/speculative";

function capturingSink() {
  const calls = { transcript: [] as string[], sentence: [] as string[], audio: 0, done: 0, error: [] as string[] };
  const sink: WebReplySink = {
    transcript: (t) => calls.transcript.push(t),
    sentence: (t) => calls.sentence.push(t),
    audio: () => { calls.audio++; },
    control: () => { /* unused */ },
    done: () => { calls.done++; },
    error: (m) => calls.error.push(m),
    aborted: () => false,
  };
  return { sink, calls };
}

function turnDeps(sttCalls: string[]): WebStreamDeps {
  return {
    stt: { transcribe: async () => { sttCalls.push("stt"); return "fallback transcript"; } },
    brain: { send: async () => "Fallback reply.", sendStream: async function* () { yield "Fallback reply."; } },
    tts: {
      generateAudio: async () => pcmToWav(new Float32Array([0]), 16_000).buffer as ArrayBuffer,
    },
  };
}

function fakeSpec(over: Partial<SpeculativeTurn> & { aborts?: string[] } = {}): SpeculativeTurn {
  const aborts = over.aborts ?? [];
  return {
    claim: over.claim ?? (() => true),
    coverageOk: over.coverageOk ?? (() => true),
    transcript: over.transcript ?? (async () => "speculated words"),
    tokens: over.tokens ?? (() => (async function* () { yield "Speculative reply."; })()),
    abort: over.abort ?? (async () => { aborts.push("abort"); }),
  };
}

function wavOf(ms: number): ArrayBuffer {
  const w = pcmToWav(pcm(ms), 16000);
  return w.buffer.slice(w.byteOffset, w.byteOffset + w.byteLength) as ArrayBuffer;
}

test("adoption: the speculative transcript and tokens are used, final STT is skipped", async () => {
  const sttCalls: string[] = [];
  const aborts: string[] = [];
  const { sink, calls } = capturingSink();
  await streamWebTurn(wavOf(1000), turnDeps(sttCalls), sink, fakeSpec({ aborts }));
  expect(sttCalls).toEqual([]); // no second transcription
  expect(aborts).toEqual(["abort"]);
  expect(calls.transcript).toEqual(["speculated words"]);
  expect(calls.sentence).toEqual(["Speculative reply."]);
  expect(calls.done).toBe(1);
});

test("adopted speculation never captures a second operational snapshot", async () => {
  const sttCalls: string[] = [];
  let captures = 0;
  const deps = turnDeps(sttCalls);
  deps.operationalContext = async () => { captures++; return "new-state"; };
  const { sink } = capturingSink();
  await streamWebTurn(wavOf(1000), deps, sink, fakeSpec());
  expect(captures).toBe(0);
});

test("coverage mismatch: speculation aborts and the normal pipeline runs", async () => {
  const sttCalls: string[] = [];
  const aborts: string[] = [];
  const { sink, calls } = capturingSink();
  await streamWebTurn(wavOf(4000), turnDeps(sttCalls), sink, fakeSpec({ coverageOk: () => false, aborts }));
  expect(aborts).toEqual(["abort"]);
  expect(sttCalls).toEqual(["stt"]);
  expect(calls.transcript).toEqual(["fallback transcript"]);
  expect(calls.sentence).toEqual(["Fallback reply."]);
});

test("an already-aborted speculation (claim false) falls straight through", async () => {
  const sttCalls: string[] = [];
  const aborts: string[] = [];
  const { sink, calls } = capturingSink();
  await streamWebTurn(wavOf(1000), turnDeps(sttCalls), sink, fakeSpec({ claim: () => false, aborts }));
  expect(aborts).toEqual([]); // nothing left to abort
  expect(sttCalls).toEqual(["stt"]);
  expect(calls.transcript).toEqual(["fallback transcript"]);
});

test("dry speculative transcript aborts and falls back", async () => {
  const sttCalls: string[] = [];
  const aborts: string[] = [];
  const { sink, calls } = capturingSink();
  await streamWebTurn(wavOf(1000), turnDeps(sttCalls), sink, fakeSpec({ transcript: async () => null, aborts }));
  expect(aborts).toEqual(["abort"]);
  expect(calls.transcript).toEqual(["fallback transcript"]);
});
