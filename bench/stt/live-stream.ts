/**
 * Client for audio.cpp's live PCM ingest endpoint (`POST
 * /v1/audio/transcriptions/live`, upstream PR #144) — the transport that makes
 * streaming time-to-final measurable over HTTP instead of only from a CLI pipe.
 *
 * It is a raw socket rather than `fetch` on purpose. This is a full-duplex
 * exchange: PCM goes up in a chunked request body while SSE deltas come back
 * down the same connection. `fetch` request streaming is half-duplex by
 * specification — the response is not delivered until the request body ends —
 * which would collapse exactly the measurement this file exists to take.
 *
 * Whether deltas arrive *during* capture is a property of the model, not of the
 * transport: a model that buffers internally emits nothing until the audio ends
 * and will report 0 deltas-during-audio here. That is a real result, not a bug.
 */
import { decodeWav } from "../../src/platform/wav";
import type { StreamCandidate } from "./types";

export interface LiveStreamResult {
  /** Final transcript from `transcript.text.done` (falls back to joined deltas). */
  text: string;
  /** Clip length in ms — the wall-clock budget a real-time feed spends uploading. */
  audioMs: number;
  /** First `transcript.text.delta`, ms after the first PCM byte. null if none. */
  firstDeltaMs: number | null;
  /** Deltas that landed before the clip's audio would have finished playing. */
  deltasDuringAudio: number;
  /** Total deltas. */
  deltas: number;
  /**
   * `transcript.text.done` relative to the end of the audio. Negative means the
   * transcript was complete before the last sample was even sent.
   */
  finalAfterAudioMs: number;
}

const DEFAULT_CHUNK_MS = 100;
const DEFAULT_TIMEOUT_MS = 180_000;

/** Float samples in [-1,1] → little-endian 16-bit PCM, the endpoint's default format. */
function toS16le(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, Math.round(clamped * 32767), true);
  }
  return out;
}

/**
 * Incremental de-framer for the *response*: the server replies
 * `Transfer-Encoding: chunked`, so SSE text has to be unwrapped before it can be
 * split on event boundaries.
 */
class ChunkedResponseReader {
  private buf = new Uint8Array(0);
  private headersDone = false;
  private decoder = new TextDecoder();
  status = 0;

  /** Returns any newly decoded body text. Throws on a malformed response. */
  push(chunk: Uint8Array): string {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    if (!this.headersDone) {
      const end = indexOfSequence(this.buf, HEADER_END);
      if (end < 0) return "";
      const head = this.decoder.decode(this.buf.subarray(0, end));
      this.status = Number(head.split("\n", 1)[0]?.split(" ")[1] ?? 0);
      // A non-2xx reply is a plain buffered error body, not a chunked stream;
      // surface its text rather than failing to de-frame it.
      if (this.status < 200 || this.status >= 300) {
        throw new Error(`server returned ${this.status}: ${this.decoder.decode(this.buf.subarray(end + HEADER_END.length)).trim() || head.split("\n")[0]}`);
      }
      this.buf = this.buf.slice(end + HEADER_END.length);
      this.headersDone = true;
    }

    let text = "";
    for (;;) {
      const nl = indexOfSequence(this.buf, CRLF);
      if (nl < 0) return text;
      const size = parseInt(this.decoder.decode(this.buf.subarray(0, nl)).split(";")[0]!.trim(), 16);
      if (!Number.isFinite(size) || size < 0) throw new Error("malformed chunk size in response");
      if (size === 0) {
        this.buf = new Uint8Array(0);
        return text;
      }
      const dataStart = nl + CRLF.length;
      if (this.buf.length < dataStart + size + CRLF.length) return text; // wait for the rest
      text += this.decoder.decode(this.buf.subarray(dataStart, dataStart + size));
      this.buf = this.buf.slice(dataStart + size + CRLF.length);
    }
  }
}

const CRLF = new Uint8Array([13, 10]);
const HEADER_END = new Uint8Array([13, 10, 13, 10]);

