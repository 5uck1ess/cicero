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

export interface LiveStreamResponseLimits {
  maxHeaderBytes: number;
  maxChunkBytes: number;
  maxEventBytes: number;
  maxBodyBytes: number;
}

export interface LiveStreamOptions {
  timeoutMs?: number;
  limits?: Partial<LiveStreamResponseLimits>;
  /** Injectable monotonic clock for deterministic timing regressions. */
  now?: () => number;
}

const DEFAULT_CHUNK_MS = 100;
const DEFAULT_TIMEOUT_MS = 180_000;
// Bench responses are transcript text, so 64 KiB of headers, 4 MiB per HTTP
// chunk, 1 MiB per SSE event, and 16 MiB overall are generous while still
// bounding every unit retained from a remote provider.
const DEFAULT_RESPONSE_LIMITS: LiveStreamResponseLimits = {
  maxHeaderBytes: 64 * 1024,
  maxChunkBytes: 4 * 1024 * 1024,
  maxEventBytes: 1024 * 1024,
  maxBodyBytes: 16 * 1024 * 1024,
};
const MAX_CHUNK_LINE_BYTES = 128;

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
  private state: "headers" | "size" | "size-lf" | "data" | "data-cr" | "data-lf" | "done" = "headers";
  private header = new Uint8Array(1024);
  private headerLength = 0;
  private headerEndMatched = 0;
  private sizeLine = new Uint8Array(32);
  private sizeLineLength = 0;
  private chunkRemaining = 0;
  private bodyBytes = 0;
  private readonly decoder = new TextDecoder();
  status = 0;

  constructor(private readonly limits: LiveStreamResponseLimits) {}

  /** Returns any newly decoded body text. Throws on a malformed response. */
  push(chunk: Uint8Array): string {
    const text: string[] = [];
    let offset = 0;
    while (offset < chunk.length && this.state !== "done") {
      const byte = chunk[offset]!;
      if (this.state === "headers") {
        this.appendHeaderByte(byte);
        offset++;
        continue;
      }
      if (this.state === "size") {
        if (byte === CR) {
          this.state = "size-lf";
        } else {
          this.appendSizeByte(byte);
        }
        offset++;
        continue;
      }
      if (this.state === "size-lf") {
        if (byte !== LF) throw new Error("malformed chunk size line in response");
        const tail = this.startChunk();
        if (tail) text.push(tail);
        offset++;
        continue;
      }
      if (this.state === "data") {
        const take = Math.min(this.chunkRemaining, chunk.length - offset);
        text.push(this.decoder.decode(chunk.subarray(offset, offset + take), { stream: true }));
        this.chunkRemaining -= take;
        this.bodyBytes += take;
        offset += take;
        if (this.chunkRemaining === 0) this.state = "data-cr";
        continue;
      }
      if (this.state === "data-cr") {
        if (byte !== CR) throw new Error("response chunk is missing its trailing CRLF");
        this.state = "data-lf";
        offset++;
        continue;
      }
      if (byte !== LF) throw new Error("response chunk is missing its trailing CRLF");
      this.state = "size";
      offset++;
    }
    return text.join("");
  }

  private appendHeaderByte(byte: number): void {
    if (this.headerLength === this.header.length) {
      const capacity = Math.min(
        this.limits.maxHeaderBytes + HEADER_END.length,
        this.header.length * 2,
      );
      if (capacity <= this.header.length) {
        throw new RangeError(
          `response header section exceeds ${this.limits.maxHeaderBytes}-byte limit`,
        );
      }
      const grown = new Uint8Array(capacity);
      grown.set(this.header);
      this.header = grown;
    }
    this.header[this.headerLength++] = byte;
    if (byte === HEADER_END[this.headerEndMatched]) {
      this.headerEndMatched++;
    } else {
      this.headerEndMatched = byte === HEADER_END[0] ? 1 : 0;
    }
    if (this.headerEndMatched === HEADER_END.length) {
      const sectionLength = this.headerLength - HEADER_END.length;
      if (sectionLength > this.limits.maxHeaderBytes) {
        throw new RangeError(
          `response header section exceeds ${this.limits.maxHeaderBytes}-byte limit`,
        );
      }
      const head = this.decoder.decode(this.header.subarray(0, sectionLength));
      const statusLine = head.split("\r\n", 1)[0] ?? "";
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/.exec(statusLine);
      if (!match) throw new Error("server returned a malformed HTTP status line");
      this.status = Number(match[1]);
      if (this.status < 200 || this.status >= 300) {
        throw new Error(`server returned HTTP ${this.status}`);
      }
      this.header = new Uint8Array(0);
      this.state = "size";
    } else if (this.headerLength - this.headerEndMatched > this.limits.maxHeaderBytes) {
      throw new RangeError(
        `response header section exceeds ${this.limits.maxHeaderBytes}-byte limit`,
      );
    }
  }

  private appendSizeByte(byte: number): void {
    if (this.sizeLineLength >= MAX_CHUNK_LINE_BYTES) {
      throw new RangeError(
        `response chunk-size line exceeds ${MAX_CHUNK_LINE_BYTES}-byte limit`,
      );
    }
    if (this.sizeLineLength === this.sizeLine.length) {
      const grown = new Uint8Array(Math.min(MAX_CHUNK_LINE_BYTES, this.sizeLine.length * 2));
      grown.set(this.sizeLine);
      this.sizeLine = grown;
    }
    this.sizeLine[this.sizeLineLength++] = byte;
  }

  private startChunk(): string {
    const line = new TextDecoder().decode(this.sizeLine.subarray(0, this.sizeLineLength));
    const token = line.split(";", 1)[0]!.trim();
    if (!/^[0-9a-f]+$/i.test(token)) throw new Error("malformed chunk size in response");
    const size = Number.parseInt(token, 16);
    if (!Number.isSafeInteger(size)) throw new Error("malformed chunk size in response");
    if (size > this.limits.maxChunkBytes) {
      throw new RangeError(
        `response chunk exceeds ${this.limits.maxChunkBytes}-byte limit (declared ${size} bytes)`,
      );
    }
    if (this.bodyBytes + size > this.limits.maxBodyBytes) {
      throw new RangeError(
        `response decoded body exceeds ${this.limits.maxBodyBytes}-byte limit`,
      );
    }
    this.sizeLineLength = 0;
    if (size === 0) {
      this.state = "done";
      return this.decoder.decode();
    }
    this.chunkRemaining = size;
    this.state = "data";
    return "";
  }
}

