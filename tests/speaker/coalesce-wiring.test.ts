/**
 * The coalescer is only worth anything if it is actually in front of the
 * synthesizer. These tests assert on the text the TTS provider was asked to
 * render — not on bookkeeping — so removing the wrap in speakStream() fails
 * them, and so does forgetting to read the config.
 */
import { test, expect } from "bun:test";
import { StreamingTTSSpeaker } from "../../src/speaker/streaming-tts";
import { createStreamingSpeaker } from "../../src/speaker/index";
import { RuntimeConfig } from "../../src/config";
import type { TTSProvider } from "../../src/backends/tts/provider";
import type { Speaker, CiceroConfig } from "../../src/types";
import type { AudioPlayer } from "../../src/platform/audio";

/** Records every text handed to synthesis. Empty audio → playback is a no-op. */
function recordingProvider(): { provider: TTSProvider; rendered: string[] } {
  const rendered: string[] = [];
  return {
    rendered,
    provider: {
      name: "recording",
      async generateAudio(text: string) { rendered.push(text); return new ArrayBuffer(0); },
      async health() { return true; },
    },
  };
}

const noopPlayer = { async play() {} } as unknown as AudioPlayer;
const noopFallback = { async speak() {}, async health() { return true; }, async stop() {} } as unknown as Speaker;

/**
 * All sentences are available up front, so the coalescer's eager drain sees the
 * whole reply on its first take() — the deterministic best case for merging.
 */
async function* wholeReply(): AsyncGenerator<string> {
  yield "One.";
  yield "Two.";
  yield "Three.";
  yield "Four.";
}

test("speakStream renders one call per sentence when coalescing is off", async () => {
  const { provider, rendered } = recordingProvider();
  const sp = new StreamingTTSSpeaker(provider, noopPlayer, noopFallback);
  await sp.speakStream(wholeReply());
  expect(rendered).toEqual(["One.", "Two.", "Three.", "Four."]);
});

test("speakStream merges available sentences when coalescing is configured", async () => {
  const { provider, rendered } = recordingProvider();
  const sp = new StreamingTTSSpeaker(
    provider,
    noopPlayer,
    noopFallback,
    null,
    undefined,
    { maxChars: 240, passthroughFirst: 1 },
  );
  await sp.speakStream(wholeReply());
  // First sentence alone (first audio is never held back), the rest merged.
  expect(rendered).toEqual(["One.", "Two. Three. Four."]);
});

test("a merged chunk is recorded as one spoken entry, and still reads back verbatim", async () => {
  const { provider } = recordingProvider();
  const sp = new StreamingTTSSpeaker(
    provider,
    noopPlayer,
    noopFallback,
    null,
    undefined,
    { maxChars: 240, passthroughFirst: 1 },
  );
  await sp.speakStream(wholeReply());
  const snap = sp.getSnapshot();
  // Coarser than the uncoalesced ["One.","Two.","Three.","Four."], which is the
  // documented cost. What matters downstream is that the joined text — the form
  // echo rejection consumes — is unchanged.
  expect(snap.spoken).toEqual(["One.", "Two. Three. Four."]);
  expect(snap.spoken.join(" ")).toBe("One. Two. Three. Four.");
});

function configWith(raw: Partial<CiceroConfig>): RuntimeConfig {
  return new RuntimeConfig({ tts_enabled: true, ...raw } as CiceroConfig);
}

test("createStreamingSpeaker leaves coalescing off unless the config enables it", async () => {
  const { provider, rendered } = recordingProvider();
  const sp = createStreamingSpeaker(configWith({}), provider, noopPlayer);
  await sp!.speakStream(wholeReply());
  expect(rendered).toEqual(["One.", "Two.", "Three.", "Four."]);
});

test("createStreamingSpeaker honors passthrough_first from config", async () => {
  const { provider, rendered } = recordingProvider();
  const sp = createStreamingSpeaker(
    configWith({ tts_coalesce: { enabled: true, passthrough_first: 2 } }),
    provider,
    noopPlayer,
  );
  await sp!.speakStream(wholeReply());
  // Two sentences sent alone instead of the default one — the configured value
  // reached the speaker, not just `enabled`.
  expect(rendered).toEqual(["One.", "Two.", "Three. Four."]);
});

test("max_chars from config splits a batch that would otherwise merge whole", async () => {
  const { provider, rendered } = recordingProvider();
  const sp = createStreamingSpeaker(
    configWith({ tts_coalesce: { enabled: true, max_chars: 70 } }),
    provider,
    noopPlayer,
  );
  const sentence = (letter: string): string => letter.repeat(30) + ".";
  await sp!.speakStream(async function* () {
    yield sentence("A");
    yield sentence("B");
    yield sentence("C");
    yield sentence("D");
  }());
  // B+C+D is 95 chars and would arrive as one batch; the cap forces a split, and
  // no chunk exceeds it.
  expect(rendered).toEqual([sentence("A"), `${sentence("B")} ${sentence("C")}`, sentence("D")]);
  for (const chunk of rendered) expect(chunk.length).toBeLessThanOrEqual(70);
});
