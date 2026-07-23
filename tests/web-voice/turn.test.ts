import { test, expect } from "bun:test";
import { OPERATIONAL_CONTEXT_CAPTURE_TIMEOUT_MS, silenceWavLike, SPEAKER_BEAT_MS, processWebTurn, streamWebTurn, streamWebTextTurn, isExpandRequest, isRepeatRequest, isResumeRequest, applyVoiceControl, concatWavs, type WebTurnDeps, type WebStreamDeps, type WebReplySink } from "../../src/web-voice/turn";
import { ProviderSlot, SwappableTTSProvider } from "../../src/backends/hot-swap";
import type { TTSProvider } from "../../src/backends/tts/provider";

async function* tokens(...parts: string[]) { for (const p of parts) yield p; }

function capturingSink(abortWhen?: (c: SinkCalls) => boolean) {
  const calls: SinkCalls = { transcript: [], sentence: [], audio: 0, control: [], done: 0, error: [] };
  const sink: WebReplySink = {
    transcript: (t) => calls.transcript.push(t),
    sentence: (t) => calls.sentence.push(t),
    audio: () => { calls.audio++; },
    control: (m) => calls.control.push(m),
    done: () => { calls.done++; },
    error: (m) => calls.error.push(m),
    aborted: () => (abortWhen ? abortWhen(calls) : false),
  };
  return { sink, calls };
}
interface SinkCalls { transcript: string[]; sentence: string[]; audio: number; control: Array<{ type: string; delta?: number; volume?: number; rate?: number }>; done: number; error: string[]; }

function streamDeps(over: Partial<{ transcript: string; stream: string[]; reply: string }> = {}): WebStreamDeps {
  return {
    stt: { transcribe: async () => over.transcript ?? "hi there" },
    brain: over.stream
      ? { send: async () => over.reply ?? "", sendStream: () => tokens(...over.stream as string[]) }
      : { send: async () => over.reply ?? "One. Two." },
    tts: { generateAudio: async () => tinyWav([1]) },
  };
}

function deps(over: Partial<{ transcript: string | null; reply: string; calls: string[] }> = {}): WebTurnDeps {
  const calls = over.calls ?? [];
  const transcript = "transcript" in over ? over.transcript ?? null : "what time is it";
  return {
    stt: { transcribe: async () => { calls.push("stt"); return transcript; } },
    brain: { send: async (t: string) => { calls.push(`brain:${t}`); return over.reply ?? "It is noon."; } },
    tts: { generateAudio: async (t: string) => { calls.push(`tts:${t}`); return tinyWav([1]); } },
  };
}

test("runs WAV → STT → brain → TTS and returns transcript, reply, audio", async () => {
  const calls: string[] = [];
  const out = await processWebTurn(new ArrayBuffer(8), deps({ calls }));
  expect(out.transcript).toBe("what time is it");
  expect(out.reply).toBe("It is noon.");
  expect(out.audio.byteLength).toBe(tinyWav([1]).byteLength);
  expect(calls).toEqual(["stt", "brain:what time is it", "tts:It is noon."]);
});

test("empty transcript short-circuits — no brain or TTS call", async () => {
  const calls: string[] = [];
  const out = await processWebTurn(new ArrayBuffer(8), deps({ transcript: "   ", calls }));
  expect(out.transcript).toBe("");
  expect(out.reply).toBe("");
  expect(out.audio.byteLength).toBe(0);
  expect(calls).toEqual(["stt"]); // brain/tts never invoked
});

test("null transcript (STT miss) short-circuits too", async () => {
  const calls: string[] = [];
  const out = await processWebTurn(new ArrayBuffer(8), deps({ transcript: null, calls }));
  expect(out.transcript).toBe("");
  expect(calls).toEqual(["stt"]);
});

test("empty brain reply yields a transcript but no audio (nothing to speak)", async () => {
  const calls: string[] = [];
  const out = await processWebTurn(new ArrayBuffer(8), deps({ reply: "  ", calls }));
  expect(out.transcript).toBe("what time is it");
  expect(out.reply).toBe("");
  expect(out.audio.byteLength).toBe(0);
  expect(calls).toEqual(["stt", "brain:what time is it"]); // tts skipped
});

test("processWebTurn rejects a pre-aborted transport before invoking providers", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  controller.abort(new Error("server shutting down"));
  await expect(processWebTurn(new ArrayBuffer(8), { ...deps({ calls }), signal: controller.signal }))
    .rejects.toThrow("server shutting down");
  expect(calls).toEqual([]);
});

test("processWebTurn forwards cancellation to the brain and suppresses late TTS", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  let ttsCalls = 0;
  const turn: WebTurnDeps = {
    stt: { transcribe: () => Promise.resolve("hello") },
    brain: {
      send: (_text, options) => {
        receivedSignal = options?.signal;
        controller.abort(new Error("turn cancelled"));
        return Promise.resolve("late reply");
      },
    },
    tts: { generateAudio: () => { ttsCalls += 1; return Promise.resolve(new ArrayBuffer(8)); } },
    signal: controller.signal,
  };
  await expect(processWebTurn(new ArrayBuffer(8), turn)).rejects.toThrow("turn cancelled");
  expect(receivedSignal).toBe(controller.signal);
  expect(ttsCalls).toBe(0);
});

test("operational context is captured once immediately before the batch brain invocation", async () => {
  const calls: string[] = [];
  let received: string | undefined;
  const d = deps({ calls });
  d.operationalContext = async () => { calls.push("snapshot"); return "state-v1"; };
  d.brain = {
    send: async (_text, options) => {
      calls.push("brain");
      received = options?.systemContext;
      return "Done.";
    },
  };
  await processWebTurn(new ArrayBuffer(8), d);
  expect(calls.slice(0, 3)).toEqual(["stt", "snapshot", "brain"]);
  expect(received).toBe("state-v1");
});

