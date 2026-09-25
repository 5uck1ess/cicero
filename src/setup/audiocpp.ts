import { join } from "node:path";

export const AUDIOCPP_PORT = 8092;
export const AUDIOCPP_MODELS = {
  stt: { id: "nemotron", directory: "nemotron-3.5-asr-streaming-0.6b" },
  tts: { id: "pocket-tts", directory: "pocket-tts" },
} as const;

export function audioCppModelPath(root: string, kind: "stt" | "tts"): string {
  return join(root, "vendor", "audio.cpp", "models", AUDIOCPP_MODELS[kind].directory);
}
