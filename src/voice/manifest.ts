import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { VoiceManifest } from "../types";
import { SUPPORTED_VOICE_PROVIDERS, isSupportedVoiceProvider } from "./provider-contract";

export function parseManifest(yaml: string): VoiceManifest {
  const raw = parseYaml(yaml) as Partial<VoiceManifest>;
  if (!raw.name) throw new Error("voice manifest: missing 'name'");
  if (!raw.provider || !isSupportedVoiceProvider(raw.provider)) {
    throw new Error(
      `voice manifest: invalid provider '${raw.provider}' (must be one of ${SUPPORTED_VOICE_PROVIDERS.join(", ")})`,
    );
  }
  if (!raw.source_clip) throw new Error("voice manifest: missing 'source_clip'");
  if (!raw.created_at) throw new Error("voice manifest: missing 'created_at'");
  return raw as VoiceManifest;
}

export function serializeManifest(m: VoiceManifest): string {
  return stringifyYaml(m);
}
