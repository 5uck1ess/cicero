import type { TTSProvider } from "../backends/tts/provider";
import type { LLMProvider } from "../backends/llm/provider";
import type { Speaker } from "../types";

export interface SpeakRequest {
  text: string;
  agent?: string;        // optional label, e.g. "claude-code"
  skipSummary?: boolean; // if true, speak text verbatim
}

export interface SpeakService {
  speak(req: SpeakRequest): Promise<void>;
  stop(): Promise<void>;
}

export interface SpeakAdapter {
  readonly name: string;
  attach(service: SpeakService): Promise<void>;
  detach(): Promise<void>;
  health(): Promise<{ ok: boolean; reason?: string }>;
}

export interface SpeakServiceDeps {
  llm: LLMProvider;
  tts: TTSProvider;
  speaker: Speaker;
  summaryMaxTokens: number;
}