test("batch local detail fast path does not capture operational context", async () => {
  let snapshots = 0;
  let brains = 0;
  const d = deps({ transcript: "details" });
  d.tldr = { cap: 1, pending: () => "Stored detail." };
  d.operationalContext = async () => { snapshots++; return "unused"; };
  d.brain = { send: async () => { brains++; return "wrong"; } };
  await processWebTurn(new ArrayBuffer(8), d);
  expect(snapshots).toBe(0);
  expect(brains).toBe(0);
});

test("abort during snapshot capture prevents the batch brain invocation", async () => {
  const controller = new AbortController();
  let brains = 0;
  const d = deps();
  d.signal = controller.signal;
  d.operationalContext = async () => {
    controller.abort(new Error("superseded during snapshot"));
    return "late state";
  };
  d.brain = { send: async () => { brains++; return "late"; } };
  await expect(processWebTurn(new ArrayBuffer(8), d)).rejects.toThrow("superseded during snapshot");
  expect(brains).toBe(0);
});

test("later batch turns see changed operational state", async () => {
  let version = 1;
  const seen: Array<string | undefined> = [];
  const d = deps();
  d.operationalContext = async () => `state-v${version}`;
  d.brain = { send: async (_text, options) => { seen.push(options?.systemContext); return "ok"; } };
  await processWebTurn(new ArrayBuffer(8), d);
  version = 2;
  await processWebTurn(new ArrayBuffer(8), d);
  expect(seen).toEqual(["state-v1", "state-v2"]);
});

test("a hung operational capture is abandoned at its deadline", async () => {
  let received: string | undefined = "not called";
  const d = deps();
  d.operationalContext = () => new Promise<string | null>(() => {});
  d.brain = { send: async (_text, options) => {
    received = options?.systemContext;
    return "ok";
  } };
  const started = Date.now();
  await processWebTurn(new ArrayBuffer(8), d);
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(OPERATIONAL_CONTEXT_CAPTURE_TIMEOUT_MS - 100);
  expect(elapsed).toBeLessThan(OPERATIONAL_CONTEXT_CAPTURE_TIMEOUT_MS + 1_500);
  expect(received).toBeUndefined();
});

// --- streamWebTurn (Phase 2: streaming) ---

test("streamWebTurn emits transcript, then a sentence+audio per sentence, then done", async () => {
  const { sink, calls } = capturingSink();
  await streamWebTurn(new ArrayBuffer(8), streamDeps({ stream: ["Hello there. ", "How are you?"] }), sink);
  expect(calls.transcript).toEqual(["hi there"]);
  expect(calls.sentence).toEqual(["Hello there.", "How are you?"]);
  expect(calls.audio).toBe(2);     // one synth per sentence
  expect(calls.done).toBe(1);
  expect(calls.error).toEqual([]);
});

test("streaming captures operational context once after fast paths and forwards it", async () => {
  const events: string[] = [];
  let received: string | undefined;
  const d = streamDeps();
  d.operationalContext = async () => { events.push("snapshot"); return "stream-state"; };
  d.brain = {
    send: async () => "",
    sendStream: (_message, options) => {
      events.push("brain");
      received = options?.systemContext;
      return tokens("Reply.");
    },
  };
  const { sink } = capturingSink();
  await streamWebTextTurn("question", d, sink);
  expect(events).toEqual(["snapshot", "brain"]);
  expect(received).toBe("stream-state");
});

test("streaming voice controls and repeat skip operational capture", async () => {
  for (const text of ["louder", "repeat that"]) {
    let snapshots = 0;
    let brains = 0;
    const d = streamDeps();
    d.voice = { state: { volume: 1, rate: 1 } };
    d.lastReply = { store: () => {}, pending: () => "Previous reply." };
    d.operationalContext = async () => { snapshots++; return "unused"; };
    d.brain = { send: async () => { brains++; return "wrong"; } };
    const { sink } = capturingSink();
    await streamWebTextTurn(text, d, sink);
    expect(snapshots).toBe(0);
    expect(brains).toBe(0);
  }
});

test("streamWebTurn falls back to non-streaming brain.send when sendStream is absent", async () => {
  const { sink, calls } = capturingSink();
  await streamWebTurn(new ArrayBuffer(8), streamDeps({ reply: "One. Two." }), sink);
  expect(calls.sentence).toEqual(["One.", "Two."]);
  expect(calls.audio).toBe(2);
  expect(calls.done).toBe(1);
});

test("streamWebTurn short-circuits on empty transcript (no sentences)", async () => {
  const { sink, calls } = capturingSink();
  await streamWebTurn(new ArrayBuffer(8), streamDeps({ transcript: "  ", stream: ["Hi."] }), sink);
  expect(calls.transcript).toEqual([""]);
  expect(calls.sentence).toEqual([]);
  expect(calls.audio).toBe(0);
  expect(calls.done).toBe(1);
});

test("streamWebTurn stops emitting once aborted (barge-in)", async () => {
  // Abort as soon as the first sentence's audio has been sent.
  const { sink, calls } = capturingSink((c) => c.audio >= 1);
  await streamWebTurn(new ArrayBuffer(8), streamDeps({ stream: ["A. ", "B. ", "C."] }), sink);
  expect(calls.sentence).toEqual(["A."]); // stopped before B/C
  expect(calls.audio).toBe(1);
});

test("streamWebTurn speaks the filler when the reply outlasts the gate", async () => {
  const { sink, calls } = capturingSink();
  const slowStream = async function* () { await Bun.sleep(30); yield "Hello there."; };
  const deps: WebStreamDeps = {
    ...streamDeps(),
    brain: { send: async () => "", sendStream: () => slowStream() },
    filler: () => ({ text: "Let me think.", audio: tinyWav([1]) }),
    fillerDelayMs: 5, // gate well under the 30ms reply
  };
  await streamWebTurn(new ArrayBuffer(8), deps, sink);
  expect(calls.sentence).toEqual(["Let me think.", "Hello there."]); // filler leads
  expect(calls.audio).toBe(2); // filler clip + one sentence
  expect(calls.done).toBe(1);
});

