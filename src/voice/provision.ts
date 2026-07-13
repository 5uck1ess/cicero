import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { inspectWav, trimWav } from "./audio-utils";
import type { VoiceManifest } from "../types";
import {
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
} from "../platform/secure-storage";
import { voiceProviderContract } from "./provider-contract";
import {
  PROVIDER_TIMEOUT_MS,
  providerSignal,
  readBoundedJson,
  readErrorDetail,
} from "../backends/http-transfer";

export interface ProvisionArgs {
  name: string;
  provider: string;
  source_clip: string;
  targetDir: string; // the voice's dir under ~/.cicero/voices/<name>/
  ref_text?: string;
}

/**
 * Provision a voice for a provider: copy + trim the reference clip, then do any
 * provider-specific work (cloud upload → voice_id). Returns the completed
 * manifest. Throws with an actionable message on any failure.
 */
export async function provisionVoice(args: ProvisionArgs): Promise<VoiceManifest> {
  // Unsupported names fail before any source/target I/O or cloud request.
  const contract = voiceProviderContract(args.provider);
  if (!existsSync(args.source_clip)) {
    throw new Error(`source clip not found: ${args.source_clip}`);
  }

  const uploadKey = contract.provisioning === "cloud-upload"
    ? process.env.ELEVENLABS_API_KEY
    : undefined;
  if (contract.provisioning === "cloud-upload" && !uploadKey) {
    throw new Error("ELEVENLABS_API_KEY env var must be set for the elevenlabs provider");
  }

  ensurePrivateDirectorySync(args.targetDir);
  const trimmedPath = join(args.targetDir, contract.derivativeFile);
  const sourceCopy = join(args.targetDir, basename(args.source_clip));
  await Bun.write(sourceCopy, Bun.file(args.source_clip));
  ensurePrivateFileSync(sourceCopy);
  await trimWav(
    args.source_clip,
    trimmedPath,
    contract.maxReferenceSeconds,
    contract.sampleRate,
  );
  ensurePrivateFileSync(trimmedPath);
  const info = await inspectWav(trimmedPath);

  const base: VoiceManifest = {
    name: args.name,
    provider: contract.provider,
    source_clip: sourceCopy,
    trimmed_clip: trimmedPath,
    sample_rate: info.sampleRate,
    duration_s: info.duration_s,
    ref_text: args.ref_text,
    created_at: new Date().toISOString(),
  };

  switch (contract.provider) {
    case "audiocpp":
    case "pocket-tts":
    case "vibevoice":
      // Purely local — the manifest is complete after trim + inspect.
      return base;

    case "elevenlabs": {
      if (!uploadKey) throw new Error("ELEVENLABS_API_KEY disappeared before upload");
      const form = new FormData();
      form.append("name", args.name);
      const uploadName = basename(trimmedPath);
      const upload = new File([await Bun.file(trimmedPath).arrayBuffer()], uploadName, {
        type: "audio/wav",
      });
      form.append("files", upload, uploadName);
      const res = await fetch("https://api.elevenlabs.io/v1/voices/add", {
        method: "POST",
        headers: { "xi-api-key": uploadKey },
        body: form,
        signal: providerSignal(PROVIDER_TIMEOUT_MS.voiceProvision),
      });
      if (!res.ok) {
        const detail = await readErrorDetail(res);
        throw new Error(`ElevenLabs voice upload failed (${res.status})${detail ? `: ${detail}` : ""}`);
      }
      const data = await readBoundedJson<{ voice_id?: unknown }>(res);
      if (typeof data.voice_id !== "string" || !data.voice_id.trim()) {
        throw new Error("ElevenLabs voice upload succeeded without returning a voice_id");
      }
      return { ...base, voice_id: data.voice_id };
    }

  }
}
