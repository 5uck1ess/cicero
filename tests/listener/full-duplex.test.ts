import { test, expect } from "bun:test";
import { ConversationalListener } from "../../src/listener/conversational";

// Exercises the full-duplex turn loop's control flow without real audio: the
// barge-in detector and STT are stubbed, so we assert the *decisions* — when
// Cicero interrupts itself (never), when it yields (genuine speech), and when a
// bare "stop" halts playback without dispatching a turn. The acoustic behavior
// (does the VAD open on speaker bleed?) is verified on a real mic separately.

type Stub = ConversationalListener & {
  active: boolean;
  activationEpoch: number;
  detectingBargeIn: boolean;
  detectBargeIn: () => Promise<string | null>;
  runFullDuplexTurn: (cb: Promise<void>, epoch?: number) => Promise<void>;
  runLegacyBargeInTurn: (cb: Promise<void>, epoch?: number) => Promise<void>;
};

function makeListener(transcript: string, speaking: string) {
  const stt = { transcribe: async () => transcript } as never;
  const recorder = {} as never;
  const player = { play: async () => {} } as never;
  // ctor: (stt, recorder, player, bargeIn, silenceDur, silenceThr, turn, vad, earcons, fullDuplex)
  const l = new ConversationalListener(stt, recorder, player, false, "1.0", "3%", undefined, undefined, false, true) as Stub;
  l.setSpeakingTextProvider(() => speaking);
  l.active = true;
  return l;
}

const SPOKEN = "the roman republic was founded in 509 BC after the overthrow of the monarchy";

test("genuine user speech interrupts TTS and is dispatched as a new turn", async () => {
  const l = makeListener("actually tell me about the empire instead", SPOKEN);
  let interrupted = false;
  let received: string | null = null;
  l.onBargeIn(() => { interrupted = true; });
  l.onCommand((t) => { received = t; });
  l.detectBargeIn = async () => "/tmp/cicero-test-barge.wav"; // never written; unlink is best-effort

  await l.runFullDuplexTurn(new Promise<void>(() => {})); // TTS "still playing"

  expect(interrupted).toBe(true);
  expect(received).toBe("actually tell me about the empire instead");
});

test("self-echo (mic re-captures our own TTS) does NOT interrupt — keep speaking", async () => {
  const l = makeListener(SPOKEN, SPOKEN); // transcript == what Cicero is saying
  let interrupted = false;
  let received: string | null = null;
  l.onBargeIn(() => { interrupted = true; });
  l.onCommand((t) => { received = t; });

  let detectCalls = 0;
  let resolveDone!: () => void;
  const callbackPromise = new Promise<void>((res) => { resolveDone = res; });
  l.detectBargeIn = async () => {
    detectCalls++;
    if (detectCalls === 1) return "/tmp/cicero-test-echo.wav"; // echo → ignored, re-arm
    resolveDone();                                             // reply finishes
    return null;                                               // nothing more captured
  };

  await l.runFullDuplexTurn(callbackPromise);

  expect(interrupted).toBe(false);
  expect(received).toBeNull();
  expect(detectCalls).toBeGreaterThanOrEqual(2); // the echo forced a re-arm
});

test("a bare 'stop' halts playback without dispatching a turn", async () => {
  const l = makeListener("stop", SPOKEN);
  let interrupted = false;
  let stopped = false;
  let received: string | null = null;
  l.onBargeIn(() => { interrupted = true; });
  l.onStopCommand(() => { stopped = true; });
  l.onCommand((t) => { received = t; });
  l.detectBargeIn = async () => "/tmp/cicero-test-stop.wav";

  await l.runFullDuplexTurn(new Promise<void>(() => {}));

  expect(interrupted).toBe(true);
  expect(stopped).toBe(true);
  expect(received).toBeNull();
});

test("when the reply finishes before any speech, nothing is interrupted", async () => {
  const l = makeListener("", SPOKEN);
  let interrupted = false;
  l.onBargeIn(() => { interrupted = true; });
  let resolveDone!: () => void;
  const callbackPromise = new Promise<void>((res) => { resolveDone = res; });
  l.detectBargeIn = async () => { resolveDone(); return null; }; // TTS done, no barge-in

  await l.runFullDuplexTurn(callbackPromise);

  expect(interrupted).toBe(false);
});

