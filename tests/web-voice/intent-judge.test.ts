import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { processWebTurn, streamWebTurn, streamWebTextTurn, type WebStreamDeps, type WebReplySink } from "../../src/web-voice/turn";

/**
 * The browser is not a second-class capture path. A headless box never starts
 * the host listener at all, so if the veto only ran there it would not run at
 * all in the deployment that most needs it — a browser capturing hands-free
 * picks up exactly the ambient speech this feature exists to decline.
 */

function sink(): WebReplySink & { transcripts: string[]; replies: string[]; done_: boolean } {
  const state = {
    transcripts: [] as string[],
    replies: [] as string[],
    done_: false,
    transcript(text: string) { state.transcripts.push(text); },
    sentence(text: string) { state.replies.push(text); },
    audio() { /* not exercised */ },
    error() { /* not exercised */ },
    done() { state.done_ = true; },
    aborted() { return false; },
  };
  return state as unknown as WebReplySink & { transcripts: string[]; replies: string[]; done_: boolean };
}

function deps(over: Partial<WebStreamDeps> = {}): WebStreamDeps {
  return {
    stt: { transcribe: () => Promise.resolve("deploy production now") },
    brain: { send: () => Promise.resolve("done") },
    tts: { generateAudio: () => Promise.resolve(new ArrayBuffer(0)) },
    ...over,
  } as unknown as WebStreamDeps;
}

const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer;

test("a vetoed browser utterance never reaches the brain", async () => {
  let reachedBrain = false;
  const out = sink();
  await streamWebTurn(WAV, deps({
    brain: { send: () => { reachedBrain = true; return Promise.resolve("done"); } } as unknown as WebStreamDeps["brain"],
    judge: () => Promise.resolve(false),
  }), out);
  expect(reachedBrain).toBe(false);
  // And nothing is announced: the recording wrapper treats any transcript as a
  // completed conversation, so an announced veto is persisted to history and
  // replayed into the brain on the next resume -- the ambient speech would
  // reach the brain after all, just later. The veto is logged, not published.
  expect(out.transcripts).toEqual([]);
  expect(out.done_).toBe(true);
});

test("an accepted browser utterance is dispatched as before", async () => {
  let reachedBrain = false;
  const out = sink();
  await streamWebTurn(WAV, deps({
    brain: { send: () => { reachedBrain = true; return Promise.resolve("done"); } } as unknown as WebStreamDeps["brain"],
    judge: () => Promise.resolve(true),
  }), out);
  expect(reachedBrain).toBe(true);
});

test("with no judge configured every utterance is dispatched", async () => {
  let reachedBrain = false;
  const out = sink();
  await streamWebTurn(WAV, deps({
    brain: { send: () => { reachedBrain = true; return Promise.resolve("done"); } } as unknown as WebStreamDeps["brain"],
  }), out);
  expect(reachedBrain).toBe(true);
});

// The veto can only ever decline a turn, never cause one — so a judge that
// throws must leave the turn exactly as it would have been without one.
test("a judge that throws still takes the turn", async () => {
  let reachedBrain = false;
  const out = sink();
  await streamWebTurn(WAV, deps({
    brain: { send: () => { reachedBrain = true; return Promise.resolve("done"); } } as unknown as WebStreamDeps["brain"],
    judge: () => Promise.reject(new Error("classifier down")),
  }), out);
  expect(reachedBrain).toBe(true);
});

// Someone who types a sentence has already addressed it; judging typed text
// would decline a request that could not possibly be ambient room speech.
test("typed text is never judged", async () => {
  let judged = false;
  let reachedBrain = false;
  const out = sink();
  await streamWebTextTurn("deploy production now", deps({
    brain: { send: () => { reachedBrain = true; return Promise.resolve("done"); } } as unknown as WebStreamDeps["brain"],
    judge: () => { judged = true; return Promise.resolve(false); },
  }), out);
  expect(judged).toBe(false);
  expect(reachedBrain).toBe(true);
});

// The POST path is browser-captured audio too. Wiring only the streaming path
// left the veto off for every non-streaming client.
test("the non-streaming POST path is judged as well", async () => {
  let reachedBrain = false;
  const result = await processWebTurn(WAV, {
    stt: { transcribe: () => Promise.resolve("send him the files") },
    brain: { send: () => { reachedBrain = true; return Promise.resolve("done"); } },
    tts: { generateAudio: () => Promise.resolve(new ArrayBuffer(0)) },
    judge: () => Promise.resolve(false),
  } as unknown as Parameters<typeof processWebTurn>[1]);
  expect(reachedBrain).toBe(false);
  expect(result.reply).toBe("");
  // Reported as nothing heard: the caller persists what it is told, and a
  // vetoed utterance recorded as conversation is replayed into the brain later.
  expect(result.transcript).toBe("");
});

test("the non-streaming POST path still dispatches an accepted turn", async () => {
  let reachedBrain = false;
  await processWebTurn(WAV, {
    stt: { transcribe: () => Promise.resolve("send him the files") },
    brain: { send: () => { reachedBrain = true; return Promise.resolve("done"); } },
    tts: { generateAudio: () => Promise.resolve(new ArrayBuffer(0)) },
    judge: () => Promise.resolve(true),
  } as unknown as Parameters<typeof processWebTurn>[1]);
  expect(reachedBrain).toBe(true);
});