function indexOfSequence(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Feed one clip at the requested pace and time what comes back.
 *
 * With `pace: "realtime"` (the default) the upload is throttled to the clip's own
 * duration, which is what makes the timings mean anything — a model can't be
 * credited with a partial it only produced because the whole file arrived at once.
 */
export async function transcribeLive(audioPath: string, c: StreamCandidate): Promise<LiveStreamResult> {
  const { samples, sampleRate } = decodeWav(await Bun.file(audioPath).arrayBuffer());
  const pcm = toS16le(samples);
  const audioMs = (samples.length / sampleRate) * 1000;
  const chunkMs = c.chunkMs ?? DEFAULT_CHUNK_MS;
  const chunkBytes = Math.max(2, Math.round((sampleRate * chunkMs) / 1000) * 2);

  const query = new URLSearchParams({
    model: c.model,
    sample_rate: String(sampleRate),
    channels: "1",
    sample_format: "s16le",
  });
  if (c.language) query.set("language", c.language);
  const path = `${c.path ?? "/v1/audio/transcriptions/live"}?${query}`;
  const host = c.host ?? "127.0.0.1";

  const reader = new ChunkedResponseReader();
  let sse = "";
  let firstDeltaMs: number | null = null;
  let deltasDuringAudio = 0;
  let deltas = 0;
  let doneMs: number | null = null;
  let finalText = "";
  let joined = "";
  let t0 = 0; // set when the first PCM byte goes out
  let failure: Error | null = null;
  let settle: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => { settle = resolve; });
  let drained: (() => void) | null = null;

  const consumeEvents = (): void => {
    for (;;) {
      const end = sse.indexOf("\n\n");
      if (end < 0) return;
      const block = sse.slice(0, end);
      sse = sse.slice(end + 2);
      const payload = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!payload || payload === "[DONE]") continue;
      let event: { type?: string; delta?: string; text?: string; error?: { message?: string } };
      try { event = JSON.parse(payload); } catch { continue; }
      if (event.error) { failure ??= new Error(event.error.message ?? "stream error"); continue; }
      const at = performance.now() - t0;
      if (event.type === "transcript.text.delta") {
        deltas++;
        joined += event.delta ?? "";
        firstDeltaMs ??= at;
        if (at < audioMs) deltasDuringAudio++;
      } else if (event.type === "transcript.text.done") {
        doneMs ??= at;
        finalText = event.text ?? "";
      }
    }
  };

  const socket = await Bun.connect({
    hostname: host,
    port: c.port,
    socket: {
      data: (_s, chunk) => {
        try {
          sse += reader.push(chunk);
          consumeEvents();
        } catch (err: unknown) {
          failure ??= err instanceof Error ? err : new Error(String(err));
        }
      },
      drain: () => { drained?.(); drained = null; },
      close: () => settle?.(),
      error: (_s, err) => { failure ??= err instanceof Error ? err : new Error(String(err)); settle?.(); },
    },
  });

  /** Bun's `write` does not buffer the remainder, so a short write must be re-driven. */
  const writeAll = async (data: Uint8Array | string): Promise<void> => {
    let payload = typeof data === "string" ? new TextEncoder().encode(data) : data;
    while (payload.length) {
      const n = socket.write(payload);
      if (n >= payload.length) return;
      payload = payload.subarray(Math.max(n, 0));
      await new Promise<void>((resolve) => { drained = resolve; });
    }
  };

  const timeout = setTimeout(() => {
    failure ??= new Error(`no response within ${DEFAULT_TIMEOUT_MS} ms`);
    socket.end();
  }, DEFAULT_TIMEOUT_MS);

  try {
    await writeAll(
      `POST ${path} HTTP/1.1\r\nHost: ${host}:${c.port}\r\n` +
      `Transfer-Encoding: chunked\r\nContent-Type: application/octet-stream\r\nAccept: text/event-stream\r\n\r\n`,
    );

    t0 = performance.now();
    for (let off = 0; off < pcm.length && !failure; off += chunkBytes) {
      const slice = pcm.subarray(off, Math.min(off + chunkBytes, pcm.length));
      await writeAll(`${slice.length.toString(16)}\r\n`);
      await writeAll(slice);
      await writeAll("\r\n");
      if (c.pace !== "fast") {
        // Sleep until this chunk's audio would have finished playing, so the
        // server never sees samples earlier than a live microphone would deliver.
        const playedMs = ((off + slice.length) / 2 / sampleRate) * 1000;
        const wait = t0 + playedMs - performance.now();
        if (wait > 0) await Bun.sleep(wait);
      }
    }
    await writeAll("0\r\n\r\n");
    await closed;
  } finally {
    clearTimeout(timeout);
    socket.end();
  }

  if (failure) throw failure;
  const text = finalText || joined;
  if (!text.trim()) throw new Error("stream closed without a transcript");

  return {
    text: text.trim(),
    audioMs,
    firstDeltaMs,
    deltasDuringAudio,
    deltas,
    // Falling back to firstDelta keeps the row honest for a server that streams
    // deltas but never sends the terminal event, rather than reporting a 0.
    finalAfterAudioMs: (doneMs ?? firstDeltaMs ?? audioMs) - audioMs,
  };
}
