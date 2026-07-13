import { summarizeForTTS } from "../summarizer";
import type { SpeakRequest, SpeakService, SpeakServiceDeps } from "./types";

export class DefaultSpeakService implements SpeakService {
  constructor(private deps: SpeakServiceDeps) {}

  async speak(req: SpeakRequest): Promise<void> {
    const text = req.skipSummary
      ? req.text
      : await summarizeForTTS(req.text, this.deps.llm, { maxTokens: this.deps.summaryMaxTokens });
    await this.deps.speaker.speak(text);
  }

  async stop(): Promise<void> {
    await this.deps.speaker.stop();
  }
}
