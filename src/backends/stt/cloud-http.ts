import type { STTProvider, STTProviderConfig, STTTranscriptionResult } from "./provider";
import {
  checkCloudSpeechKey,
  cloudSpeechApiKey,
  cloudSpeechBackend,
  scrubProviderText,
  type CloudSpeechBackend,
} from "../cloud-speech";
import { log } from "../../logger";
import { encodeWav } from "../../platform/wav";
import {
  PROVIDER_RESPONSE_LIMIT_BYTES,
  PROVIDER_TIMEOUT_MS,
  readBoundedJson,
  readErrorDetail,
  requestTimeout,
} from "../http-transfer";

/** Largest utterance a cloud recognizer is sent; a voice turn is far below this. */
export const MAX_CLOUD_STT_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface CloudSttDeps {
  fetcher?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/**
 * Shared shape for the request/response cloud recognizers: one finished
 * utterance in, one transcript out. Subclasses build the request and read the
 * transcript; key handling, bounds, error scrubbing, and the quiet
 * {@link STTProvider.transcribeResult} contract live here once.
 */
export abstract class CloudHttpSttProvider implements STTProvider {
  readonly name: string;
  protected readonly entry: CloudSpeechBackend;
  protected readonly apiKey: string;
  protected readonly model: string;
  protected readonly language?: string;
  protected readonly vocabulary: readonly string[];
  protected readonly timeoutMs: number;
  protected readonly fetcher: typeof fetch;

  protected constructor(backend: string, config: STTProviderConfig, deps: CloudSttDeps = {}) {
    const entry = cloudSpeechBackend("stt", backend);
    if (!entry) throw new Error(`unknown cloud STT backend '${backend}'`);
    this.entry = entry;
    this.name = backend;
    this.apiKey = cloudSpeechApiKey(entry, config.apiKey, deps.env);
    this.model = config.model ?? entry.defaultModel;
    this.language = config.language;
    this.vocabulary = config.vocabulary ?? [];
    this.timeoutMs = requestTimeout(config.timeout_ms, PROVIDER_TIMEOUT_MS.stt);
    this.fetcher = deps.fetcher ?? fetch;
  }

  /** Issue the provider request for one utterance's WAV bytes. */
  protected abstract request(audio: Blob, signal: AbortSignal | undefined): Promise<Response>;
  /** Pull the transcript out of a successful JSON body; anything else is a failure. */
  protected abstract transcriptFrom(body: unknown): string | null;

  transcribe(audioFile: string, signal?: AbortSignal): Promise<string | null> {
    return this.transcribeResult(audioFile, signal).then((result) => {
      if (result.kind === "failure") {
        log("warn", result.reason);
        return null;
      }
      return result.kind === "transcript" ? result.text : null;
    });
  }

  async transcribeResult(audioFile: string, signal?: AbortSignal): Promise<STTTranscriptionResult> {
    signal?.throwIfAborted();
    if (!this.apiKey) {
      return { kind: "failure", reason: `${this.entry.label} API key not found; set ${this.entry.apiKeyEnv}` };
    }
    try {
      const file = Bun.file(audioFile);
      if (file.size > MAX_CLOUD_STT_UPLOAD_BYTES) {
        return { kind: "failure", reason: `${this.entry.label} upload refused: utterance exceeds ${MAX_CLOUD_STT_UPLOAD_BYTES} bytes` };
      }
      const response = await this.request(file, signal);
      if (!response.ok) {
        const detail = scrubProviderText(await readErrorDetail(response), this.apiKey);
        return { kind: "failure", reason: `${this.entry.label} returned ${response.status}${detail ? `: ${detail}` : ""}` };
      }
      const body = await readBoundedJson<unknown>(response, PROVIDER_RESPONSE_LIMIT_BYTES.json, `${this.entry.label} transcript`);
      signal?.throwIfAborted();
      const text = this.transcriptFrom(body);
      if (text === null) return { kind: "failure", reason: `${this.entry.label} response had no transcript` };
      const trimmed = text.trim();
      if (trimmed.length < 2) return { kind: "empty" };
      return { kind: "transcript", text: trimmed };
    } catch (error: unknown) {
      signal?.throwIfAborted();
      const message = scrubProviderText(error instanceof Error ? error.message : String(error), this.apiKey);
      return { kind: "failure", reason: `${this.entry.label} transcription failed: ${message}` };
    }
  }

  /**
   * Swap readiness: send a quarter second of silence through the real request
   * path. The free key probe cannot see the model (an OpenAI project key even
   * hides models it may use), so only a real request proves the configured
   * model, language and vocabulary are accepted. Costs a fraction of a cent,
   * and only runs when this provider is swapped in.
   */
  async warmup(): Promise<void> {
    if (!this.apiKey) throw new Error(`${this.entry.label} API key not found; set ${this.entry.apiKeyEnv}`);
    const silence = new Blob([encodeWav(new Int16Array(4_000), 16_000) as Uint8Array<ArrayBuffer>], { type: "audio/wav" });
    let response: Response;
    try {
      response = await this.request(silence, undefined);
    } catch (error: unknown) {
      throw new Error(`${this.entry.label} warmup failed: ${scrubProviderText(error instanceof Error ? error.message : String(error), this.apiKey)}`);
    }
    if (!response.ok) {
      const detail = scrubProviderText(await readErrorDetail(response), this.apiKey);
      throw new Error(`${this.entry.label} rejected model '${scrubProviderText(this.model, this.apiKey)}': ${response.status}${detail ? ` ${detail}` : ""}`);
    }
    const body = await readBoundedJson<unknown>(response, PROVIDER_RESPONSE_LIMIT_BYTES.json, `${this.entry.label} warmup`);
    if (this.transcriptFrom(body) === null) throw new Error(`${this.entry.label} warmup response had no transcript`);
  }

  /** A key check against the provider's free probe; never spends transcription credit. */
  async health(): Promise<boolean> {
    const result = await checkCloudSpeechKey(this.entry, this.apiKey, { fetcher: this.fetcher });
    if (!result.ok) log("info", `${this.entry.label} STT health: ${result.reason}`);
    return result.ok;
  }
}
