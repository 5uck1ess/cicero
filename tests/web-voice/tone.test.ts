import { test, expect } from "bun:test";
import { toneTag, settleTone, wavDurationMs, type ToneOptions } from "../../src/web-voice/tone";
import { streamWebTurn, processWebTurn, type WebReplySink } from "../../src/web-voice/turn";
import { makeSpeculator, pcmToWav } from "../../src/web-voice/speculative";
import { isLocalFastPath } from "../../src/web-voice/turn";

// ---------------------------------------------------------------- tag policy

test("toneTag: informative verdicts become a self-explanatory parenthetical", () => {
  expect(toneTag({ label: "happy", score: 0.99 })).toBe(
    "(Voice analysis: the user's tone of voice sounds happy.)",
  );
  expect(toneTag({ label: "angry", score: 0.6 })).toContain("angry");
});

test("toneTag: bilingual FunASR labels keep the English half", () => {
  expect(toneTag({ label: "生气/angry", score: 0.9 })).toContain("sounds angry.");
});

test("toneTag: neutral / catch-all / low-confidence / missing verdicts stay silent", () => {
  expect(toneTag(null)).toBeNull();
  expect(toneTag({ label: "neutral", score: 1.0 })).toBeNull();
  expect(toneTag({ label: "中立/neutral", score: 1.0 })).toBeNull();
  expect(toneTag({ label: "other", score: 0.9 })).toBeNull();
  expect(toneTag({ label: "<unk>", score: 0.9 })).toBeNull();
  expect(toneTag({ label: "sad", score: 0.3 })).toBeNull();      // below default 0.5
  expect(toneTag({ label: "sad", score: 0.6, }, 0.7)).toBeNull(); // below explicit floor
  expect(toneTag({ label: "", score: 0.9 })).toBeNull();
});

test("settleTone: a fast verdict lands, a slow one is dropped at the grace window", async () => {
  expect(await settleTone(null)).toBeNull();
  expect(await settleTone(Promise.resolve("TAG"), 50)).toBe("TAG");
  expect(await settleTone(Bun.sleep(500).then(() => "TAG"), 30)).toBeNull();
});

// ------------------------------------------------------- pipeline integration

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

const silentWav = () => pcmToWav(new Float32Array(16000), 16000).buffer as ArrayBuffer;
const synthesizedWav = () => pcmToWav(new Float32Array([0]), 16000).buffer as ArrayBuffer;

function streamDeps(transcript: string, brainInputs: string[], tone?: ToneOptions) {
  return {
    stt: { transcribe: async () => transcript },
    brain: {
      send: async (m: string) => { brainInputs.push(m); return "Okay."; },
      sendStream: (m: string) => { brainInputs.push(m); return (async function* () { yield "Okay."; })(); },
    },
    tts: { generateAudio: async () => synthesizedWav() },
    tone,
  };
}

test("streamWebTurn: the tag rides into the brain input, not the shown transcript", async () => {
  const brainInputs: string[] = [];
  const tone: ToneOptions = { tag: async () => "(Voice analysis: the user's tone of voice sounds angry.)" };
  const { sink, calls } = capturingSink();
  await streamWebTurn(silentWav(), streamDeps("why is this broken again", brainInputs, tone), sink);
  expect(brainInputs).toEqual(["why is this broken again\n\n(Voice analysis: the user's tone of voice sounds angry.)"]);
  expect(calls.transcript).toEqual(["why is this broken again"]); // display stays clean
});

test("streamWebTurn: an uninformative (null) verdict leaves the input untouched", async () => {
  const brainInputs: string[] = [];
  const { sink } = capturingSink();
  await streamWebTurn(silentWav(), streamDeps("hello there", brainInputs, { tag: async () => null }), sink);
  expect(brainInputs).toEqual(["hello there"]);
});

test("streamWebTurn: a verdict slower than the grace window is dropped, not waited for", async () => {
  const brainInputs: string[] = [];
  const tone: ToneOptions = { tag: () => Bun.sleep(1000).then(() => "(late tag)"), graceMs: 30 };
  const { sink } = capturingSink();
  const t0 = performance.now();
  await streamWebTurn(silentWav(), streamDeps("hello there", brainInputs, tone), sink);
  expect(brainInputs).toEqual(["hello there"]);
  expect(performance.now() - t0).toBeLessThan(800); // never stalled on the slow classifier
});

