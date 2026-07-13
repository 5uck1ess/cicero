import type { VoiceProvider } from "../types";

export type VoiceActivation = "reference" | "voice-id";
export type VoiceProvisioning = "local-reference" | "cloud-upload";

export interface VoiceProviderContract {
  provider: VoiceProvider;
  ttsBackend: VoiceProvider;
  activation: VoiceActivation;
  provisioning: VoiceProvisioning;
  derivativeFile: string;
  maxReferenceSeconds: number;
  sampleRate: number | null;
  /** Local HTTP port when this provider owns a server; null for cloud APIs. */
  defaultPort: number | null;
  /** Provider-native health endpoint; null when readiness is not a local HTTP probe. */
  healthPath: string | null;
  runtime: "local-binary" | "local-python" | "cloud";
  supportsLibraryOverride: boolean;
}

export const AUDIOCPP_MAX_REFERENCE_SECONDS = 18;
// pocket-tts conditions on the reference inside an 18s window, and references
// landing within ~0.5s of that edge poison the conditioning: renders whisper
// or drop the first word, or insert junk syllables (a stray "or <name>"). Reproduced
// live 2026-07-12 — 17.995s and 18.000s references failed 5/13 renders while
// 17.5s and shorter were clean 16/16 on identical audio. Usable references
// therefore stay at or under this trim target; longer ones are cut down to it.
export const AUDIOCPP_REFERENCE_TRIM_SECONDS = 17.5;

export const SUPPORTED_VOICE_PROVIDERS = [
  "audiocpp",
  "pocket-tts",
  "vibevoice",
  "elevenlabs",
] as const satisfies readonly VoiceProvider[];

const CONTRACTS: Record<VoiceProvider, VoiceProviderContract> = {
  audiocpp: {
    provider: "audiocpp",
    ttsBackend: "audiocpp",
    activation: "reference",
    provisioning: "local-reference",
    derivativeFile: "trimmed-18s.wav",
    maxReferenceSeconds: AUDIOCPP_MAX_REFERENCE_SECONDS,
    sampleRate: null,
    defaultPort: 8092,
    healthPath: "/v1/models",
    runtime: "local-binary",
    supportsLibraryOverride: true,
  },
  "pocket-tts": {
    provider: "pocket-tts",
    ttsBackend: "pocket-tts",
    activation: "reference",
    provisioning: "local-reference",
    derivativeFile: "trimmed-mono.wav",
    maxReferenceSeconds: 30,
    sampleRate: null,
    defaultPort: 8082,
    healthPath: "/v1/models",
    runtime: "local-python",
    supportsLibraryOverride: true,
  },
  vibevoice: {
    provider: "vibevoice",
    ttsBackend: "vibevoice",
    activation: "reference",
    provisioning: "local-reference",
    derivativeFile: "trimmed-16k-mono.wav",
    maxReferenceSeconds: 30,
    sampleRate: 16_000,
    defaultPort: 8082,
    healthPath: "/v1/health",
    runtime: "local-python",
    supportsLibraryOverride: true,
  },
  elevenlabs: {
    provider: "elevenlabs",
    ttsBackend: "elevenlabs",
    activation: "voice-id",
    provisioning: "cloud-upload",
    derivativeFile: "upload-16k-mono.wav",
    maxReferenceSeconds: 120,
    sampleRate: 16_000,
    defaultPort: null,
    healthPath: null,
    runtime: "cloud",
    supportsLibraryOverride: true,
  },
};

export function isSupportedVoiceProvider(value: string): value is VoiceProvider {
  return (SUPPORTED_VOICE_PROVIDERS as readonly string[]).includes(value);
}

export function voiceProviderContract(provider: string): VoiceProviderContract {
  if (!isSupportedVoiceProvider(provider)) {
    throw new Error(
      `unsupported voice provider '${provider}' (supported: ${SUPPORTED_VOICE_PROVIDERS.join(", ")})`,
    );
  }
  return CONTRACTS[provider];
}

export function voiceProviderContractForBackend(backend: string | undefined): VoiceProviderContract | null {
  if (!backend || !isSupportedVoiceProvider(backend)) return null;
  return CONTRACTS[backend];
}
