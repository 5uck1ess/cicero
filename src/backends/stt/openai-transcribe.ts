import { sttVocabularyPrompt, type STTProviderConfig } from "./provider";
import { CloudHttpSttProvider, type CloudSttDeps } from "./cloud-http";
import { whisperLanguageCode } from "./language";
import { providerSignal } from "../http-transfer";

/** `/audio/transcriptions` base for each OpenAI-shaped cloud recognizer. */
export const OPENAI_TRANSCRIBE_BASES: Readonly<Record<string, string>> = Object.freeze({
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
});

/**
 * OpenAI-shaped multipart transcription for OpenAI, Groq (Whisper), and
 * Mistral (Voxtral). The three agree on `file`, `model`, `language`, and a
 * top-level `text` in the reply. Mistral has no `prompt` field, so vocabulary
 * is sent only where the endpoint accepts it.
 */
export class OpenAiTranscribeProvider extends CloudHttpSttProvider {
  private readonly baseUrl: string;
  private readonly prompt?: string;

  constructor(backend: "openai" | "groq" | "mistral", config: STTProviderConfig, deps?: CloudSttDeps) {
    super(backend, config, deps);
    this.baseUrl = OPENAI_TRANSCRIBE_BASES[backend]!;
    this.prompt = backend === "mistral" ? undefined : sttVocabularyPrompt(config.vocabulary);
  }

  protected request(audio: Blob, signal: AbortSignal | undefined): Promise<Response> {
    const form = new FormData();
    form.append("file", audio, "audio.wav");
    form.append("model", this.model);
    if (this.name !== "mistral") form.append("response_format", "json");
    if (this.language) form.append("language", whisperLanguageCode(this.language));
    if (this.prompt) form.append("prompt", this.prompt);
    return this.fetcher(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: providerSignal(this.timeoutMs, signal),
    });
  }

  protected transcriptFrom(body: unknown): string | null {
    const text = (body as { text?: unknown })?.text;
    return typeof text === "string" ? text : null;
  }
}
