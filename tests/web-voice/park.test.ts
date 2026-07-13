import { test, expect } from "bun:test";
import { streamWebTextTurn, DEFAULT_PARK_LINE, type WebStreamDeps, type WebReplySink, type LongTurnOptions } from "../../src/web-voice/turn";
import { encodeWav } from "../../src/platform/wav";

const tinyWav = () => encodeWav(new Int16Array([1])).buffer as ArrayBuffer;

function capturingSink(abortWhen?: () => boolean) {
  const calls = { transcript: [] as string[], sentence: [] as string[], audio: 0, done: 0, error: [] as string[] };
  const sink: WebReplySink = {
    transcript: (t) => calls.transcript.push(t),
    sentence: (t) => calls.sentence.push(t),
    audio: () => { calls.audio++; },
    control: () => { /* unused */ },
    done: () => { calls.done++; },
    error: (m) => calls.error.push(m),
    aborted: () => abortWhen?.() ?? false,
  };
  return { sink, calls };
}

/** A brain that stays silent for `silentMs`, then streams `sentences`. */
function slowBrain(silentMs: number, sentences: string[]) {
  return {
    send: async () => sentences.join(" "),
    sendStream: async function* () {
      await Bun.sleep(silentMs);
      for (const s of sentences) { yield s + " "; await Bun.sleep(5); }
    },
  };
}

function parkDeps(brain: WebStreamDeps["brain"], park: LongTurnOptions): WebStreamDeps {
  return {
    stt: { transcribe: async () => "unused" },
    brain,
    tts: { generateAudio: async () => tinyWav() },
    park,
  };
}

function parkCollector(afterMs: number, maxBackgroundMs?: number) {
  const delivered: Array<{ reply: string; transcript: string }> = [];
  let resolveDelivered!: () => void;
  const wait = new Promise<void>((r) => { resolveDelivered = r; });
  const park: LongTurnOptions = {
    afterMs,
    maxBackgroundMs,
    onParked: (reply, transcript) => { delivered.push({ reply, transcript }); resolveDelivered(); },
  };
  return { park, delivered, wait };
}

test("a silent brain parks: hand-back line spoken, turn closed, reply delivered later", async () => {
  const { park, delivered, wait } = parkCollector(80);
  const { sink, calls } = capturingSink();
  await streamWebTextTurn("audit the notify module", parkDeps(slowBrain(300, ["Done.", "Two issues found."]), park), sink);
  // the turn returned at park time: hand-back spoken, done sent, nothing else
  expect(calls.sentence).toEqual([DEFAULT_PARK_LINE]);
  expect(calls.done).toBe(1);
  expect(delivered).toEqual([]); // brain still working
  await wait;
  expect(delivered).toEqual([{ reply: "Done. Two issues found.", transcript: "audit the notify module" }]);
  // the detached finish never wrote to the closed sink
  expect(calls.sentence).toEqual([DEFAULT_PARK_LINE]);
  expect(calls.done).toBe(1);
});

test("a reply that speaks in time never parks", async () => {
  const { park, delivered } = parkCollector(500);
  const { sink, calls } = capturingSink();
  await streamWebTextTurn("quick one", parkDeps(slowBrain(10, ["Fast answer."]), park), sink);
  expect(calls.sentence).toEqual(["Fast answer."]);
  expect(calls.done).toBe(1);
  await Bun.sleep(600); // past the watchdog — it was disarmed by completion
  expect(delivered).toEqual([]);
});

test("a parked turn survives sink aborts — the floor belongs to new turns now", async () => {
  const { park, delivered, wait } = parkCollector(80);
  let abortedFlag = false;
  const { sink, calls } = capturingSink(() => abortedFlag);
  await streamWebTextTurn("long job", parkDeps(slowBrain(300, ["Survived."]), park), sink);
  expect(calls.done).toBe(1); // parked
  abortedFlag = true; // user starts a new turn while the parked brain works
  await wait;
  expect(delivered[0]!.reply).toBe("Survived.");
});

