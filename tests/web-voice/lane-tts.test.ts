import { describe, expect, test } from "bun:test";
import { createLaneTts } from "../../src/web-voice/lane-tts";
import { ProviderSlot, SwappableTTSProvider } from "../../src/backends/hot-swap";
import type { TTSProvider } from "../../src/backends/tts/provider";

class RecordingTTS implements TTSProvider {
  readonly spoken: string[] = [];
  readonly voices: (string | undefined)[] = [];
  constructor(readonly name: string) {}
  async health(): Promise<boolean> { return true; }
  async stop(): Promise<void> {}
  async generateAudio(text: string, voice?: string): Promise<ArrayBuffer> {
    this.spoken.push(text);
    this.voices.push(voice);
    return new TextEncoder().encode(`${this.name}:${text}`).buffer as ArrayBuffer;
  }
}

const decode = (audio: ArrayBuffer): string => new TextDecoder().decode(audio);

describe("web-voice lane TTS wrapper", () => {
  test("strips markup and applies the active lane voice", async () => {
    const provider = new RecordingTTS("a");
    const lane = createLaneTts(provider, () => "butler");

    const audio = await lane.generateAudio("**Ready** to go");
    expect(provider.spoken).toEqual(["Ready to go"]);
    expect(provider.voices).toEqual(["butler"]);
    expect(decode(audio)).toBe("a:Ready to go");
  });

  test("a sentence that is pure markup synthesizes nothing", async () => {
    const provider = new RecordingTTS("a");
    const lane = createLaneTts(provider, () => undefined);

    const audio = await lane.generateAudio("***");
    expect(audio.byteLength).toBe(0);
    expect(provider.spoken).toEqual([]);
  });

  // The regression Codex caught: a wrapper that forwards only generateAudio makes
  // every turn's pinGeneration() a silent no-op, so a live swap splices two
  // providers into one reply. The wrapper is what web turns actually hold.
  test("forwards pinGeneration, so a mid-reply swap cannot change provider", async () => {
    const first = new RecordingTTS("first");
    const second = new RecordingTTS("second");
    const slot = new ProviderSlot<TTSProvider>(first);
    const lane = createLaneTts(new SwappableTTSProvider(slot), () => undefined);

    // A turn begins: it pins the generation it started on.
    const pin = lane.pinGeneration();
    expect(decode(await pin.provider.generateAudio("one"))).toBe("first:one");

    // A swap cuts over mid-reply. It cannot complete until the pin releases.
    let swapped = false;
    const swapping = slot.swap(second, () => {}).then(() => { swapped = true; });
    await Bun.sleep(0); // let the candidate prepare and cut over
    expect(slot.providerName).toBe("second");
    expect(swapped).toBe(false); // but it cannot finish while the pin is held

    // Sentence two of the SAME reply still renders on the original provider...
    expect(decode(await pin.provider.generateAudio("two"))).toBe("first:two");
    // ...while an unpinned call (a later turn) already sees the replacement.
    expect(decode(await lane.generateAudio("next turn"))).toBe("second:next turn");

    pin.release();
    await swapping;
    expect(swapped).toBe(true);
    expect(first.spoken).toEqual(["one", "two"]);
    expect(second.spoken).toEqual(["next turn"]);
  });

  test("the lane's markup stripping still applies through a pin", async () => {
    const provider = new RecordingTTS("a");
    const slot = new ProviderSlot<TTSProvider>(provider);
    const lane = createLaneTts(new SwappableTTSProvider(slot), () => "butler");

    const pin = lane.pinGeneration();
    await pin.provider.generateAudio("**Pinned** and clean");
    pin.release();

    expect(provider.spoken).toEqual(["Pinned and clean"]);
    expect(provider.voices).toEqual(["butler"]);
  });
});
