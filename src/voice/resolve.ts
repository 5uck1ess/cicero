import type { CiceroConfig, VoiceManifest } from "../types";
import { voiceProviderContract } from "./provider-contract";

/** Persisted fields replaced as one activation unit by `cicero voice use`. */
export const VOICE_CONFIG_REPLACE_KEYS = [
  "tts",
  "voice_ref_audio",
  "voice_ref_text",
] as const satisfies readonly (keyof CiceroConfig)[];

export const VOICE_CONFIG_PRESERVE_WHEN_SAME = [
  { key: "tts", discriminator: "backend" },
] as const;

export const VOICE_CONFIG_CLEAR_NESTED = [
  { key: "tts", fields: ["voice", "refAudio", "refText"] },
] as const;

/**
 * Map an active voice manifest to the concrete config fields the TTS layer
 * consumes. Local providers (VibeVoice) resolve to a reference clip; cloud
 * providers (ElevenLabs) resolve to a TTS backend + voice_id.
 *
 * `voice use` writes these into config.yaml so `RuntimeConfig.ttsBackend`
 * picks them up without coupling `loadConfig` to the voice library.
 */
export function voiceToConfigFields(m: VoiceManifest): Partial<CiceroConfig> {
  const contract = voiceProviderContract(m.provider);
  if (contract.activation === "voice-id") {
    if (!m.voice_id?.trim()) {
      throw new Error(`voice '${m.name}' is missing its ${m.provider} voice_id; add it again to reprovision`);
    }
    return {
      voice: m.name,
      tts: { backend: contract.ttsBackend, voice: m.voice_id },
    };
  }
  const reference = m.trimmed_clip ?? m.source_clip;
  return {
    voice: m.name,
    voice_ref_audio: reference,
    voice_ref_text: m.ref_text,
    tts: {
      backend: contract.ttsBackend,
      voice: m.name,
      refAudio: reference,
      refText: m.ref_text,
    },
  };
}
