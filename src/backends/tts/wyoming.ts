import { TTS_DEFAULT_PORTS, type TTSProvider, type TTSProviderConfig } from "./provider";
import { WyomingClient, type WyomingTransport } from "../wyoming/client";
import { wavFromPcm, type PcmFormat } from "../wyoming/audio";

export interface WyomingTTSConfig extends TTSProviderConfig {
  host?: string;
}

const DEFAULT_FORMAT: PcmFormat = { rate: 22050, width: 2, channels: 1 };
const DEFAULT_RESPONSE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_AUDIO_BYTES = 64 * 1024 * 1024;

function positiveOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

/**
 * TTS via a Wyoming server (e.g. `wyoming-piper`). Sends a synthesize request,
 * collects the streamed audio-chunk events, and assembles them into a WAV
 * buffer the speaker can play. `makeClient` is injectable for tests.
 */
export class WyomingTTSProvider implements TTSProvider {
  readonly name = "wyoming";
  private readonly host: string;
  private readonly port: number;
  private readonly voice?: string;
  private readonly makeClient: () => WyomingTransport;
  private readonly responseTimeoutMs: number;
  private readonly maxAudioBytes: number;

  constructor(config: WyomingTTSConfig, makeClient?: () => WyomingTransport) {
    this.host = config.host ?? "127.0.0.1";
    this.port = config.port ?? TTS_DEFAULT_PORTS.wyoming!;
    this.voice = config.voice;
    this.responseTimeoutMs = positiveOption(
      config.responseTimeoutMs,
      DEFAULT_RESPONSE_TIMEOUT_MS,
      "responseTimeoutMs",
    );
    this.maxAudioBytes = positiveOption(
      config.maxAudioBytes,
      DEFAULT_MAX_AUDIO_BYTES,
      "maxAudioBytes",
    );
    this.makeClient = makeClient ?? (() => new WyomingClient({ host: this.host, port: this.port }));
  }

  async generateAudio(text: string, voice?: string): Promise<ArrayBuffer> {
    const client = this.makeClient();
    try {
      const data: Record<string, unknown> = { text };
      const selectedVoice = voice ?? this.voice;
      if (selectedVoice) data.voice = { name: selectedVoice };
      await client.send({ type: "synthesize", data });

      let format: PcmFormat = { ...DEFAULT_FORMAT };
      const chunks: Uint8Array[] = [];
      let total = 0;
      const deadline = Date.now() + this.responseTimeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`Wyoming TTS response timed out after ${this.responseTimeoutMs}ms`);
        }
        const event = await client.receive(remaining);
        if (event.type === "audio-start") {
          const d = event.data ?? {};
          format = {
            rate: (d.rate as number) ?? format.rate,
            width: (d.width as number) ?? format.width,
            channels: (d.channels as number) ?? format.channels,
          };
        } else if (event.type === "audio-chunk") {
          if (event.payload) {
            const nextTotal = total + event.payload.byteLength;
            if (nextTotal > this.maxAudioBytes) {
              throw new RangeError(
                `Wyoming TTS audio exceeds ${this.maxAudioBytes} bytes`,
              );
            }
            total = nextTotal;
            chunks.push(event.payload);
          }
        } else if (event.type === "audio-stop") {
          break;
        }
      }

      const pcm = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        pcm.set(c, offset);
        offset += c.byteLength;
      }
      return wavFromPcm(pcm, format);
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(`Wyoming TTS failed: ${String(error)}`);
    } finally {
      client.close();
    }
  }

  async health(): Promise<boolean> {
    const client = this.makeClient();
    try {
      await client.describe();
      return true;
    } catch {
      return false;
    } finally {
      client.close();
    }
  }
}
