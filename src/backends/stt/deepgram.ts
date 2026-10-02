import type { STTProviderConfig } from "./provider";
import { CloudHttpSttProvider, type CloudSttDeps } from "./cloud-http";
import { providerSignal } from "../http-transfer";

export const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";
/** Deepgram caps keyterm prompting at roughly 500 tokens; keep the query bounded. */
const MAX_KEYTERMS = 100;

/**
 * Deepgram pre-recorded transcription: the finished utterance's WAV goes up
 * as the raw request body (the RIFF header tells Deepgram the format), and the
 * transcript is at `results.channels[0].alternatives[0].transcript`.
 */
export class DeepgramSTTProvider extends CloudHttpSttProvider {
  constructor(config: STTProviderConfig, deps?: CloudSttDeps) {
    super("deepgram", config, deps);
  }

  protected request(audio: Blob, signal: AbortSignal | undefined): Promise<Response> {
    const query = new URLSearchParams({ model: this.model, smart_format: "true" });
    if (this.language) query.set("language", this.language);
    // Nova-3 takes vocabulary as keyterm; older models (Nova-2 and earlier)
    // only understand keywords. One repeated parameter per term either way.
    const channel = this.model.startsWith("nova-3") ? "keyterm" : "keywords";
    for (const term of this.vocabulary.slice(0, MAX_KEYTERMS)) query.append(channel, term);
    return this.fetcher(`${DEEPGRAM_LISTEN_URL}?${query}`, {
      method: "POST",
      headers: { Authorization: `Token ${this.apiKey}`, "Content-Type": "audio/wav" },
      body: audio,
      signal: providerSignal(this.timeoutMs, signal),
    });
  }

  protected transcriptFrom(body: unknown): string | null {
    const alternative = (body as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: unknown }> }> } })
      ?.results?.channels?.[0]?.alternatives?.[0];
    return typeof alternative?.transcript === "string" ? alternative.transcript : null;
  }
}
