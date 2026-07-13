import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ciceroPath } from "../platform/paths";
import type { VoiceManifest, VoiceProvider } from "../types";
import { parseManifest } from "./manifest";
import { voiceProviderContract } from "./provider-contract";

export interface ResolvedLibraryVoice {
  manifest: VoiceManifest;
  reference?: string;
  voiceId?: string;
}

/** Resolve a voice-library name without silently crossing provider contracts. */
export function resolveLibraryVoice(
  expectedProvider: VoiceProvider,
  name: string,
  root = ciceroPath("voices"),
): ResolvedLibraryVoice | null {
  if (!name || basename(name) !== name || name === "." || name === "..") {
    throw new Error(`invalid voice-library name '${name}'`);
  }
  const manifestPath = join(root, name, "voice.yaml");
  if (!existsSync(manifestPath)) return null;

  const manifest = parseManifest(readFileSync(manifestPath, "utf-8"));
  if (manifest.provider !== expectedProvider) {
    throw new Error(
      `voice '${name}' belongs to provider '${manifest.provider}', not '${expectedProvider}'`,
    );
  }

  const contract = voiceProviderContract(manifest.provider);
  if (!contract.supportsLibraryOverride) {
    throw new Error(`${manifest.provider} does not support per-call voice-library overrides`);
  }
  if (contract.activation === "voice-id") {
    if (!manifest.voice_id?.trim()) {
      throw new Error(`voice '${name}' is missing its ${manifest.provider} voice_id`);
    }
    return { manifest, voiceId: manifest.voice_id };
  }

  const reference = manifest.trimmed_clip ?? manifest.source_clip;
  if (!existsSync(reference)) {
    throw new Error(`voice '${name}' is missing its provisioned reference '${reference}'`);
  }
  return { manifest, reference };
}

export function requireLibraryReference(
  provider: Exclude<VoiceProvider, "elevenlabs">,
  name: string,
  root?: string,
): { reference: string; refText?: string } {
  const resolved = resolveLibraryVoice(provider, name, root);
  if (!resolved?.reference) {
    throw new Error(`${provider}: no provisioned voice '${name}' in the library`);
  }
  return { reference: resolved.reference, refText: resolved.manifest.ref_text };
}