test("streamWebTurn stays silent (no filler) when the reply beats the gate", async () => {
  const { sink, calls } = capturingSink();
  const deps: WebStreamDeps = {
    ...streamDeps({ stream: ["Hello there."] }),
    filler: () => ({ text: "Let me think.", audio: tinyWav([1]) }),
    fillerDelayMs: 1000, // instant fake brain answers long before this
  };
  await streamWebTurn(new ArrayBuffer(8), deps, sink);
  expect(calls.sentence).toEqual(["Hello there."]); // no verbal tic on a fast turn
  expect(calls.audio).toBe(1);
  expect(calls.done).toBe(1);
});

test("streaming turns reject malformed provider audio before forwarding it", async () => {
  const deps = streamDeps({ stream: ["Malformed reply."] });
  deps.tts = { generateAudio: () => Promise.resolve(new ArrayBuffer(8)) };
  const { sink, calls } = capturingSink();
  await streamWebTextTurn("go", deps, sink);
  expect(calls.audio).toBe(0);
  expect(calls.error[0]).toContain("RIFF/WAVE");
});

test("a malformed optional filler is skipped while valid reply audio continues", async () => {
  const deps = streamDeps({ stream: ["Real reply."] });
  deps.filler = () => ({ text: "Bad filler.", audio: new ArrayBuffer(8) });
  deps.fillerDelayMs = 0;
  const { sink, calls } = capturingSink();
  await streamWebTextTurn("go", deps, sink);
  expect(calls.sentence).toEqual(["Real reply."]);
  expect(calls.audio).toBe(1);
  expect(calls.error).toEqual([]);
});

test("streamWebTurn cancels a silent brain (tool loop, no tokens) when aborted", async () => {
  // The brain yields nothing — like an agent stuck in a long tool loop. Abort
  // must release the turn even though no sentence boundary is ever reached.
  let abortNow = false;
  const calls = { sentence: [] as string[], done: 0 };
  const sink: WebReplySink = {
    transcript: () => {},
    sentence: (t) => calls.sentence.push(t),
    audio: () => {},
    control: () => {},
    done: () => { calls.done++; },
    error: () => {},
    aborted: () => abortNow,
  };
  let receivedSignal = false;
  let upstreamCancelled = false;
  const silent = (_message: string, options?: { signal?: AbortSignal }) => (async function* (): AsyncGenerator<string> {
    await new Promise<void>((resolve) => {
      const signal = options?.signal;
      receivedSignal = signal !== undefined;
      if (signal?.aborted) { upstreamCancelled = true; resolve(); return; }
      signal?.addEventListener("abort", () => { upstreamCancelled = true; resolve(); }, { once: true });
    });
  })();
  const deps: WebStreamDeps = {
    ...streamDeps(),
    brain: { send: async () => "", sendStream: silent },
  };
  setTimeout(() => { abortNow = true; }, 50);
  const t0 = performance.now();
  await streamWebTurn(new ArrayBuffer(8), deps, sink);
  expect(performance.now() - t0).toBeLessThan(2000); // released promptly, not stuck
  expect(receivedSignal).toBe(true);
  expect(upstreamCancelled).toBe(true);
  expect(calls.sentence).toEqual([]);
  expect(calls.done).toBe(1);
});

test("a cancelled normal brain stream registers its serialized async finalizer", async () => {
  let releaseNext!: () => void;
  const nextGate = new Promise<void>((resolve) => { releaseNext = resolve; });
  let brainStarted!: () => void;
  const started = new Promise<void>((resolve) => { brainStarted = resolve; });
  let releaseFinalizer!: () => void;
  const finalizerGate = new Promise<void>((resolve) => { releaseFinalizer = resolve; });
  let finalizerStarted!: () => void;
  const finalizing = new Promise<void>((resolve) => { finalizerStarted = resolve; });
  let tracked: Promise<void> | null = null;
  const controller = new AbortController();
  const deps: WebStreamDeps = {
    ...streamDeps(),
    signal: controller.signal,
    trackBackground: (task) => { tracked = task; return true; },
    brain: {
      send: () => Promise.resolve(""),
      sendStream: () => (async function* (): AsyncGenerator<string> {
        try {
          brainStarted();
          await nextGate;
          yield "late token";
        } catch (error) {
          throw error instanceof Error ? error : new Error(String(error));
        } finally {
          finalizerStarted();
          await finalizerGate;
        }
      })(),
    },
  };
  const { sink } = capturingSink();
  const turn = streamWebTextTurn("cancel and own cleanup", deps, sink);
  await started;

  controller.abort(new Error("transport stopped"));
  await turn;
  expect(tracked).not.toBeNull();
  let settled = false;
  void tracked!.then(() => { settled = true; });
  await Bun.sleep(0);
  expect(settled).toBe(false);

  releaseNext();
  await finalizing;
  expect(settled).toBe(false);
  releaseFinalizer();
  await tracked!;
  expect(settled).toBe(true);
});

