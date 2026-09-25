import { expect, test } from "bun:test";
import { TurnCoordinator } from "../src/turn-coordinator";
import { coordinatedWebSink, processWebTurn, streamWebTextTurn, type WebReplySink } from "../src/web-voice/turn";
import { CiceroDaemon } from "../src/daemon";
import { summarizeForTTS } from "../src/summarizer";
import type { LLMProvider } from "../src/backends/llm/provider";
import { ConversationalListener } from "../src/listener/conversational";
import { MAX_TURN_AUDIO_BYTES } from "../src/web-voice/protocol";

const request = (turnId: string, source: "web" | "local-mic" = "web", sessionId = source) => ({
  sessionId, turnId, source, text: "hello",
});

test("one owner and exactly one terminal event", () => {
  const events: string[] = [];
  const coordinator = new TurnCoordinator();
  const turn = coordinator.start(request("one"), (event) => events.push(event.type));
  expect(() => coordinator.start(request("one"))).toThrow();
  turn.emit({ type: "transcript", text: "hello" });
  turn.complete();
  expect(() => coordinator.start(request("one"))).toThrow();
  turn.fail("late error");
  turn.emit({ type: "audio", audio: new ArrayBuffer(1) });
  expect(events).toEqual(["transcript", "done"]);
});

test("a foreground turn in the same session aborts old provider work and drops late STT, brain, TTS and notices", async () => {
  const events: string[] = [];
  const coordinator = new TurnCoordinator();
  const old = coordinator.start(request("one"), (event) => events.push(event.type));
  const newTurn = coordinator.start(request("two"));
  expect(old.signal.aborted).toBe(true);
  old.emit({ type: "transcript", text: "late STT" });
  old.emit({ type: "sentence", text: "late brain" });
  old.emit({ type: "audio", audio: new ArrayBuffer(1) });
  old.emit({ type: "notice", text: "late notice" });
  old.complete();
  expect(events).toEqual(["aborted"]);
  expect(newTurn.signal.aborted).toBe(false);
  newTurn.complete();
});

test("foreground turns in distinct sessions remain independent", () => {
  const coordinator = new TurnCoordinator();
  const phone = coordinator.start(request("phone", "web", "socket-a"));
  const otherSocket = coordinator.start(request("other", "web", "socket-b"));
  const microphone = coordinator.start(request("mic", "local-mic"));
  const stdin = coordinator.start({ sessionId: "stdin", turnId: "typed", source: "text", text: "hello" });
  coordinator.start(request("replacement", "web", "socket-a"));
  expect(phone.outcome).toBe("aborted");
  expect(otherSocket.active).toBe(true);
  expect(microphone.active).toBe(true);
  expect(stdin.active).toBe(true);
});

test("background work remains owned when foreground changes", () => {
  const coordinator = new TurnCoordinator();
  const captureSignal = coordinator.supersessionSignal("web");
  const background = coordinator.start({ ...request("parked"), lane: "background" });
  expect(captureSignal.aborted).toBe(false);
  coordinator.start(request("foreground"));
  expect(captureSignal.aborted).toBe(true);
  coordinator.start(request("next"));
  expect(background.signal.aborted).toBe(false);
  background.complete();
});

test("caller cancellation propagates and oversized input or output is refused", () => {
  const coordinator = new TurnCoordinator();
  const caller = new AbortController();
  const events: string[] = [];
  const turn = coordinator.start({ ...request("one"), signal: caller.signal }, (event) => events.push(event.type));
  caller.abort();
  expect(turn.signal.aborted).toBe(true);
  expect(events).toEqual(["aborted"]);
  const live = coordinator.start(request("live"));
  const preAborted = new AbortController();
  preAborted.abort();
  expect(coordinator.start({ ...request("cancelled"), signal: preAborted.signal }).outcome).toBe("aborted");
  expect(live.signal.aborted).toBe(false);
  live.complete();
  expect(() => coordinator.start({ ...request("huge"), text: "x".repeat(16_385) })).toThrow();
  const next = coordinator.start(request("next"), (event) => events.push(event.type));
  next.emit({ type: "sentence", text: "x".repeat(16_385) });
  expect(events.at(-1)).toBe("error");
  expect(next.signal.aborted).toBe(true);
});

test("supersession reaches STT and rejects its late transcript before brain dispatch", async () => {
  const coordinator = new TurnCoordinator();
  let releaseStt!: (text: string) => void;
  let markSttStarted!: () => void;
  const sttStarted = new Promise<void>((resolve) => { markSttStarted = resolve; });
  let providerSignal: AbortSignal | undefined;
  let brainCalls = 0;
  const audio = new ArrayBuffer(8);
  const old = coordinator.start({ sessionId: "phone", turnId: "one", source: "web", audio });
  const work = processWebTurn(audio, {
    stt: { transcribe: (_path, signal) => {
      providerSignal = signal;
      markSttStarted();
      return new Promise<string>((resolve) => { releaseStt = resolve; });
    } },
    brain: { send: async () => { brainCalls++; return "late"; } },
    tts: { generateAudio: async () => new ArrayBuffer(0) },
    signal: old.signal,
  });
  await sttStarted;
  expect(providerSignal).toBe(old.signal);
  coordinator.start(request("two", "web", "phone"));
  expect(providerSignal?.aborted).toBe(true);
  releaseStt("late words");
  await expect(work).rejects.toThrow();
  expect(brainCalls).toBe(0);
});

