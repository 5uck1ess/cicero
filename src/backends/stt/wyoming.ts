import {
  STT_DEFAULT_PORTS,
  type STTProvider,
  type STTProviderConfig,
  type STTTranscriptionResult,
} from "./provider";
import { WyomingClient, type WyomingTransport } from "../wyoming/client";
import { pcmFromWav } from "../wyoming/audio";
import { log } from "../../logger";

export interface WyomingSTTConfig extends STTProviderConfig {
  host?: string;
}

const CHUNK_BYTES = 16384;

/**
 * STT via a Wyoming server (e.g. `wyoming-faster-whisper`). Streams the WAV's
 * PCM as audio-chunk events and awaits a transcript. `makeClient` is injectable
 * for tests.
 */
export class WyomingSTTProvider implements STTProvider {
  readonly name = "wyoming";
  private readonly host: string;
  private readonly port: number;
  private readonly makeClient: () => WyomingTransport;

  constructor(config: WyomingSTTConfig, makeClient?: () => WyomingTransport) {
    this.host = config.host ?? "127.0.0.1";
    this.port = config.port ?? STT_DEFAULT_PORTS.wyoming!;
    this.makeClient = makeClient ?? (() => new WyomingClient({ host: this.host, port: this.port }));
  }

  transcribe(audioFile: string): Promise<string | null> {
    return this.transcribeResult(audioFile).then((result) => {
      if (result.kind === "failure") {
        log("warn", result.reason);
        return null;
      }
      return result.kind === "transcript" ? result.text : null;
    }).catch((err: unknown) => {
      const message = `Wyoming STT failed: ${err instanceof Error ? err.message : String(err)}`;
      log("warn", message);
      return null;
    });
  }

  async transcribeResult(audioFile: string): Promise<STTTranscriptionResult> {
    const client = this.makeClient();
    try {
      const wav = new Uint8Array(await Bun.file(audioFile).arrayBuffer());
      const { pcm, format } = pcmFromWav(wav);
      const meta = { rate: format.rate, width: format.width, channels: format.channels };

      await client.send({ type: "audio-start", data: { ...meta, timestamp: 0 } });
      for (let i = 0; i < pcm.byteLength; i += CHUNK_BYTES) {
        await client.send({ type: "audio-chunk", data: meta }, pcm.subarray(i, i + CHUNK_BYTES));
      }
      await client.send({ type: "audio-stop", data: { timestamp: 0 } });

      const event = await client.receiveOfType("transcript");
      const text = ((event.data?.text as string | undefined) ?? "").trim();
      return text.length >= 1 ? { kind: "transcript", text } : { kind: "empty" };
    } catch (err: unknown) {
      return {
        kind: "failure",
        reason: `Wyoming STT failed: ${err instanceof Error ? err.message : String(err)}`,
      };
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