test("transport cancellation aborts an adopted speculation before any late reply escapes", async () => {
  let transcriptStarted!: () => void;
  const started = new Promise<void>((resolve) => { transcriptStarted = resolve; });
  let releaseTranscript!: () => void;
  const transcriptGate = new Promise<void>((resolve) => { releaseTranscript = resolve; });
  let aborts = 0;
  let tokenReads = 0;
  const spec = {
    claim: () => true,
    coverageOk: () => true,
    transcript: async () => {
      try {
        transcriptStarted();
        await transcriptGate;
        return "late transcript";
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
    tokens: () => {
      tokenReads += 1;
      return tokens("late reply.");
    },
    abort: () => { aborts += 1; return Promise.resolve(); },
  };
  const controller = new AbortController();
  const { sink, calls } = capturingSink();
  const turn = streamWebTurn(
    tinyWav([1]),
    { ...streamDeps(), signal: controller.signal },
    sink,
    spec,
  );
  await started;

  controller.abort(new Error("server shutting down"));
  releaseTranscript();
  await turn;
  expect(aborts).toBe(1);
  expect(tokenReads).toBe(0);
  expect(calls.transcript).toEqual([]);
  expect(calls.audio).toBe(0);
});

test("an adopted speculation is aborted when downstream reply rendering fails", async () => {
  let aborts = 0;
  const spec = {
    claim: () => true,
    coverageOk: () => true,
    transcript: () => Promise.resolve("hello"),
    tokens: () => tokens("reply sentence."),
    abort: () => { aborts += 1; return Promise.resolve(); },
  };
  const deps = streamDeps();
  deps.tts = { generateAudio: () => Promise.reject(new Error("speaker failed")) };
  const { sink, calls } = capturingSink();

  await streamWebTurn(tinyWav([1]), deps, sink, spec);
  expect(aborts).toBe(1);
  expect(calls.error).toContain("speaker failed");
});

// --- interruption recovery ("as I was saying…") ---

test("isResumeRequest matches resume phrasings, not questions", () => {
  for (const s of ["continue", "Go on.", "keep going", "ok, continue", "as you were saying", "What were you saying?", "carry on please", "finish that thought"]) {
    expect(isResumeRequest(s)).toBe(true);
  }
  for (const s of ["continue the deployment", "go on a diet", "what were you saying about the tests", "tell me more"]) {
    expect(isResumeRequest(s)).toBe(false);
  }
});

test("barge-in stores the spoken tail; a clean finish stores nothing", async () => {
  const stored: string[] = [];
  const recover = { store: (p: string) => stored.push(p), pending: () => null };
  // Aborted after two sentences spoke:
  const aborted = capturingSink((c) => c.audio >= 2);
  await streamWebTurn(new ArrayBuffer(8), { ...streamDeps({ stream: ["A one. ", "B two. ", "C three. ", "D four."] }), recover }, aborted.sink);
  expect(stored).toEqual(["A one. B two."]);
  // Clean finish:
  const clean = capturingSink();
  await streamWebTurn(new ArrayBuffer(8), { ...streamDeps({ stream: ["All done."] }), recover }, clean.sink);
  expect(stored).toEqual(["A one. B two."]); // unchanged
});

test("only the last three spoken sentences are kept as the tail", async () => {
  const stored: string[] = [];
  const recover = { store: (p: string) => stored.push(p), pending: () => null };
  const { sink } = capturingSink((c) => c.audio >= 5);
  await streamWebTurn(new ArrayBuffer(8), { ...streamDeps({ stream: ["S1. ", "S2. ", "S3. ", "S4. ", "S5. ", "S6."] }), recover }, sink);
  expect(stored).toEqual(["S3. S4. S5."]);
});

test("a resume request hands the brain its spoken tail, not the word 'continue'", async () => {
  const prompts: string[] = [];
  const deps: WebStreamDeps = {
    stt: { transcribe: async () => "continue" },
    brain: { send: async (t: string) => { prompts.push(t); return "As I was saying, the rest."; } },
    tts: { generateAudio: async () => tinyWav([1]) },
    recover: { store: () => {}, pending: () => "The first half of my answer." },
  };
  const { sink, calls } = capturingSink();
  await streamWebTurn(new ArrayBuffer(8), deps, sink);
  expect(prompts.length).toBe(1);
  expect(prompts[0]).toContain("The first half of my answer.");
  expect(prompts[0]).toContain("interrupted mid-reply");
  expect(calls.transcript).toEqual(["continue"]); // the chat log still shows what was SAID
  expect(calls.sentence).toEqual(["As I was saying, the rest."]);
});

test("'continue' with nothing pending goes to the brain verbatim", async () => {
  const prompts: string[] = [];
  const deps: WebStreamDeps = {
    stt: { transcribe: async () => "continue" },
    brain: { send: async (t: string) => { prompts.push(t); return "Continue what?"; } },
    tts: { generateAudio: async () => tinyWav([1]) },
    recover: { store: () => {}, pending: () => null },
  };
  const { sink } = capturingSink();
  await streamWebTurn(new ArrayBuffer(8), deps, sink);
  expect(prompts).toEqual(["continue"]);
});

test("streamWebTurn skips the filler when the bank isn't primed (returns undefined)", async () => {
  const { sink, calls } = capturingSink();
  const deps = { ...streamDeps({ stream: ["Hi."] }), filler: () => undefined };
  await streamWebTurn(new ArrayBuffer(8), deps, sink);
  expect(calls.sentence).toEqual(["Hi."]); // no filler prepended
  expect(calls.audio).toBe(1);
});

test("streamWebTextTurn echoes the text as transcript and streams the reply — no STT", async () => {
  let sttCalled = false;
  const d: WebStreamDeps = {
    stt: { transcribe: async () => { sttCalled = true; return "should not run"; } },
    brain: { send: async () => "", sendStream: () => tokens("Sure. ", "Done.") },
    tts: { generateAudio: async () => tinyWav([1]) },
  };
  const { sink, calls } = capturingSink();
  await streamWebTextTurn("  deploy the thing  ", d, sink);
  expect(sttCalled).toBe(false);
  expect(calls.transcript).toEqual(["deploy the thing"]);
  expect(calls.sentence).toEqual(["Sure.", "Done."]);
  expect(calls.audio).toBe(2);
  expect(calls.done).toBe(1);
});

test("streamWebTextTurn short-circuits on blank text", async () => {
  const { sink, calls } = capturingSink();
  await streamWebTextTurn("   ", streamDeps(), sink);
  expect(calls.transcript).toEqual([""]);
  expect(calls.sentence).toEqual([]);
  expect(calls.done).toBe(1);
});

// ---------- TLDR speech gate ----------

const EIGHT = ["One. ", "Two. ", "Three. ", "Four. ", "Five. ", "Six. ", "Seven. ", "Eight."];

test("long reply: first cap sentences speak, rest is text-only, coda closes the turn", async () => {
  let stored = "";
  const deps = streamDeps({ stream: EIGHT });
  deps.tldr = { cap: 3, store: (r) => { stored = r; } };
  const { sink, calls } = capturingSink();
  await streamWebTextTurn("run the audit", deps, sink);
  // pane got all 8 sentences plus the coda
  expect(calls.sentence.length).toBe(9);
  expect(calls.sentence[8]).toContain("say \"details\"");
  // voice spoke cap sentences + the coda only
  expect(calls.audio).toBe(4);
  expect(stored).toBe("Four. Five. Six. Seven. Eight.");
  expect(calls.done).toBe(1);
});

test("summarizer shapes the coda; its failure falls back to the generic line", async () => {
  const deps = streamDeps({ stream: EIGHT });
  deps.tldr = { cap: 2, summarize: async () => "Mostly numbers." };
  const { sink, calls } = capturingSink();
  await streamWebTextTurn("go", deps, sink);
  expect(calls.sentence.at(-1)).toBe('In short: Mostly numbers. Say "details" for the full version.');

  const deps2 = streamDeps({ stream: EIGHT });
  deps2.tldr = { cap: 2, summarize: async () => { throw new Error("down"); } };
  const { sink: s2, calls: c2 } = capturingSink();
  await streamWebTextTurn("go", deps2, s2);
  expect(c2.sentence.at(-1)).toContain("more sentences in the log");
});

test("short reply is untouched by the gate — no coda, nothing stored", async () => {
  let stored: string | null = null;
  const deps = streamDeps({ stream: ["Quick. ", "Answer."] });
  deps.tldr = { cap: 4, store: (r) => { stored = r; } };
  const { sink, calls } = capturingSink();
  await streamWebTextTurn("hey", deps, sink);
  expect(calls.sentence).toEqual(["Quick.", "Answer."]);
  expect(calls.audio).toBe(2);
  expect(stored).toBeNull();
});

test("expand request speaks the stored remainder without a brain turn", async () => {
  let brainCalls = 0;
  const deps = streamDeps({ stream: ["never"] });
  deps.brain = { send: async () => { brainCalls++; return "no"; }, sendStream: () => { brainCalls++; return tokens("no"); } };
  deps.tldr = { cap: 4, pending: () => "Left over. And more." };
  const { sink, calls } = capturingSink();
  await streamWebTextTurn("tell me more", deps, sink);
  expect(brainCalls).toBe(0);
  expect(calls.sentence).toEqual(["Left over.", "And more."]);
  expect(calls.audio).toBe(2);
  expect(calls.done).toBe(1);
});

test("expand phrase with nothing stored falls through to the brain", async () => {
  const deps = streamDeps({ stream: ["Nothing gated recently."] });
  deps.tldr = { cap: 4, pending: () => null };
  const { sink, calls } = capturingSink();
  await streamWebTextTurn("tell me more", deps, sink);
  expect(calls.sentence[0]).toBe("Nothing gated recently.");
});

// ---------- repeat-that replay ----------

test("isRepeatRequest matches repeat-that phrasings, rejects broader questions", () => {
  for (const yes of ["repeat that", "Repeat that, please.", "say that again", "what did you say?"]) {
    expect(isRepeatRequest(yes)).toBe(true);
  }
  for (const no of ["repeat the deployment", "what did you say about tests", "say that again tomorrow", "details"]) {
    expect(isRepeatRequest(no)).toBe(false);
  }
});

test("repeat request re-speaks the last spoken reply without a brain turn", async () => {
  let brainCalls = 0;
  const deps = streamDeps({ stream: ["never"] });
  deps.brain = { send: async () => { brainCalls++; return "no"; }, sendStream: () => { brainCalls++; return tokens("no"); } };
  deps.lastReply = { pending: () => "Last thing. Exactly this.", store: () => {} };
  const { sink, calls } = capturingSink();
  await streamWebTextTurn("repeat that", deps, sink);
  expect(brainCalls).toBe(0);
  expect(calls.sentence).toEqual(["Last thing.", "Exactly this."]);
  expect(calls.audio).toBe(2);
  expect(calls.done).toBe(1);
});

test("repeat request with no buffer says so without a brain turn", async () => {
  let brainCalls = 0;
  const deps = streamDeps();
  deps.brain = { send: async () => { brainCalls++; return "no"; } };
  deps.lastReply = { pending: () => null, store: () => {} };
  const { sink, calls } = capturingSink();
  await streamWebTextTurn("what did you say", deps, sink);
  expect(brainCalls).toBe(0);
  expect(calls.sentence).toEqual(["I haven't said anything yet."]);
  expect(calls.audio).toBe(1);
});

test("completed streaming turns store only what was actually spoken", async () => {
  const stored: string[] = [];
  const deps = streamDeps({ stream: EIGHT });
  deps.tldr = { cap: 2 };
  deps.lastReply = { pending: () => null, store: (text) => stored.push(text) };
  const { sink } = capturingSink();
  await streamWebTextTurn("go", deps, sink);
  expect(stored).toEqual(['One. Two. Plus 6 more sentences in the log — say "details" if you want them read out.']);
});

// ---------- spoken voice controls ----------

test("voice control matchers are whole-utterance only", () => {
  const state = { volume: 1.0, rate: 1.0 };
  expect(applyVoiceControl("louder", state)?.ack).toBe("Louder.");
  expect(applyVoiceControl("Speak up, please.", state)?.ack).toBe("Louder.");
  expect(applyVoiceControl("quieter", state)?.ack).toBe("Quieter.");
  expect(applyVoiceControl("slow down", state)?.ack).toBe("Slower.");
  expect(applyVoiceControl("speak faster", state)?.ack).toBe("Faster.");
  expect(applyVoiceControl("reset voice", state)?.ack).toBe("Normal voice.");
  expect(applyVoiceControl("normal speed", state)?.ack).toBe("Normal voice.");
  expect(applyVoiceControl("louder than yesterday", state)).toBeNull();
  expect(applyVoiceControl("slow down the deployment", state)).toBeNull();
});

test("voice control state steps and clamps volume/rate", () => {
  const state = { volume: 1.0, rate: 1.0 };
  for (let i = 0; i < 10; i++) applyVoiceControl("louder", state);
  expect(state.volume).toBe(2.0);
  for (let i = 0; i < 20; i++) applyVoiceControl("turn it down", state);
  expect(state.volume).toBe(0.2);
  for (let i = 0; i < 10; i++) applyVoiceControl("faster", state);
  expect(state.rate).toBe(1.4);
  for (let i = 0; i < 20; i++) applyVoiceControl("slower", state);
  expect(state.rate).toBe(0.7);
  applyVoiceControl("reset voice", state);
  expect(state).toEqual({ volume: 1.0, rate: 1.0 });
});

test("stream voice controls bypass the brain, send client controls, and render ack at current rate", async () => {
  const brainCalls: string[] = [];
  const speeds: Array<number | undefined> = [];
  const deps = streamDeps({ stream: ["never"] });
  deps.voice = { state: { volume: 1.0, rate: 1.0 } };
  deps.brain = { send: async (t) => { brainCalls.push(t); return "no"; }, sendStream: (t) => { brainCalls.push(t); return tokens("no"); } };
  deps.tts = { generateAudio: async (_t, _v, options) => { speeds.push(options?.speed); return tinyWav([1]); } };

  const louder = capturingSink();
  await streamWebTextTurn("louder", deps, louder.sink);
  expect(brainCalls).toEqual([]);
  expect(louder.calls.control[0]?.type).toBe("volume");
  expect(louder.calls.control[0]?.delta).toBeCloseTo(0.2);
  expect(louder.calls.control[0]?.volume).toBeCloseTo(1.2);
  expect(louder.calls.sentence).toEqual(["Louder."]);

  const faster = capturingSink();
  await streamWebTextTurn("faster", deps, faster.sink);
  expect(faster.calls.control).toEqual([{ type: "rate", rate: 1.15 }]);
  expect(faster.calls.sentence).toEqual(["Faster."]);
  expect(speeds.at(-1)).toBe(1.15);
});

test("isExpandRequest matches spoken variants, rejects questions", () => {
  for (const yes of ["tell me more", "Details.", "the details please", "Details, please.", "Tell me more, please", "expand on that", "read it all"]) {
    expect(isExpandRequest(yes)).toBe(true);
  }
  for (const no of ["tell me more about France", "what are the details of the PR", "expand the config"]) {
    expect(isExpandRequest(no)).toBe(false);
  }
});

// ---------- TLDR on the non-streaming path (/api/turn — Telegram calls) ----------

test("processWebTurn gates a long reply: spoken audio is head+coda, reply text stays full", async () => {
  let stored = ""; const spoken: string[] = [];
  const d = deps({ reply: "One. Two. Three. Four. Five. Six." });
  d.tts = { generateAudio: async (t) => { spoken.push(t); return tinyWav([1]); } };
  d.tldr = { cap: 2, store: (r) => { stored = r; }, summarize: async () => "Numbers mostly." };
  const out = await processWebTurn(new ArrayBuffer(8), d);
  expect(out.reply).toBe("One. Two. Three. Four. Five. Six.");
  // rendered per sentence now (lane voices / roll call resolve per sentence)
  expect(spoken).toEqual(["One.", "Two.", "In short: Numbers mostly.", 'Say "details" for the full version.']);
  expect(stored).toBe("Three. Four. Five. Six.");
});

test("processWebTurn: 'details' speaks the stored remainder without a brain call", async () => {
  const calls: string[] = [];
  const d = deps({ transcript: "details", calls });
  d.tldr = { cap: 2, pending: () => "The rest of it." };
  const out = await processWebTurn(new ArrayBuffer(8), d);
  expect(out.reply).toBe("The rest of it.");
  expect(calls).toEqual(["stt", "tts:The rest of it."]); // no brain: entry
});

test("processWebTurn: short reply passes through the gate untouched", async () => {
  const calls: string[] = [];
  const d = deps({ reply: "Done.", calls });
  d.tldr = { cap: 4 };
  const out = await processWebTurn(new ArrayBuffer(8), d);
  expect(out.reply).toBe("Done.");
  expect(calls.at(-1)).toBe("tts:Done.");
});

// ---------- WAV concatenation (per-sentence voices on the /api/turn path) ----------

function tinyWav(samples: number[], sampleRate = 24000): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const wr = (off: number, str: string) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };
  wr(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); wr(8, "WAVE");
  wr(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wr(36, "data"); v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, s, true));
  return buf;
}