const CR = 13;
const LF = 10;
const HEADER_END = new Uint8Array([13, 10, 13, 10]);

function responseLimits(overrides: Partial<LiveStreamResponseLimits> = {}): LiveStreamResponseLimits {
  const limits = { ...DEFAULT_RESPONSE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  return limits;
}

/**
 * Feed one clip at the requested pace and time what comes back.
 *
 * With `pace: "realtime"` (the default) the upload is throttled to the clip's own
 * duration, which is what makes the timings mean anything — a model can't be
 * credited with a partial it only produced because the whole file arrived at once.
 */
export async function transcribeLive(
  audioPath: string,
  c: StreamCandidate,
  options: LiveStreamOptions = {},
): Promise<LiveStreamResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }
  const limits = responseLimits(options.limits);
  const now = options.now ?? (() => performance.now());
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

  const reader = new ChunkedResponseReader(limits);
  const eventEncoder = new TextEncoder();
  let sse = "";
  let sseBytes = 0;
  let firstDeltaMs: number | null = null;
  let lastDeltaMs: number | null = null;
  let deltasDuringAudio = 0;
  let deltas = 0;
  let doneMs: number | null = null;
  let finalText = "";
  let joined = "";
  let t0 = 0; // set when the first PCM byte goes out
  let failure: Error | null = null;
  let resolveClosed!: () => void;
  let closedSettled = false;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let drainWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;
  let paceWaiter: {
    timer: ReturnType<typeof setTimeout>;
    reject: (error: Error) => void;
  } | null = null;
  let requestBodyDone = false;

  const settleClosed = (): void => {
    if (closedSettled) return;
    closedSettled = true;
    resolveClosed();
  };

  const rejectPending = (error: Error): void => {
    if (drainWaiter) {
      const waiter = drainWaiter;
      drainWaiter = null;
      waiter.reject(error);
    }
    if (paceWaiter) {
      const waiter = paceWaiter;
      paceWaiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  const abortSocket = (socket: { terminate(): void }, error: Error): void => {
    failure ??= error;
    // Bun's terminate() is the forceful full close; end() only closes writes.
    socket.terminate();
    rejectPending(failure);
    settleClosed();
  };

  const consumeEvent = (block: string): void => {
    const payload = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    if (!payload || payload === "[DONE]") return;
    let event: { type?: string; delta?: string; text?: string; error?: { message?: string } };
    try { event = JSON.parse(payload); } catch { return; }
    if (event.error) {
      failure ??= new Error(event.error.message ?? "stream error");
      return;
    }
    const at = now() - t0;
    if (event.type === "transcript.text.delta") {
      deltas++;
      joined += event.delta ?? "";
      firstDeltaMs ??= at;
      lastDeltaMs = at;
      if (at < audioMs) deltasDuringAudio++;
    } else if (event.type === "transcript.text.done") {
      doneMs ??= at;
      finalText = event.text ?? "";
    }
  };

  const appendEventFragment = (fragment: string): void => {
    if (fragment.length > limits.maxEventBytes - sseBytes) {
      throw new RangeError(`SSE event exceeds ${limits.maxEventBytes}-byte limit`);
    }
    const bytes = eventEncoder.encode(fragment).byteLength;
    if (sseBytes + bytes > limits.maxEventBytes) {
      throw new RangeError(`SSE event exceeds ${limits.maxEventBytes}-byte limit`);
    }
    sse += fragment;
    sseBytes += bytes;
  };

  const consumeEvents = (text: string): void => {
    let offset = 0;
    if (sse.endsWith("\n") && text.startsWith("\n")) {
      consumeEvent(sse.slice(0, -1));
      sse = "";
      sseBytes = 0;
      offset = 1;
    }
    for (;;) {
      const end = text.indexOf("\n\n", offset);
      if (end < 0) {
        appendEventFragment(text.slice(offset));
        return;
      }
      appendEventFragment(text.slice(offset, end));
      consumeEvent(sse);
      sse = "";
      sseBytes = 0;
      offset = end + 2;
    }
  };

  const socket = await Bun.connect({
    hostname: host,
    port: c.port,
    socket: {
      data: (s, chunk) => {
        try {
          consumeEvents(reader.push(chunk));
          if (failure) abortSocket(s, failure);
        } catch (err: unknown) {
          abortSocket(s, err instanceof Error ? err : new Error(String(err)));
        }
      },
      drain: () => {
        const waiter = drainWaiter;
        drainWaiter = null;
        waiter?.resolve();
      },
      close: () => {
        if (!requestBodyDone) {
          failure ??= new Error("connection closed before request body completed");
          rejectPending(failure);
        }
        settleClosed();
      },
      error: (s, err) => {
        abortSocket(s, err instanceof Error ? err : new Error(String(err)));
      },
    },
  });

  /** Bun's `write` does not buffer the remainder, so a short write must be re-driven. */
  const writeAll = async (data: Uint8Array | string): Promise<void> => {
    let payload = typeof data === "string" ? new TextEncoder().encode(data) : data;
    while (payload.length) {
      if (failure) throw failure;
      const n = socket.write(payload);
      if (n >= payload.length) return;
      payload = payload.subarray(Math.max(n, 0));
      await new Promise<void>((resolve, reject) => {
        drainWaiter = { resolve, reject };
      });
    }
  };

  const waitForPace = async (ms: number): Promise<void> => {
    if (failure) throw failure;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        paceWaiter = null;
        resolve();
      }, ms);
      paceWaiter = { timer, reject };
    });
  };

  const timeout = setTimeout(() => {
    abortSocket(socket, new Error(`no response within ${timeoutMs} ms`));
  }, timeoutMs);

  try {
    await writeAll(
      `POST ${path} HTTP/1.1\r\nHost: ${host}:${c.port}\r\n` +
      `Transfer-Encoding: chunked\r\nContent-Type: application/octet-stream\r\nAccept: text/event-stream\r\n\r\n`,
    );

    t0 = now();
    for (let off = 0; off < pcm.length && !failure; off += chunkBytes) {
      const slice = pcm.subarray(off, Math.min(off + chunkBytes, pcm.length));
      await writeAll(`${slice.length.toString(16)}\r\n`);
      await writeAll(slice);
      await writeAll("\r\n");
      if (c.pace !== "fast") {
        // Sleep until this chunk's audio would have finished playing, so the
        // server never sees samples earlier than a live microphone would deliver.
        const playedMs = ((off + slice.length) / 2 / sampleRate) * 1000;
        const wait = t0 + playedMs - now();
        if (wait > 0) await waitForPace(wait);
      }
    }
    await writeAll("0\r\n\r\n");
    requestBodyDone = true;
    await closed;
  } finally {
    clearTimeout(timeout);
    const cleanupError = failure ?? new Error("live transcription request ended");
    rejectPending(cleanupError);
    settleClosed();
    socket.terminate();
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
    // Without a terminal event, the last delta is the best available finish
    // estimate. A negative value is still meaningful when that final available
    // delta genuinely arrived before the audio itself finished.
    finalAfterAudioMs: (doneMs ?? lastDeltaMs ?? audioMs) - audioMs,
  };
}