test("streamWebTurn retains a grace-window loser in the transport drain", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let toneFinished = false;
  let tracked: Promise<void> | null = null;
  const deps = streamDeps("hello there", [], {
    graceMs: 5,
    tag: async () => {
      try {
        await gate;
        toneFinished = true;
        return "(late tag)";
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
  });
  deps.trackBackground = (task) => { tracked = task; return true; };
  const { sink } = capturingSink();

  await streamWebTurn(silentWav(), deps, sink);
  expect(tracked).not.toBeNull();
  expect(toneFinished).toBe(false);
  release();
  await tracked!;
  expect(toneFinished).toBe(true);
});

test("processWebTurn retains tone work when an empty transcript returns early", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let tracked: Promise<void> | null = null;
  let toneFinished = false;
  const deps = streamDeps("", [], {
    tag: async () => {
      try {
        await gate;
        toneFinished = true;
        return null;
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
  });
  deps.trackBackground = (task) => { tracked = task; return true; };

  const result = await processWebTurn(silentWav(), deps);
  expect(result.transcript).toBe("");
  expect(tracked).not.toBeNull();
  expect(toneFinished).toBe(false);
  release();
  await tracked!;
  expect(toneFinished).toBe(true);
});

test("streamWebTurn: local fast-paths answer above the brain — tone never reaches them", async () => {
  const brainInputs: string[] = [];
  const deps = { ...streamDeps("louder", brainInputs, { tag: async () => "(tag)" }), voice: { state: { volume: 1, rate: 1 } } };
  const { sink, calls } = capturingSink();
  await streamWebTurn(silentWav(), deps, sink);
  expect(brainInputs).toEqual([]); // voice control handled locally
  expect(calls.done).toBe(1);
});

test("processWebTurn: the non-streaming path (call bridge) tags the same way", async () => {
  const brainInputs: string[] = [];
  const tone: ToneOptions = { tag: async () => "(Voice analysis: the user's tone of voice sounds sad.)" };
  const result = await processWebTurn(silentWav(), streamDeps("i lost the file", brainInputs, tone));
  expect(result.transcript).toBe("i lost the file");
  expect(brainInputs[0]).toContain("sounds sad.");
});

test("speculative: the probe tail's tone tags the speculative brain input", async () => {
  const brainInputs: string[] = [];
  const spec = makeSpeculator({
    stt: { transcribe: async () => "this thing keeps crashing" },
    brain: { sendStream: (m: string) => { brainInputs.push(m); return (async function* () { yield "On it."; })(); } },
    isLocalFastPath,
    minProbability: 0.85,
    tone: { tag: async () => "(Voice analysis: the user's tone of voice sounds angry.)" },
  });
  const turn = spec(new Float32Array(16000), 16000, 1000, 0.95)!;
  expect(turn.claim()).toBe(true);
  expect(await turn.transcript()).toBe("this thing keeps crashing"); // adoption path shows the clean transcript
  expect(brainInputs).toEqual(["this thing keeps crashing\n\n(Voice analysis: the user's tone of voice sounds angry.)"]);
  await turn.abort();
});

test("wavDurationMs reads the header; junk reads as 0 (gate skips it)", () => {
  // 16kHz mono 16-bit → byteRate 32000; 32000 data bytes = exactly 1s
  const buf = new Uint8Array(44 + 32000);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(28, 32000, true);      // byte rate
  expect(wavDurationMs(buf)).toBe(1000);
  expect(wavDurationMs(buf.slice(0, 44 + 8000))).toBe(250);
  expect(wavDurationMs(new Uint8Array(10))).toBe(0);          // too short to be a WAV
  expect(wavDurationMs(new Uint8Array(64))).toBe(0);          // no RIFF magic
  const zeroRate = new Uint8Array(64);
  new DataView(zeroRate.buffer).setUint32(0, 0x52494646, false);
  expect(wavDurationMs(zeroRate)).toBe(0);                    // divide-by-zero guard
});