function pcm8Wav(frameCount: number, sampleRate = 8_000): ArrayBuffer {
  const dataPadding = frameCount & 1;
  const buf = new ArrayBuffer(44 + frameCount + dataPadding);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const tag = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
  };
  tag(0, "RIFF"); view.setUint32(4, buf.byteLength - 8, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  tag(36, "data"); view.setUint32(40, frameCount, true);
  bytes.fill(128, 44, 44 + frameCount);
  return buf;
}

function floatWav(sample: number): ArrayBuffer {
  const buf = new ArrayBuffer(48);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const tag = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
  };
  tag(0, "RIFF"); view.setUint32(4, 40, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 3, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16_000, true);
  view.setUint32(28, 64_000, true); view.setUint16(32, 4, true); view.setUint16(34, 32, true);
  tag(36, "data"); view.setUint32(40, 4, true); view.setFloat32(44, sample, true);
  return buf;
}

function withHiddenSecondData(input: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(input.byteLength + 10);
  out.set(new Uint8Array(input));
  const view = new DataView(out.buffer);
  const offset = input.byteLength;
  out.set(new TextEncoder().encode("data"), offset);
  view.setUint32(offset + 4, 2, true);
  view.setInt16(offset + 8, 99, true);
  view.setUint32(4, out.byteLength - 8, true);
  return out.buffer;
}