test("barge-in BEFORE the watchdog cancels normally — no park, no delivery", async () => {
  const { park, delivered } = parkCollector(400);
  let abortedFlag = false;
  const { sink, calls } = capturingSink(() => abortedFlag);
  setTimeout(() => { abortedFlag = true; }, 50);
  await streamWebTextTurn("never mind", parkDeps(slowBrain(10_000, ["Too late."]), park), sink);
  await Bun.sleep(600);
  expect(delivered).toEqual([]);
  expect(calls.sentence).toEqual([]); // no hand-back line: the user cut the turn, nothing to park
});

test("the background cap delivers whatever was collected", async () => {
  const { park, delivered, wait } = parkCollector(60, 250);
  const { sink } = capturingSink();
  const brain = {
    send: async () => "",
    sendStream: async function* () {
      await Bun.sleep(120); // parks at 60ms
      yield "Partial progress. ";
      await Bun.sleep(60_000); // never finishes — cap (250ms) reaps it
    },
  };
  await streamWebTextTurn("endless job", parkDeps(brain, park), sink);
  await wait;
  expect(delivered[0]!.reply).toBe("Partial progress.");
});

test("transport cancellation reaps a parked brain and suppresses its late delivery", async () => {
  const controller = new AbortController();
  const { park, delivered } = parkCollector(30, 60_000);
  const tracked: Promise<void>[] = [];
  const deps = parkDeps(slowBrain(60_000, ["Too late."]), park);
  deps.signal = controller.signal;
  deps.trackBackground = (task) => { tracked.push(task); return true; };
  const { sink, calls } = capturingSink();

  await streamWebTextTurn("long shutdown-sensitive job", deps, sink);
  expect(calls.sentence).toEqual([DEFAULT_PARK_LINE]);
  expect(tracked.length).toBeGreaterThan(0);

  controller.abort(new Error("server shutting down"));
  await Promise.race([
    Promise.all(tracked),
    Bun.sleep(1_000).then(() => { throw new Error("parked task did not observe transport cancellation"); }),
  ]);
  expect(delivered).toEqual([]);
});

test("the tracked parked task includes asynchronous delivery completion", async () => {
  let releaseDelivery!: () => void;
  const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
  let deliveryStarted!: () => void;
  const started = new Promise<void>((resolve) => { deliveryStarted = resolve; });
  let deliveryFinished = false;
  const tracked: Promise<void>[] = [];
  const park: LongTurnOptions = {
    afterMs: 5,
    onParked: async () => {
      try {
        deliveryStarted();
        await deliveryGate;
        deliveryFinished = true;
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
  };
  const deps = parkDeps(slowBrain(30, ["Completed reply."]), park);
  deps.trackBackground = (task) => { tracked.push(task); return true; };
  const { sink } = capturingSink();

  await streamWebTextTurn("keep delivery owned", deps, sink);
  expect(tracked.length).toBeGreaterThan(0);
  await started;
  let settled = false;
  const owned = Promise.all(tracked).then(() => { settled = true; });
  await Bun.sleep(0);
  expect(settled).toBe(false);
  expect(deliveryFinished).toBe(false);

  releaseDelivery();
  await owned;
  expect(deliveryFinished).toBe(true);
});

test("a saturated background owner keeps parked work foreground-owned", async () => {
  const { park, delivered } = parkCollector(20);
  const deps = parkDeps(slowBrain(150, ["Finished under the foreground cap."]), park);
  deps.trackBackground = () => false;
  const { sink } = capturingSink();
  let settled = false;
  const turn = streamWebTextTurn("bounded park", deps, sink).then(() => { settled = true; });

  await Bun.sleep(60);
  expect(settled).toBe(false);
  await turn;
  expect(delivered[0]?.reply).toBe("Finished under the foreground cap.");
});
