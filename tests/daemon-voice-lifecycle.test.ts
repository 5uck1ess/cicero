import { test, expect } from "bun:test";
import { CiceroDaemon } from "../src/daemon";
import type { RouterResult } from "../src/types";

type DaemonHarness = CiceroDaemon & {
  conversational: {
    isActive(): boolean;
    activate(): void;
    deactivate(): void;
    stop(): Promise<void>;
    waitForCaptureRelease(): Promise<void>;
    releaseAudioCapture(): Promise<void>;
    noteSpoken?(text: string): void;
  } | null;
  aecHub: {
    isRunning(): boolean;
    start(): Promise<void>;
    stop(): void | Promise<void>;
  } | null;
  clapListener: { start(): void | Promise<void>; stop(): void | Promise<void> } | null;
  running: boolean;
  lifecycle: "idle" | "starting" | "running" | "stopping";
  stopRequested: boolean;
  voiceDesiredActive: boolean;
  voiceTransition: Promise<void>;
  voiceInputHandoff: Promise<void>;
  setVoiceMode(active: boolean): Promise<void>;
  handleVoiceDeactivated(): void;
  stopAfterStartup(starting: Promise<void> | null): Promise<void>;
  activeLocalTurn: AbortController | null;
  streamingSpeaker: {
    getSnapshot(): { spoken: string[]; pending: string[] };
    interrupt(): void;
  } | null;
  pendingRecovery: { spoken: string[] } | null;
  handleLocalBargeIn(): void;
  contextStore: { addTurn(turn: unknown): void };
  finalizeStreamingTurn(text: string, result: RouterResult, signal: AbortSignal): boolean;
};

test("deactivation requested during AEC startup prevents stale activation", async () => {
  const daemon = new CiceroDaemon({} as never) as DaemonHarness;
  let active = false;
  let activations = 0;
  let rejectStart: ((err: Error) => void) | null = null;
  let helperRunning = false;
  let helperStops = 0;
  let clapStarts = 0;

  daemon.conversational = {
    isActive: () => active,
    activate: () => { active = true; activations++; },
    deactivate: () => { active = false; },
    stop: () => Promise.resolve(),
    waitForCaptureRelease: () => Promise.resolve(),
    releaseAudioCapture: () => Promise.resolve(),
  };
  daemon.aecHub = {
    isRunning: () => helperRunning,
    start: () => new Promise<void>((_resolve, reject) => { rejectStart = reject; }),
    stop: () => {
      helperRunning = false;
      helperStops++;
      rejectStart?.(new Error("cancelled"));
      rejectStart = null;
    },
  };
  daemon.clapListener = { start: () => { clapStarts++; }, stop: () => {} };
  daemon.running = true;

  const activating = daemon.setVoiceMode(true);
  await Bun.sleep(0); // transition is now awaiting the helper's first frame
  const deactivating = daemon.setVoiceMode(false);
  await Promise.all([activating, deactivating]);

  expect(active).toBe(false);
  expect(activations).toBe(0);
  expect(helperStops).toBeGreaterThanOrEqual(1);
  expect(clapStarts).toBe(1);
});

test("voice deactivation always stops AEC even when clap is disabled", () => {
  const daemon = new CiceroDaemon({} as never) as DaemonHarness;
  let stops = 0;
  daemon.aecHub = { isRunning: () => true, start: async () => {}, stop: () => { stops++; } };
  daemon.clapListener = null;
  daemon.running = true;
  daemon.voiceDesiredActive = true;

  daemon.handleVoiceDeactivated();

  expect(stops).toBe(1);
  expect(daemon.voiceDesiredActive).toBe(false);
});

test("voice deactivation waits for conversational and AEC release before restarting clap", async () => {
  const daemon = new CiceroDaemon({} as never) as DaemonHarness;
  let releaseAec!: () => void;
  const stopped = new Promise<void>((resolve) => { releaseAec = resolve; });
  let releaseCapture!: () => void;
  const captureReleased = new Promise<void>((resolve) => { releaseCapture = resolve; });
  let clapStarts = 0;
  daemon.conversational = {
    isActive: () => false,
    activate: () => {},
    deactivate: () => {},
    stop: () => Promise.resolve(),
    waitForCaptureRelease: () => captureReleased,
    releaseAudioCapture: () => captureReleased,
  };
  daemon.aecHub = { isRunning: () => true, start: async () => {}, stop: () => stopped };
  daemon.clapListener = { start: () => { clapStarts++; }, stop: () => {} };
  daemon.running = true;
  daemon.voiceDesiredActive = true;

  daemon.handleVoiceDeactivated();
  await Bun.sleep(0);
  expect(clapStarts).toBe(0);
  releaseAec();
  await Bun.sleep(0);
  expect(clapStarts).toBe(0);
  releaseCapture();
  await Bun.sleep(0);
  expect(clapStarts).toBe(1);
});

