import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SwitchboardBrain } from "../../src/brain/switchboard";
import type { Brain } from "../../src/types";
import {
  processWebTurn,
  streamWebTurn,
  type WebStreamDeps,
  type WebReplySink,
  type WebTurnDeps,
} from "../../src/web-voice/turn";

/**
 * `tts_coalesce` was configurable and inert on the web path: the coalescer lives
 * inside StreamingTTSSpeaker.speakStream(), and web voice never goes through the
 * speaker at all — it calls the provider once per sentence. A headless box
 * speaks ONLY through web voice, so the deployment with the most to gain from
 * fewer TTS calls was the one deployment the setting could not reach.
 */

async function* tokens(...parts: string[]) { for (const p of parts) yield p; }

/** Stands in for a hosted engine's per-call latency — see the harness comment. */
const SYNTH_MS = 25;

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
    // Coalescing merges only what has ALREADY queued, so a test whose synthesis
    // returns instantly never gives the rest of the reply a chance to arrive and
    // silently exercises the one-call-per-sentence path instead. This delay is
    // the hosted-engine latency that makes merging happen at all.
    tts: { generateAudio: async (t: string) => { synthesized.push(t); await Bun.sleep(SYNTH_MS); return tinyWav(); } },
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
  let discards = 0;
  const { deps, sink, synthesized, spoken } = harness({
    discardControlTurnVoices: () => { discards += 1; },
  });
  await streamWebTurn(new ArrayBuffer(8), deps, sink);
  expect(synthesized).toEqual(["One.", "Two.", "Three.", "Four.", "Five."]);
  expect(spoken).toEqual(["One.", "Two.", "Three.", "Four.", "Five."]);
  expect(discards).toBe(0);
});

test("coalescing also applies when details replays a stored remainder", async () => {
  const { deps, sink, synthesized, spoken } = harness({
    stt: { transcribe: async () => "details" },
    brain: {
      send: async () => { throw new Error("details must not reach the brain"); },
      sendStream: () => { throw new Error("details must not reach the brain"); },
    },
    tldr: { cap: 4, pending: () => "One. Two. Three. Four. Five." },
    coalesce: { maxChars: 240, passthroughFirst: 1 },
  });
  await streamWebTurn(new ArrayBuffer(8), deps, sink);
  expect(synthesized.length).toBeLessThan(5);
  expect(synthesized.join(" ")).toBe("One. Two. Three. Four. Five.");
  expect(spoken).toEqual(["One.", "Two.", "Three.", "Four.", "Five."]);
});

test("coalescing applies to the single-WAV web turn endpoint", async () => {
  const synthesized: string[] = [];
  const deps: WebTurnDeps = {
    stt: { transcribe: async () => "say five things" },
    brain: { send: async () => "One. Two. Three. Four. Five." },
    tts: {
      generateAudio: async (text: string) => {
        synthesized.push(text);
        await Bun.sleep(SYNTH_MS);
        return tinyWav();
      },
    },
    coalesce: { maxChars: 240, passthroughFirst: 1 },
  };
  await processWebTurn(new ArrayBuffer(8), deps);
  expect(synthesized.length).toBeLessThan(5);
  expect(synthesized.join(" ")).toBe("One. Two. Three. Four. Five.");
});