test("a local microphone admission cancels prior local STT before command dispatch", async () => {
  const coordinator = new TurnCoordinator();
  let finishStt!: (text: string) => void;
  let markSttStarted!: () => void;
  const sttStarted = new Promise<void>((resolve) => { markSttStarted = resolve; });
  let providerSignal: AbortSignal | undefined;
  const stt = {
    transcribe: (_path: string, signal?: AbortSignal) => {
      providerSignal = signal;
      markSttStarted();
      return new Promise<string>((resolve) => { finishStt = resolve; });
    },
  };
  const listener = new ConversationalListener(
    stt as never, {} as never, { play: async () => {} } as never,
    false, "1.0", "3%", undefined, undefined, false, false,
  ) as ConversationalListener & {
    active: boolean;
    recordUntilSilence: () => Promise<{ status: "ok"; path: string }>;
    captureTurn: () => Promise<string | null>;
  };
  listener.active = true;
  listener.recordUntilSilence = async () => ({ status: "ok", path: "/tmp/cicero-local-stt-test.wav" });
  listener.setTurnSupersessionSignal(() => coordinator.supersessionSignal("local-mic"));
  const capture = listener.captureTurn();
  await sttStarted;
  coordinator.start(request("phone"));
  expect(providerSignal?.aborted).toBe(false);
  coordinator.start(request("new", "local-mic"));
  expect(providerSignal?.aborted).toBe(true);
  finishStt("late local words");
  expect(await capture).toBe("");
});

test("a late local addressed-to-me verdict cannot dispatch after local admission", async () => {
  const coordinator = new TurnCoordinator();
  const listener = new ConversationalListener(
    { transcribe: async () => "unused" } as never,
    {} as never, { play: async () => {} } as never,
    false, "1.0", "3%", undefined, undefined, false, false,
  ) as ConversationalListener & {
    active: boolean;
    captureSupersessionSignal: AbortSignal | null;
    initTurnDetection: () => Promise<void>;
    captureTurn: () => Promise<string | null>;
    addressedToMe: () => Promise<boolean>;
    listenLoop: (epoch: number) => Promise<void>;
  };
  listener.active = true;
  listener.initTurnDetection = async () => {};
  let captures = 0;
  listener.captureTurn = async () => {
    if (++captures > 1) return null;
    listener.captureSupersessionSignal = coordinator.supersessionSignal("local-mic");
    return "hello";
  };
  let resolveJudge!: (value: boolean) => void;
  let markJudgeStarted!: () => void;
  const judgeStarted = new Promise<void>((resolve) => { markJudgeStarted = resolve; });
  listener.addressedToMe = () => {
    markJudgeStarted();
    return new Promise<boolean>((resolve) => { resolveJudge = resolve; });
  };
  const dispatched: string[] = [];
  listener.onCommand((text) => { dispatched.push(text); });
  const loop = listener.listenLoop(0);
  await judgeStarted;
  coordinator.start(request("new", "local-mic"));
  resolveJudge(true);
  await loop;
  expect(dispatched).toEqual([]);
});

test("local spoken confirmation STT receives its turn cancellation", async () => {
  const coordinator = new TurnCoordinator();
  const local = coordinator.start(request("compute", "local-mic"));
  let finishStt!: (text: string) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let providerSignal: AbortSignal | undefined;
  const listener = new ConversationalListener(
    { transcribe: (_path: string, signal?: AbortSignal) => {
      providerSignal = signal;
      markStarted();
      return new Promise<string>((resolve) => { finishStt = resolve; });
    } } as never,
    {} as never, { play: async () => {} } as never,
    false, "1.0", "3%", undefined, undefined, false, false,
  ) as ConversationalListener & {
    active: boolean;
    recordUntilSilence: () => Promise<{ status: "ok"; path: string }>;
  };
  listener.active = true;
  listener.recordUntilSilence = async () => ({ status: "ok", path: "/tmp/cicero-confirmation-test.wav" });
  const confirmation = listener.listenOnce(local.signal);
  await started;
  coordinator.start(request("new", "local-mic"));
  expect(providerSignal?.aborted).toBe(true);
  finishStt("late yes");
  expect(await confirmation).toBe("");
});

