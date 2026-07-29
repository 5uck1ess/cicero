import { expect, test } from "bun:test";
import { streamWebTurn, streamWebTextTurn, type WebStreamDeps, type WebReplySink } from "../../src/web-voice/turn";

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
  // The client still sees what was heard, so a veto is visible rather than silent.
  expect(out.transcripts).toContain("deploy production now");
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