test("concatWavs merges payloads and rewrites sizes", () => {
  const a = tinyWav([1, 2, 3]);
  const b = tinyWav([4, 5]);
  const out = concatWavs([a, b]);
  const v = new DataView(out);
  expect(out.byteLength).toBe(44 + 10);
  expect(v.getUint32(4, true)).toBe(out.byteLength - 8);
  expect(v.getUint32(40, true)).toBe(10);
  expect([1,2,3,4,5].map((_, i) => v.getInt16(44 + i * 2, true))).toEqual([1, 2, 3, 4, 5]);
});

test("concatWavs rejects format mismatches and enforces an exact aggregate cap", () => {
  const a = tinyWav([1, 2, 3], 24000);
  const b = tinyWav([4, 5], 16000);
  expect(() => concatWavs([a, b])).toThrow(/different PCM formats/);

  const matching = tinyWav([4, 5], 24000);
  const exactBytes = 44 + 10;
  expect(concatWavs([a, matching], exactBytes).byteLength).toBe(exactBytes);
  expect(() => concatWavs([a, matching], exactBytes - 1)).toThrow(/exceeds.*limit/);
});

test("concatWavs validates a single clip and rejects non-finite/non-PCM composition", () => {
  expect(() => concatWavs([new ArrayBuffer(8)])).toThrow(/RIFF/);
  expect(() => concatWavs([withHiddenSecondData(tinyWav([1]))])).toThrow(/duplicate data/);
  expect(() => concatWavs([floatWav(Number.NaN)])).toThrow(/sample is not finite/);
  expect(() => concatWavs([floatWav(Number.POSITIVE_INFINITY)])).toThrow(/sample is not finite/);
  expect(() => concatWavs([floatWav(0.25)])).toThrow(/non-PCM/);
});