test("the web bridge suppresses late TTS audio and publishes one abort", async () => {
  const coordinator = new TurnCoordinator();
  const events: string[] = [];
  let releaseTts!: (audio: ArrayBuffer) => void;
  let markTtsStarted!: () => void;
  const ttsStarted = new Promise<void>((resolve) => { markTtsStarted = resolve; });
  let providerSignal: AbortSignal | undefined;
  const old = coordinator.start(request("one"), (event) => { events.push(event.type); });
  const raw: WebReplySink = {
    transcript: () => {}, sentence: () => {}, audio: () => {}, control: () => {},
    done: () => {}, error: () => {}, aborted: () => false,
  };
  const work = streamWebTextTurn("hello", {
    stt: { transcribe: async () => "unused" },
    brain: { send: async () => "Reply." },
    tts: { generateAudio: async (_text, _file, options) => {
      providerSignal = options?.signal;
      markTtsStarted();
      return new Promise<ArrayBuffer>((resolve) => { releaseTts = resolve; });
    } },
    signal: old.signal,
  }, coordinatedWebSink(old, raw));
  await ttsStarted;
  expect(providerSignal).toBeDefined();
  coordinator.start(request("two"));
  expect(providerSignal?.aborted).toBe(true);
  releaseTts(new ArrayBuffer(8));
  await work;
  expect(events.at(-1)).toBe("aborted");
  expect(events).not.toContain("audio");
  expect(events).not.toContain("done");
});

test("a web failure reaches the transport before its provider signal closes", () => {
  const coordinator = new TurnCoordinator();
  const frames: string[] = [];
  const turn = coordinator.start(request("error"), (event) => {
    if (event.type === "error" && !turn.signal.aborted) frames.push(event.message);
  });
  const raw: WebReplySink = {
    transcript: () => {}, sentence: () => {}, audio: () => {}, control: () => {},
    done: () => {}, error: (message) => { frames.push(message); }, aborted: () => turn.signal.aborted,
  };
  coordinatedWebSink(turn, raw).error("provider failed");
  expect(frames).toEqual(["provider failed"]);
  expect(turn.signal.aborted).toBe(true);
});

test("the web sink retains its oversized audio error and completion behavior", () => {
  const coordinator = new TurnCoordinator();
  const events: string[] = [];
  const forwarded: number[] = [];
  const turn = coordinator.start(request("oversized"), (event) => events.push(event.type));
  const raw: WebReplySink = {
    transcript: () => {}, sentence: () => {}, control: () => {},
    audio: (audio) => { forwarded.push(audio.byteLength); },
    done: () => {}, error: () => {}, aborted: () => false,
  };
  const bridge = coordinatedWebSink(turn, raw);
  bridge.audio(new ArrayBuffer(MAX_TURN_AUDIO_BYTES + 1));
  bridge.done();
  expect(forwarded).toEqual([MAX_TURN_AUDIO_BYTES + 1]);
  expect(events).toEqual(["done"]);
});

test("terminal errors redact synthetic credential markers", () => {
  const events: string[] = [];
  const coordinator = new TurnCoordinator();
  const turn = coordinator.start(request("secret"), (event) => {
    if (event.type === "error") events.push(event.message);
  });
  turn.fail("provider rejected sk-syntheticsecret123");
  expect(events).toEqual(["provider rejected <redacted>"]);
});

test("daemon local dispatch supersedes its own session without cancelling web", async () => {
  let finishLocal!: () => void;
  const localFinished = new Promise<void>((resolve) => { finishLocal = resolve; });
  const seen: AbortSignal[] = [];
  const daemon = new CiceroDaemon({} as never) as unknown as {
    dispatchCommand: (text: string) => Promise<void>;
    handleCommand: (text: string, signal: AbortSignal) => Promise<void>;
    turnCoordinator: TurnCoordinator;
  };
  daemon.handleCommand = async (_text, signal) => {
    seen.push(signal);
    await localFinished;
  };
  const local = daemon.dispatchCommand("hello");
  expect(seen).toHaveLength(1);
  const web = daemon.turnCoordinator.start({
    sessionId: "phone", turnId: "one", source: "web", audio: new ArrayBuffer(8),
  });
  expect(seen[0]?.aborted).toBe(false);
  expect(web.signal.aborted).toBe(false);
  daemon.handleCommand = async (_text, signal) => { seen.push(signal); };
  await daemon.dispatchCommand("again");
  expect(seen[0]?.aborted).toBe(true);
  finishLocal();
  await local;
  expect(web.signal.aborted).toBe(false);
});

test("local summary call receives cancellation and cannot return a late reply", async () => {
  const coordinator = new TurnCoordinator();
  const old = coordinator.start(request("one", "local-mic"));
  let finish!: (text: string) => void;
  let providerSignal: AbortSignal | undefined;
  const llm = {
    chatCompletion: (_messages: unknown, options: { signal?: AbortSignal }) => {
      providerSignal = options.signal;
      return new Promise<string>((resolve) => { finish = resolve; });
    },
  } as LLMProvider;
  const summary = summarizeForTTS("x".repeat(300), llm, { maxTokens: 100, signal: old.signal });
  expect(providerSignal).toBe(old.signal);
  coordinator.start(request("two", "local-mic"));
  finish("late summary");
  await expect(summary).rejects.toThrow();
});
