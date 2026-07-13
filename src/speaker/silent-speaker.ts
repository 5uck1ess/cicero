import type { Speaker } from "../types";

export class SilentSpeaker implements Speaker {
  async speak(_text: string): Promise<void> {
    // No-op
  }
  async stop(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}