test("concatWavs enforces the shared aggregate five-minute frame limit exactly", () => {
  const halfFrames = (8_000 * 5 * 60) / 2;
  const half = pcm8Wav(halfFrames);
  const exact = concatWavs([half, half]);
  expect(new DataView(exact).getUint32(40, true)).toBe(8_000 * 5 * 60);
  expect(() => concatWavs([half, half, pcm8Wav(1)]))
    .toThrow(/duration exceeds.*300000ms/);
});

test("concatWavs removes per-part padding and pads only the final data chunk", () => {
  const first = pcm8Wav(1);
  const second = pcm8Wav(2);
  const out = concatWavs([first, second]);
  const bytes = new Uint8Array(out);
  const view = new DataView(out);
  expect(view.getUint32(40, true)).toBe(3);
  expect(out.byteLength).toBe(48); // 44-byte header + 3 samples + one RIFF pad
  expect([...bytes.slice(44, 47)]).toEqual([128, 128, 128]);
  expect(bytes[47]).toBe(0);
  expect(view.getUint32(4, true)).toBe(40);
});

test("concatWavs bounds retained part-object overhead exactly", () => {
  const clip = tinyWav([1]);
  expect(concatWavs(Array.from({ length: 4_096 }, () => clip)).byteLength)
    .toBe(44 + 4_096 * 2);
  expect(() => concatWavs(Array.from({ length: 4_097 }, () => clip)))
    .toThrow(/4096-part limit/);
});

test("processWebTurn rejects malformed provider clips before requesting the next sentence", async () => {
  let generated = 0;
  const d = deps({ reply: "One. Two. Three." });
  d.tts = {
    generateAudio: async () => {
      generated += 1;
      return generated === 1 ? tinyWav([1]) : new ArrayBuffer(8);
    },
  };
  await expect(processWebTurn(new ArrayBuffer(8), d)).rejects.toThrow(/RIFF/);
  expect(generated).toBe(2);
});

test("processWebTurn validates the expand fast-path provider clip", async () => {
  const d = deps({ transcript: "details" });
  d.tldr = { cap: 1, pending: () => "Stored detail." };
  d.tts = { generateAudio: async () => new ArrayBuffer(8) };
  await expect(processWebTurn(new ArrayBuffer(8), d)).rejects.toThrow(/RIFF/);
});

test("processWebTurn admits a multi-part final WAV exactly at its encoded cap", async () => {
  const clip = tinyWav([1]);
  const finalBytes = 44 + 4; // two PCM16 frames after duplicate headers are removed
  const exact = deps({ reply: "One. Two." });
  exact.maxAudioBytes = finalBytes;
  exact.tts = { generateAudio: async () => clip };
  expect((await processWebTurn(new ArrayBuffer(8), exact)).audio.byteLength).toBe(finalBytes);

  const oneByteOver = deps({ reply: "One. Two." });
  oneByteOver.maxAudioBytes = finalBytes - 1;
  oneByteOver.tts = { generateAudio: async () => clip };
  await expect(processWebTurn(new ArrayBuffer(8), oneByteOver))
    .rejects.toThrow(/concatenated WAV exceeds.*limit/);
});

test("processWebTurn owns the first provider clip while awaiting the second", async () => {
  const first = tinyWav([111]);
  const second = tinyWav([222]);
  let generated = 0;
  const d = deps({ reply: "One. Two." });
  d.tts = {
    generateAudio: async () => {
      generated += 1;
      if (generated === 1) return first;
      new Uint8Array(first)[0] = 0; // provider mutates its prior result in place
      return second;
    },
  };

  const output = await processWebTurn(new ArrayBuffer(8), d);
  const view = new DataView(output.audio);
  expect(new TextDecoder().decode(new Uint8Array(output.audio, 0, 4))).toBe("RIFF");
  expect(view.getInt16(44, true)).toBe(111);
  expect(view.getInt16(46, true)).toBe(222);
});