// A classifier can be configured with a deadline in the minutes. If the veto
// does not carry the transport's signal, stopping the daemon leaves it live and
// the web server's shutdown drain waits on it.
test("the transport signal reaches the judge", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  await streamWebTurn(WAV, deps({
    judge: (_transcript: string, signal?: AbortSignal) => { seen = signal; return Promise.resolve(true); },
    signal: controller.signal,
  }), sink());
  expect(seen).toBe(controller.signal);
});

// Both previous rounds shipped a judge option that the daemon never passed at
// one of its call sites. A test that supplies the judge by hand proves the
// seam, not the wiring — so this asserts the wiring itself, at the source.
test("the daemon passes the gate to every browser entry point", () => {
  const source = readFileSync(join(import.meta.dir, "../../src/daemon.ts"), "utf8");
  // processWebTurn (POST /api/turn) and streamWebTurn (WebSocket) both take it.
  const turnCall = source.slice(source.indexOf("onTurn: async (wav, options) => {"));
  expect(turnCall.slice(0, turnCall.indexOf("onTurnProbe")).includes("judge: this.webIntentGate()")).toBe(true);
  const streamCall = source.slice(source.indexOf("onStreamTurn: async (wav, sink, options)"));
  expect(streamCall.slice(0, streamCall.indexOf("onSpeculate")).includes("judge: this.webIntentGate()")).toBe(true);
});

// Cancellation resolves the judge as ACCEPT — failing open is the design — so
// acceptance says nothing about whether the turn is still wanted. Without a
// re-check, an aborted turn walks into the reply path and spends a TTS call
// nobody is waiting for.
test("a turn aborted while the judge is pending spends nothing after it", async () => {
  const controller = new AbortController();
  let synthesized = false;
  let reachedBrain = false;
  const out = sink();
  await streamWebTurn(WAV, deps({
    brain: { send: () => { reachedBrain = true; return Promise.resolve("done"); } } as unknown as WebStreamDeps["brain"],
    tts: { generateAudio: () => { synthesized = true; return Promise.resolve(new ArrayBuffer(0)); } } as unknown as WebStreamDeps["tts"],
    // Aborts mid-decision, then accepts — exactly what a cancelled judge does.
    judge: () => { controller.abort(); return Promise.resolve(true); },
    signal: controller.signal,
  }), out);
  expect(reachedBrain).toBe(false);
  expect(synthesized).toBe(false);
});

test("the POST path also stops after a judge that accepted on cancellation", async () => {
  const controller = new AbortController();
  let reachedBrain = false;
  await processWebTurn(WAV, {
    stt: { transcribe: () => Promise.resolve("details") },
    brain: { send: () => { reachedBrain = true; return Promise.resolve("done"); } },
    tts: { generateAudio: () => Promise.resolve(new ArrayBuffer(0)) },
    judge: () => { controller.abort(); return Promise.resolve(true); },
    signal: controller.signal,
  } as unknown as Parameters<typeof processWebTurn>[1]).catch(() => undefined);
  expect(reachedBrain).toBe(false);
});

// Context for the next verdict, but only what the client could actually hear:
// a reply of "**" is non-empty text that synthesizes to an empty clip.
test("the daemon records only a POST reply that produced audio", () => {
  const source = readFileSync(join(import.meta.dir, "../../src/daemon.ts"), "utf8");
  const turnCall = source.slice(source.indexOf("onTurn: async (wav, options) => {"));
  const body = turnCall.slice(0, turnCall.indexOf("onTurnProbe"));
  expect(body.includes("if (turn.audio.byteLength > 0) this.noteWebSpoken(turn.reply)")).toBe(true);
});

// The hot window means "moments after Cicero FINISHED speaking", and the server
// cannot observe that: the browser plays queued audio well past the turn being
// marked done. Every attempt to track it opened the window at the wrong moment,
// and an open window SKIPS the classifier — the one failure this cannot afford.
test("the browser path never claims a hot window", () => {
  const source = readFileSync(join(import.meta.dir, "../../src/daemon.ts"), "utf8");
  const gate = source.slice(source.indexOf("private webIntentGate("));
  const body = gate.slice(0, gate.indexOf("\n  }"));
  expect(body).toContain("msSinceAssistantSpoke: null");
  // And no resurrected timestamp to measure one from.
  expect(source).not.toContain("webLastSpokeAtMs");
});

// An interrupted reply is still speech the room heard. Left out of context, a
// "yes" answering an interrupted "Should I deploy staging?" is judged with no
// question in view and can be declined as undirected.
test("an interrupted browser reply becomes verdict context", () => {
  const source = readFileSync(join(import.meta.dir, "../../src/daemon.ts"), "utf8");
  const recover = source.slice(source.indexOf("const recover = {"));
  expect(recover.slice(0, recover.indexOf("pending:")).includes("this.noteWebSpoken(spokenPrefix)")).toBe(true);
});