test("voice activation stays off when AEC cleanup cannot confirm microphone release", async () => {
  const daemon = new CiceroDaemon({} as never) as DaemonHarness;
  let active = false;
  let activations = 0;
  let clapStarts = 0;
  daemon.conversational = {
    isActive: () => active,
    activate: () => { active = true; activations++; },
    deactivate: () => { active = false; },
    stop: () => Promise.resolve(),
    waitForCaptureRelease: () => Promise.resolve(),
    releaseAudioCapture: () => Promise.resolve(),
  };
  daemon.aecHub = {
    isRunning: () => false,
    start: () => Promise.reject(new Error("unreaped AEC child")),
    stop: () => Promise.reject(new Error("unreaped AEC child")),
  };
  daemon.clapListener = { start: () => { clapStarts++; }, stop: () => {} };
  daemon.running = true;

  await daemon.setVoiceMode(true);

  expect(active).toBe(false);
  expect(activations).toBe(0);
  expect(clapStarts).toBe(0);
});

async function expectActivationRetriesFailedCaptureRelease(): Promise<void> {
  const daemon = new CiceroDaemon({} as never) as DaemonHarness;
  let active = false;
  let releaseCalls = 0;
  daemon.conversational = {
    isActive: () => active,
    activate: () => { active = true; },
    deactivate: () => { active = false; },
    stop: () => Promise.resolve(),
    waitForCaptureRelease: () => Promise.resolve(),
    releaseAudioCapture: () => (++releaseCalls === 1
      ? Promise.reject(new Error("first recorder reap failed"))
      : Promise.resolve()),
  };
  daemon.aecHub = {
    isRunning: () => false,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
  daemon.clapListener = { start: () => {}, stop: () => {} };
  daemon.running = true;
  daemon.voiceDesiredActive = true;

  try {
    daemon.handleVoiceDeactivated();
    await daemon.voiceInputHandoff.catch(() => {});
    expect(active).toBe(false);

    await daemon.setVoiceMode(true);

    expect(releaseCalls).toBe(2);
    expect(active).toBe(true);
  } catch (error: unknown) {
    throw error;
  }
}

test("a fresh activation retries a previously failed conversational release", () => (
  expectActivationRetriesFailedCaptureRelease()
));

test("local barge-in cancels the brain turn before interrupting speech", () => {
  const daemon = new CiceroDaemon({} as never) as DaemonHarness;
  const controller = new AbortController();
  const order: string[] = [];
  controller.signal.addEventListener("abort", () => order.push("abort"), { once: true });
  daemon.activeLocalTurn = controller;
  daemon.streamingSpeaker = {
    getSnapshot: () => ({ spoken: ["I was explaining"], pending: ["the rest"] }),
    interrupt: () => { order.push("speaker"); },
  };

  daemon.handleLocalBargeIn();

  expect(controller.signal.aborted).toBe(true);
  expect(order).toEqual(["abort", "speaker"]);
  expect(daemon.pendingRecovery).toEqual({ spoken: ["I was explaining"] });
});

test("cancelled streaming turns are not persisted as completed context", () => {
  const daemon = new CiceroDaemon({} as never) as DaemonHarness;
  const noted: string[] = [];
  const stored: unknown[] = [];
  daemon.conversational = {
    isActive: () => true,
    activate: () => {},
    deactivate: () => {},
    stop: () => Promise.resolve(),
    waitForCaptureRelease: () => Promise.resolve(),
    releaseAudioCapture: () => Promise.resolve(),
    noteSpoken: (text) => { noted.push(text); },
  };
  daemon.streamingSpeaker = {
    getSnapshot: () => ({ spoken: ["stale partial reply"], pending: [] }),
    interrupt: () => {},
  };
  daemon.contextStore = { addTurn: (turn) => { stored.push(turn); } };
  const controller = new AbortController();
  controller.abort("superseded");

  const finalized = daemon.finalizeStreamingTurn(
    "old request",
    { intent: "chat", category: "brain", params: {} },
    controller.signal,
  );

  expect(finalized).toBe(false);
  expect(noted).toEqual([]);
  expect(stored).toEqual([]);
});

test("daemon stop synchronously revokes voice intent and cancels AEC startup", () => {
  const daemon = new CiceroDaemon({} as never) as DaemonHarness;
  let aecStops = 0;
  daemon.lifecycle = "running";
  daemon.running = true;
  daemon.voiceDesiredActive = true;
  daemon.aecHub = {
    isRunning: () => false,
    start: () => Promise.resolve(),
    stop: () => { aecStops++; },
  };
  daemon.stopAfterStartup = () => Promise.resolve();

  const stopping = daemon.stop();

  expect(daemon.voiceDesiredActive).toBe(false);
  expect(daemon.running).toBe(false);
  expect(daemon.stopRequested).toBe(true);
  expect(aecStops).toBe(1);
  return stopping;
});

async function expectIdleStopAwaitsRetainedAecRelease(): Promise<void> {
  const daemon = new CiceroDaemon({} as never) as DaemonHarness;
  let releaseAec!: () => void;
  const released = new Promise<void>((resolve) => { releaseAec = resolve; });
  let releaseClap!: () => void;
  const clapReleased = new Promise<void>((resolve) => { releaseClap = resolve; });
  let aecStops = 0;
  let clapStops = 0;
  daemon.voiceDesiredActive = true;
  daemon.aecHub = {
    isRunning: () => false,
    start: () => Promise.resolve(),
    stop: () => { aecStops++; return released; },
  };
  daemon.clapListener = {
    start: () => {},
    stop: () => { clapStops++; return clapReleased; },
  };
  let settled = false;

  try {
    const stopping = daemon.stop().finally(() => { settled = true; });
    expect(daemon.voiceDesiredActive).toBe(false);
    expect(aecStops).toBe(1);
    expect(clapStops).toBe(1);
    await Bun.sleep(0);
    expect(settled).toBe(false);
    releaseAec();
    await Bun.sleep(0);
    expect(settled).toBe(false);
    releaseClap();
    await stopping;
    expect(settled).toBe(true);
  } catch (error: unknown) {
    throw error;
  }
}

test("idle daemon stop retries and awaits retained raw and AEC cleanup barriers", () => (
  expectIdleStopAwaitsRetainedAecRelease()
));

async function expectStopRevokesPendingClapStart(): Promise<void> {
  const daemon = new CiceroDaemon({} as never) as DaemonHarness;
  let markStartEntered!: () => void;
  const startEntered = new Promise<void>((resolve) => { markStartEntered = resolve; });
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  let clapDesired = true;
  let recorderSpawns = 0;
  let clapStops = 0;
  daemon.lifecycle = "running";
  daemon.running = true;
  daemon.conversational = {
    isActive: () => false,
    activate: () => {},
    deactivate: () => {},
    stop: () => Promise.resolve(),
    waitForCaptureRelease: () => Promise.resolve(),
    releaseAudioCapture: () => Promise.resolve(),
  };
  daemon.aecHub = {
    isRunning: () => false,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
  daemon.clapListener = {
    start: () => {
      markStartEntered();
      return startGate.then(() => { if (clapDesired) recorderSpawns++; });
    },
    stop: () => { clapDesired = false; clapStops++; },
  };

  try {
    daemon.handleVoiceDeactivated();
    await startEntered;
    const stopping = daemon.stop();
    expect(clapDesired).toBe(false);
    expect(clapStops).toBeGreaterThanOrEqual(1);

    releaseStart();
    await stopping;
    expect(recorderSpawns).toBe(0);
  } catch (error: unknown) {
    throw error;
  }
}

test("daemon stop revokes a Clap start that is still awaiting old recorder cleanup", () => (
  expectStopRevokesPendingClapStart()
));

async function expectShutdownPreventsStaleVoiceActivation(): Promise<void> {
  const daemon = new CiceroDaemon({} as never) as DaemonHarness;
  let active = false;
  let activations = 0;
  let releaseStart!: () => void;
  const starting = new Promise<void>((resolve) => { releaseStart = resolve; });
  let aecStops = 0;
  daemon.lifecycle = "running";
  daemon.running = true;
  daemon.conversational = {
    isActive: () => active,
    activate: () => { active = true; activations++; },
    deactivate: () => { active = false; },
    stop: () => Promise.resolve(),
    waitForCaptureRelease: () => Promise.resolve(),
    releaseAudioCapture: () => Promise.resolve(),
  };
  daemon.aecHub = {
    isRunning: () => false,
    start: () => starting,
    stop: () => { aecStops++; },
  };
  daemon.clapListener = { start: () => {}, stop: () => {} };
  daemon.stopAfterStartup = () => Promise.resolve();

  try {
    const activating = daemon.setVoiceMode(true);
    await Bun.sleep(0);
    await daemon.stop();
    releaseStart();
    await activating;

    expect(activations).toBe(0);
    expect(active).toBe(false);
    expect(daemon.voiceDesiredActive).toBe(false);
    expect(aecStops).toBeGreaterThanOrEqual(1);
  } catch (error: unknown) {
    throw error;
  }
}

test("an AEC start that settles after shutdown cannot resurrect voice mode", () => (
  expectShutdownPreventsStaleVoiceActivation()
));

async function expectShutdownDrainsVoiceTransition(): Promise<void> {
  const daemon = new CiceroDaemon({} as never) as DaemonHarness;
  let releaseTransition!: () => void;
  const transition = new Promise<void>((resolve) => { releaseTransition = resolve; });
  daemon.lifecycle = "running";
  daemon.running = true;
  daemon.voiceTransition = transition;
  let settled = false;

  try {
    const stopping = daemon.stop().finally(() => { settled = true; });
    await Bun.sleep(0);
    expect(settled).toBe(false);
    releaseTransition();
    await stopping;
    expect(settled).toBe(true);
  } catch (error: unknown) {
    throw error;
  }
}

test("daemon shutdown drains the owned voice transition before cleanup completes", () => (
  expectShutdownDrainsVoiceTransition()
));