test("single-WAV details replay still respects the configured chunk cap", async () => {
  const detail = Array.from({ length: 6 }, (_, index) => `Sentence number ${index}.`).join(" ");
  const synthesized: string[] = [];
  const deps: WebTurnDeps = {
    stt: { transcribe: async () => "details" },
    brain: { send: async () => { throw new Error("details must not reach the brain"); } },
    tts: {
      generateAudio: async (text: string) => {
        synthesized.push(text);
        return tinyWav();
      },
    },
    tldr: { cap: 4, pending: () => detail },
    coalesce: { maxChars: 40, passthroughFirst: 1 },
  };
  await processWebTurn(new ArrayBuffer(8), deps);
  expect(synthesized.length).toBeGreaterThan(1);
  expect(synthesized.every((text) => text.length <= 40)).toBe(true);
  expect(synthesized.join(" ")).toBe(detail);
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

// A roll call queues one lane voice per SENTENCE, and the daemon's laneTts
// shifts one off per CALL. A merged chunk therefore speaks two lanes in the
// first one's voice and leaves the third queued — for the next reply, which
// answers in a voice nobody asked for. Control turns are never merged.
test("a control turn is never merged, so the lane voice queue stays in step", async () => {
  const voices = ["lane-a", "lane-b", "lane-c"];
  const usedFor: string[] = [];
  const { deps, sink } = harness({
    brain: {
      send: async () => "",
      sendStream: () => tokens("One. Two. Three."),
      wasControlTurn: () => true,
    },
    // Stands in for laneTts: one queued voice consumed per generateAudio call.
    tts: { generateAudio: async (t: string) => { usedFor.push(`${voices.shift() ?? "NONE"}:${t}`); await Bun.sleep(SYNTH_MS); return tinyWav(); } },
    coalesce: { maxChars: 240, passthroughFirst: 0 },
  } as unknown as Partial<WebStreamDeps>);
  await streamWebTurn(new ArrayBuffer(8), deps, sink);
  // One call per sentence, each drawing the lane voice that sentence belongs to.
  expect(usedFor).toEqual(["lane-a:One.", "lane-b:Two.", "lane-c:Three."]);
  // Nothing left over to leak into the reply after this one.
  expect(voices).toEqual([]);
});

test("a failed coalesced control render cannot leak a lane voice into the next turn", async () => {
  const transcripts = ["roll call", "louder"];
  const usedFor: string[] = [];
  let fail = true;
  const primary: Brain = {
    start: async () => {},
    stop: async () => {},
    send: async () => "Louder.",
    sendStream: () => tokens("Louder."),
    injectContext: () => {},
    restart: async () => {},
    health: async () => true,
  };
  const switchboard = new SwitchboardBrain(primary, {
    coder: { brain: primary, voice: "voice-coder" },
    think: { brain: primary, voice: "voice-think" },
  });
  const { deps, sink } = harness({
    stt: { transcribe: async () => transcripts.shift() ?? "" },
    brain: switchboard,
    tts: {
      generateAudio: async (text: string) => {
        usedFor.push(`${switchboard.activeLaneVoice() ?? "NONE"}:${text}`);
        await Bun.sleep(SYNTH_MS);
        if (fail) {
          fail = false;
          throw new Error("synthesis failed");
        }
        return tinyWav();
      },
    },
    voice: { state: { volume: 1, rate: 1 } },
    coalesce: { maxChars: 240, passthroughFirst: 0 },
    discardControlTurnVoices: switchboard.discardControlTurnVoices.bind(switchboard),
  } as unknown as Partial<WebStreamDeps>);

  await streamWebTurn(new ArrayBuffer(8), deps, sink);
  await streamWebTurn(new ArrayBuffer(8), deps, sink);

  expect(usedFor).toEqual([
    "voice-coder:Coder checking in.",
    "NONE:Louder.",
  ]);
});

// The TLDR cap counts sentences, so a chunk may not straddle it. Codex's case:
// cap 4, one passthrough sentence, then a single seven-sentence chunk — which
// spoke all eight, gated nothing, and emitted no coda.
test("a merged chunk is split at the TLDR cap instead of crossing it", async () => {
  const gated: string[] = [];
  const { deps, sink, synthesized } = harness({
    brain: {
      send: async () => "",
      sendStream: () => tokens("One. Two. Three. Four. Five. Six. Seven. Eight."),
    },
    coalesce: { maxChars: 240, passthroughFirst: 1 },
    tldr: { cap: 4, store: (remainder: string) => { gated.push(remainder); } },
  } as unknown as Partial<WebStreamDeps>);
  await streamWebTurn(new ArrayBuffer(8), deps, sink);
  // Exactly four sentences reach the engine — the same four as with coalescing off.
  const spokenSentences = synthesized.join(" ");
  expect(spokenSentences).toContain("One.");
  expect(spokenSentences).toContain("Four.");
  expect(spokenSentences).not.toContain("Five.");
  expect(spokenSentences).not.toContain("Eight.");
  // And the remainder was gated rather than silently spoken.
  expect(gated.join(" ")).toContain("Five.");
  expect(gated.join(" ")).toContain("Eight.");
});

test("an empty render does not make the rest of its chunk consume the TLDR cap", async () => {
  const gated: string[] = [];
  const { deps, sink, synthesized } = harness({
    coalesce: { maxChars: 240, passthroughFirst: 1 },
    tldr: { cap: 2, store: (remainder: string) => { gated.push(remainder); } },
    tts: {
      generateAudio: async (text: string) => {
        synthesized.push(text);
        await Bun.sleep(SYNTH_MS);
        return text === "Two." ? new ArrayBuffer(0) : tinyWav();
      },
    },
  });
  await streamWebTurn(new ArrayBuffer(8), deps, sink);
  // Empty audio does not count as spoken. The next sentence must get the
  // remaining slot instead of being gated merely because it shared a chunk.
  expect(synthesized).toContain("Three.");
  expect(gated.join(" ")).not.toContain("Three.");
  expect(gated.join(" ")).toContain("Four.");
  expect(gated.join(" ")).toContain("Five.");
});

// A deps field alone is not wiring. Assert every daemon entry point at the
// source rather than supplying the config by hand.
test("the daemon passes the configured coalesce to every browser entry point", () => {
  const source = readFileSync(join(import.meta.dir, "../../src/daemon.ts"), "utf8");
  const singleWavCall = source.slice(source.indexOf("onTurn: async (wav, options)"));
  expect(singleWavCall.slice(0, singleWavCall.indexOf("onTurnProbe")).includes("coalesce: this.config.ttsCoalesce")).toBe(true);
  expect(singleWavCall.slice(0, singleWavCall.indexOf("onTurnProbe")).includes("discardControlTurnVoices")).toBe(true);
  const streamCall = source.slice(source.indexOf("onStreamTurn: async (wav, sink, options)"));
  expect(streamCall.slice(0, streamCall.indexOf("onSpeculate")).includes("coalesce: this.config.ttsCoalesce")).toBe(true);
  expect(streamCall.slice(0, streamCall.indexOf("onSpeculate")).includes("discardControlTurnVoices")).toBe(true);
  const textCall = source.slice(source.indexOf("onTextTurn:"));
  expect(textCall.slice(0, 2_000).includes("coalesce: this.config.ttsCoalesce")).toBe(true);
  expect(textCall.slice(0, 2_000).includes("discardControlTurnVoices")).toBe(true);
});
