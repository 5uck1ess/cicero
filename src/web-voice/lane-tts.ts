import { pinGeneration, type GenerationPin } from "../backends/hot-swap";
import { speakable } from "../speaker/speakable";
import type { TTSProvider } from "../backends/tts/provider";

/** The narrow TTS surface a web turn holds: synthesis plus a pinnable generation. */
export type LaneTTS = Pick<TTSProvider, "generateAudio"> & {
  pinGeneration(): GenerationPin<Pick<TTSProvider, "generateAudio">>;
};

/**
 * Wrap the daemon's TTS provider for web turns. Every spoken sentence funnels
 * through here so Markdown/typography is stripped once (a voice never says
 * "dash" or glitches on an em-dash) and the active lane's voice is applied. A
 * sentence that is pure markup flattens to nothing and is skipped without
 * consuming a roll-call voice slot.
 *
 * The wrapper MUST forward `pinGeneration` as well as `generateAudio`. A turn
 * pins the object it was handed, not the provider behind it, so a wrapper that
 * only forwards synthesis silently degrades every pin to a no-op — and a live
 * provider swap could then render sentence one of a reply on the old provider
 * and sentence two on the new one.
 */
export function createLaneTts(
  provider: Pick<TTSProvider, "generateAudio">,
  laneVoice: () => string | undefined,
): LaneTTS {
  const speak = (source: Pick<TTSProvider, "generateAudio">) =>
    (text: string, _voice?: string, options?: { speed?: number }): Promise<ArrayBuffer> => {
      const clean = speakable(text);
      if (!clean) return Promise.resolve(new ArrayBuffer(0));
      return source.generateAudio(clean, laneVoice(), options);
    };
  return {
    generateAudio: speak(provider),
    pinGeneration: () => {
      const pin = pinGeneration(provider);
      return {
        provider: { generateAudio: speak(pin.provider) },
        release: () => pin.release(),
      };
    },
  };
}