test("processWebTurn renders per sentence (voices can differ) and returns one WAV", async () => {
  const voices: (string | undefined)[] = [];
  let n = 0;
  const d = deps({ reply: "One. Two. Three." });
  d.tts = { generateAudio: async (t: string) => { voices.push(t); n++; return tinyWav([n]); } };
  const out = await processWebTurn(new ArrayBuffer(8), d);
  expect(voices).toEqual(["One.", "Two.", "Three."]);
  const v = new DataView(out.audio);
  expect(v.getUint32(40, true)).toBe(6); // three one-sample payloads merged
});

test("control turns (roll call / standup) are never TLDR-gated", async () => {
  const spoken: string[] = [];
  const d = deps({ reply: "One. Two. Three. Four. Five. Six." });
  (d.brain as { wasControlTurn?: () => boolean }).wasControlTurn = () => true;
  d.tldr = { cap: 2 };
  d.tts = { generateAudio: async (t2: string) => { spoken.push(t2); return tinyWav([1]); } };
  const out = await processWebTurn(new ArrayBuffer(8), d);
  expect(out.reply).toBe("One. Two. Three. Four. Five. Six.");
  expect(spoken).toHaveLength(6); // every sentence voiced, no coda
});

test("silenceWavLike matches the reference clip's format", () => {
  // canonical 44-byte header: 24kHz mono 16-bit, 100ms of data
  const rate = 24000, samples = 2400;
  const ref = new Uint8Array(tinyWav(Array.from({ length: samples }, () => 0), rate));
  const beat = silenceWavLike(SPEAKER_BEAT_MS, ref.buffer);
  const bv = new DataView(beat);
  expect(bv.getUint32(24, true)).toBe(rate);
  expect(bv.getUint32(40, true)).toBe(Math.round((rate * SPEAKER_BEAT_MS) / 1000) * 2);
  // all-zero PCM = silence
  expect(new Uint8Array(beat).slice(44).every((b) => b === 0)).toBe(true);
});

test("silenceWavLike refuses non-WAV references", () => {
  expect(silenceWavLike(400, new ArrayBuffer(10)).byteLength).toBe(0);
});

test("silenceWavLike rejects allocation-amplifying metadata", () => {
  const badRate = tinyWav([0]);
  const view = new DataView(badRate);
  view.setUint32(24, 1, true);
  view.setUint32(28, 2, true);
  expect(silenceWavLike(SPEAKER_BEAT_MS, badRate).byteLength).toBe(0);

  expect(silenceWavLike(Number.POSITIVE_INFINITY, tinyWav([0])).byteLength).toBe(0);
});

test("silenceWavLike preserves odd-data RIFF padding without treating it as PCM", () => {
  const silence = silenceWavLike(0.125, pcm8Wav(1)); // one 8kHz frame
  const bytes = new Uint8Array(silence);
  const view = new DataView(silence);
  expect(view.getUint32(40, true)).toBe(1);
  expect(silence.byteLength).toBe(46);
  expect(bytes[44]).toBe(128);
  expect(bytes[45]).toBe(0);
});

// A test TTS provider that counts synthesis and lets a test await the Nth call,
// so a swap can be timed to land mid-turn.
class CountingTTS implements TTSProvider {
  calls = 0;
  starts = 0;
  warmups = 0;
  stops = 0;
  healthy = true;
  private waiters: Array<{ n: number; resolve: () => void }> = [];
  constructor(readonly name: string) {}
  async start(): Promise<void> { this.starts += 1; }
  async warmup(): Promise<void> { this.warmups += 1; }
  async health(): Promise<boolean> { return this.healthy; }
  async stop(): Promise<void> { this.stops += 1; }
  async generateAudio(): Promise<ArrayBuffer> {
    this.calls += 1;
    this.waiters = this.waiters.filter((w) => { if (this.calls >= w.n) { w.resolve(); return false; } return true; });
    return tinyWav([1]);
  }
  until(n: number): Promise<void> {
    return new Promise<void>((resolve) => { if (this.calls >= n) resolve(); else this.waiters.push({ n, resolve }); });
  }
}

test("a live TTS swap mid-turn keeps the whole turn on its original provider", async () => {
  const old = new CountingTTS("tts-old");
  const next = new CountingTTS("tts-new");
  const slot = new ProviderSlot<TTSProvider>(old);
  const facade = new SwappableTTSProvider(slot);

  // A brain stream that hands over the second sentence only when we release it,
  // so the swap can be timed to land between the two sentences of one turn.
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((r) => { releaseSecond = r; });
  async function* stream(): AsyncGenerator<string> {
    yield "First sentence. ";
    await secondGate;
    yield "Second sentence.";
  }
  const deps: WebStreamDeps = {
    stt: { transcribe: async () => "" },
    brain: { send: async () => "", sendStream: () => stream() },
    tts: facade,
  };
  const { sink, calls } = capturingSink();
  const turn = streamWebTextTurn("hello", deps, sink);

  // Once the first sentence has synthesized on `old`, swap the live provider.
  await old.until(1);
  const swapping = slot.swap(next, () => {});
  await Bun.sleep(0);
  expect(slot.providerName).toBe("tts-new"); // a NEW turn would get the replacement

  // Let the in-flight turn finish its second sentence.
  releaseSecond();
  await turn;

  // Both sentences of the in-flight turn stayed on the original provider.
  expect(old.calls).toBe(2);
  expect(next.calls).toBe(0);
  expect(calls.audio).toBe(2);

  // The turn released its pin on completion, so the retired generation drains.
  await swapping;
  expect(old.stops).toBe(1);
  await slot.stop();
});
