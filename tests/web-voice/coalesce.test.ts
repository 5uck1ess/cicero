import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { streamWebTurn, type WebStreamDeps, type WebReplySink } from "../../src/web-voice/turn";

/**
 * `tts_coalesce` was configurable and inert on the web path: the coalescer lives
 * inside StreamingTTSSpeaker.speakStream(), and web voice never goes through the
 * speaker at all — it calls the provider once per sentence. A headless box
 * speaks ONLY through web voice, so the deployment with the most to gain from
 * fewer TTS calls was the one deployment the setting could not reach.
 */

async function* tokens(...parts: string[]) { for (const p of parts) yield p; }

/** A real 24 kHz mono WAV — the reply path validates what the provider returns. */
function tinyWav(samples: number[] = [1], sampleRate = 24_000): ArrayBuffer {
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

function harness(over: Partial<WebStreamDeps> = {}) {
  const synthesized: string[] = [];
  const spoken: string[] = [];
  const sink: WebReplySink = {
    transcript: () => {},
    sentence: (t: string) => spoken.push(t),
    audio: () => {},
    control: () => {},
    done: () => {},
    error: () => {},
    aborted: () => false,
  } as unknown as WebReplySink;
  const deps = {
    stt: { transcribe: async () => "say five things" },
    brain: {
      send: async () => "",
      sendStream: () => tokens("One. Two. Three. Four. Five."),
    },
    tts: { generateAudio: async (t: string) => { synthesized.push(t); return tinyWav(); } },
    ...over,
  } as unknown as WebStreamDeps;
  return { deps, sink, synthesized, spoken };
}

// Codex's exact reproduction: headless + web voice + tts_coalesce enabled, a
// five-sentence reply. Five provider calls before; two after.
test("a configured coalesce merges web-voice synthesis calls", async () => {
  const { deps, sink, synthesized } = harness({
    coalesce: { maxChars: 240, passthroughFirst: 1 },
  });
  await streamWebTurn(new ArrayBuffer(8), deps, sink);
  expect(synthesized.length).toBeLessThan(5);
  // Sentence one still goes alone — coalescing must never sit in front of first audio.
  expect(synthesized[0]).toBe("One.");
  // Nothing is lost, reordered, or split by the merge.
  expect(synthesized.join(" ")).toBe("One. Two. Three. Four. Five.");
});

// The merge is a synthesis-call detail. What the operator reads in the pane,
// and what barge-in would replay, stay one entry per sentence.
test("coalescing does not change what the transcript pane shows", async () => {
  const { deps, sink, spoken } = harness({
    coalesce: { maxChars: 240, passthroughFirst: 1 },
  });
  await streamWebTurn(new ArrayBuffer(8), deps, sink);
  expect(spoken).toEqual(["One.", "Two.", "Three.", "Four.", "Five."]);
});

// Off by default, and the default is one call per sentence — the behavior every
// existing web-voice test asserts.
test("with no coalesce configured every sentence is its own call", async () => {
  const { deps, sink, synthesized, spoken } = harness();
  await streamWebTurn(new ArrayBuffer(8), deps, sink);
  expect(synthesized).toEqual(["One.", "Two.", "Three.", "Four.", "Five."]);
  expect(spoken).toEqual(["One.", "Two.", "Three.", "Four.", "Five."]);
});

// A cap small enough to admit no merge must still emit every sentence exactly
// once, rather than dropping the ones that would not fit.
test("a cap that admits no merge still speaks every sentence", async () => {
  const { deps, sink, synthesized } = harness({
    coalesce: { maxChars: 1, passthroughFirst: 0 },
  });
  await streamWebTurn(new ArrayBuffer(8), deps, sink);
  expect(synthesized).toEqual(["One.", "Two.", "Three.", "Four.", "Five."]);
});

// The option existing is not the option working. Both previous features in this
// repo shipped a deps field the daemon never passed at one of its two web-voice
// call sites, so this asserts the wiring at the source rather than supplying
// the config by hand.
test("the daemon passes the configured coalesce to every browser entry point", () => {
  const source = readFileSync(join(import.meta.dir, "../../src/daemon.ts"), "utf8");
  const streamCall = source.slice(source.indexOf("onStreamTurn: async (wav, sink, options)"));
  expect(streamCall.slice(0, streamCall.indexOf("onSpeculate")).includes("coalesce: this.config.ttsCoalesce")).toBe(true);
  const textCall = source.slice(source.indexOf("onTextTurn:"));
  expect(textCall.slice(0, 2_000).includes("coalesce: this.config.ttsCoalesce")).toBe(true);
});