test("a capped detector re-arms so speech can interrupt a still-thinking turn", async () => {
  const l = makeListener("new instruction", ""); // no TTS yet: callback is thinking
  let interrupted = false;
  let received: string | null = null;
  l.onBargeIn(() => { interrupted = true; });
  l.onCommand((t) => { received = t; });

  let calls = 0;
  l.detectBargeIn = async () => {
    calls++;
    return calls === 1 ? null : "/tmp/cicero-thinking-interrupt.wav";
  };

  await l.runFullDuplexTurn(new Promise<void>(() => {}));

  expect(calls).toBe(2);
  expect(interrupted).toBe(true);
  expect(received).toBe("new instruction");
});

test("the interrupting utterance's own reply remains interruptible", async () => {
  const l = makeListener("new instruction", "");
  let interrupts = 0;
  let dispatched = 0;
  l.onBargeIn(() => { interrupts++; });
  l.onCommand(() => {
    dispatched++;
    if (dispatched === 1) return new Promise<void>(() => {});
    return Promise.resolve();
  });

  let calls = 0;
  l.detectBargeIn = () => {
    calls++;
    if (calls <= 2) return Promise.resolve(`/tmp/cicero-replacement-barge-${calls}.wav`);
    return new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 0));
  };

  await l.runFullDuplexTurn(new Promise<void>(() => {}));

  expect(interrupts).toBe(2);
  expect(dispatched).toBe(2);
  expect(calls).toBe(2);
});

test("legacy barge-in also re-arms after its finite recorder cap", async () => {
  const l = makeListener("stop", SPOKEN);
  let interrupted = 0;
  let calls = 0;
  l.onBargeIn(() => { interrupted++; });
  l.detectBargeIn = async () => {
    calls++;
    return calls === 1 ? null : "/tmp/cicero-legacy-rearm.wav";
  };

  await l.runLegacyBargeInTurn(new Promise<void>(() => {}));

  expect(calls).toBe(2);
  expect(interrupted).toBe(1);
});

test("an old full-duplex loop cannot steal a reactivated epoch", async () => {
  const l = makeListener("new command", "");
  l.activationEpoch = 1;
  let resolveDetect!: (path: string | null) => void;
  const pending = new Promise<string | null>((resolve) => { resolveDetect = resolve; });
  let detectCalls = 0;
  let interrupted = 0;
  let received: string | null = null;
  l.detectBargeIn = () => { detectCalls++; return pending; };
  l.onBargeIn(() => { interrupted++; });
  l.onCommand((text) => { received = text; });
  const oldTurn = l.runFullDuplexTurn(new Promise<void>(() => {}), 1);
  await Bun.sleep(0);

  // Simulate a fast deactivate → reactivate while the old detector unwinds.
  l.active = false;
  l.activationEpoch = 2;
  l.detectingBargeIn = false;
  l.active = true;
  l.activationEpoch = 3;
  l.detectingBargeIn = true; // a new epoch now owns the interruption window
  const stalePath = `/tmp/cicero-stale-barge-${process.pid}.wav`;
  await Bun.write(stalePath, new Uint8Array([1, 2, 3]));
  resolveDetect(stalePath);
  await oldTurn;

  expect(detectCalls).toBe(1); // the old loop did not re-arm in epoch 3
  expect(interrupted).toBe(0);
  expect(received).toBeNull();
  expect(l.active).toBe(true);
  expect(l.detectingBargeIn).toBe(true); // old finally did not clear the new owner
  expect(await Bun.file(stalePath).exists()).toBe(false);
});

test("an old legacy barge loop drops stale audio instead of dispatching it", async () => {
  const l = makeListener("new command", "");
  l.activationEpoch = 4;
  let resolveDetect!: (path: string | null) => void;
  const pending = new Promise<string | null>((resolve) => { resolveDetect = resolve; });
  let detectCalls = 0;
  let interrupted = 0;
  l.detectBargeIn = () => { detectCalls++; return pending; };
  l.onBargeIn(() => { interrupted++; });
  const oldTurn = l.runLegacyBargeInTurn(new Promise<void>(() => {}), 4);
  await Bun.sleep(0);

  l.activationEpoch = 5;
  const stalePath = `/tmp/cicero-stale-legacy-barge-${process.pid}.wav`;
  await Bun.write(stalePath, new Uint8Array([1, 2, 3]));
  resolveDetect(stalePath);
  await oldTurn;

  expect(detectCalls).toBe(1);
  expect(interrupted).toBe(0);
  expect(l.active).toBe(true);
  expect(await Bun.file(stalePath).exists()).toBe(false);
});
