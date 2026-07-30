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
import { sanitizeLabel } from "../../src/text-utils";
import type { StreamCandidate } from "./types";

export interface LiveStreamResult {
  /** Final transcript from `transcript.text.done` (falls back to joined deltas). */
  text: string;
  /** Clip length in ms — the wall-clock budget a real-time feed spends uploading. */
  audioMs: number;
  /** First `transcript.text.delta`, ms after the first PCM byte is written. null if none. */
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
  /** Injectable connector for deterministic connection-deadline regressions. */
  connect?: LiveStreamConnect;
}

export type LiveStreamConnect = (
  options: Bun.TCPSocketConnectOptions<undefined>,
) => Promise<Bun.Socket<undefined>>;

const DEFAULT_CHUNK_MS = 100;
// A real-time feed cannot finish sooner than the clip itself, so the deadline is
// derived from the audio rather than fixed: decodeWav accepts up to
// MAX_DECODED_WAV_DURATION_MS (5 min), and a fixed 180s ceiling failed every
// legal clip longer than three minutes no matter how healthy the server was.
// The grace covers connect, the server's own processing, and the trailing
// response after the last sample.
const DEFAULT_RESPONSE_GRACE_MS = 60_000;

/** Default absolute deadline for one paced run of `audioMs` of audio. */
export const liveStreamTimeoutMs = (audioMs: number): number =>
  audioMs + DEFAULT_RESPONSE_GRACE_MS;
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
const MAX_REMOTE_ERROR_CHARS = 512;

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
  private state:
    | "headers" | "size" | "size-lf" | "data" | "data-cr" | "data-lf"
    | "trailer" | "trailer-lf" | "done" = "headers";
  private header = new Uint8Array(1024);
  private headerLength = 0;
  private headerEndMatched = 0;
  private sizeLine = new Uint8Array(32);
  private sizeLineLength = 0;
  private chunkRemaining = 0;
  private bodyBytes = 0;
  private trailerBytes = 0;
  private trailerLineLength = 0;
  private readonly decoder = new TextDecoder();
  status = 0;

  constructor(private readonly limits: LiveStreamResponseLimits) {}

  get complete(): boolean {
    return this.state === "done";
  }

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
      if (this.state === "trailer") {
        if (byte === CR) {
          this.state = "trailer-lf";
        } else {
          this.trailerLineLength++;
          this.trailerBytes++;
          if (this.trailerBytes > this.limits.maxHeaderBytes) {
            throw new RangeError(
              `response trailer section exceeds ${this.limits.maxHeaderBytes}-byte limit`,
            );
          }
        }
        offset++;
        continue;
      }
      if (this.state === "trailer-lf") {
        if (byte !== LF) throw new Error("malformed trailer section in response");
        if (this.trailerLineLength === 0) {
          this.state = "done";
          text.push(this.decoder.decode());
        } else {
          this.trailerLineLength = 0;
          this.state = "trailer";
        }
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
      // RFC 9112 7.1: the zero chunk is followed by an optional trailer section
      // and a final empty line. The response is NOT complete until that line
      // arrives, and treating it as complete lets a peer that sends `0\r\n` and
      // then FIN be recorded as a successful measurement.
      this.trailerBytes = 0;
      this.trailerLineLength = 0;
      this.state = "trailer";
      return "";
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
  if (options.timeoutMs !== undefined
    && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }
  const limits = responseLimits(options.limits);
  const now = options.now ?? (() => performance.now());
  const connect: LiveStreamConnect =
    options.connect ?? ((connectOptions) => Bun.connect(connectOptions));
  const { samples, sampleRate } = decodeWav(await Bun.file(audioPath).arrayBuffer());
  const pcm = toS16le(samples);
  const audioMs = (samples.length / sampleRate) * 1000;
  const timeoutMs = options.timeoutMs ?? liveStreamTimeoutMs(audioMs);
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
  let firstDeltaAt: number | null = null;
  let lastDeltaAt: number | null = null;
  const deltaTimes: number[] = [];
  let deltas = 0;
  let doneAt: number | null = null;
  // null (not "") so a terminal event carrying an empty transcript stays
  // distinguishable from no terminal event at all. Collapsing the two lets an
  // empty final fall back to the partials, which records a stale mid-stream
  // guess as the model's answer.
  let finalText: string | null = null;
  let joined = "";
  let paceStartedAt = 0;
  let firstPcmWrittenAt = 0;
  let lastPcmWrittenAt = 0;
  let failure: Error | null = null;
  let resolveResponse!: () => void;
  let responseSettled = false;
  const responseComplete = new Promise<void>((resolve) => { resolveResponse = resolve; });
  let drainWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;
  let paceWaiter: {
    timer: ReturnType<typeof setTimeout>;
    reject: (error: Error) => void;
  } | null = null;
  let requestBodyDone = false;

  const settleResponse = (): void => {
    if (responseSettled) return;
    responseSettled = true;
    resolveResponse();
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

  let socketReleased = false;
  const releaseSocket = (socket: { terminate(): void }): void => {
    if (socketReleased) return;
    socketReleased = true;
    socket.terminate();
  };

  const abortSocket = (socket: { terminate(): void }, error: Error): void => {
    failure ??= error;
    // Bun's terminate() is the forceful full close; end() only closes writes.
    releaseSocket(socket);
    rejectPending(failure);
    settleResponse();
  };

  /** False only when the block carried a payload that could not be parsed. */
  const consumeEvent = (block: string): boolean => {
    const payload = block.split(/\r\n|\r|\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    if (!payload || payload === "[DONE]") return true;
    let event: { type?: string; delta?: string; text?: string; error?: { message?: string } };
    try { event = JSON.parse(payload); } catch { return false; }
    if (event.error) {
      // JSON decoding restores escaped controls from the remote body. Replace
      // them before retaining the message so a later warning cannot forge a
      // benchmark line or write a terminal control sequence.
      failure ??= new Error(sanitizeLabel(event.error.message ?? "stream error", MAX_REMOTE_ERROR_CHARS));
      return true;
    }
    const at = now();
    if (event.type === "transcript.text.delta") {
      deltas++;
      joined += event.delta ?? "";
      firstDeltaAt ??= at;
      lastDeltaAt = at;
      deltaTimes.push(at);
    } else if (event.type === "transcript.text.done") {
      // The last terminal event wins because its text is the transcript scored;
      // replacing both fields keeps that transcript paired with its own timing.
      doneAt = at;
      finalText = event.text ?? "";
    }
    return true;
  };

  /**
   * The HTTP body can end cleanly while the last SSE event is still missing its
   * blank-line terminator. Dropping that residual silently rewrote the run's
   * result to whatever the previous delta said — a truncated stream scored as a
   * complete one. Consume it if it is whole, and fail the run if it is not.
   */
  const flushPendingEvent = (): void => {
    if (!sse.trim()) return;
    const block = sse;
    sse = "";
    sseBytes = 0;
    if (!consumeEvent(block)) {
      failure ??= new Error("response ended mid-event");
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

  /**
   * A whole, properly delimited event whose payload will not parse is a
   * malformed response, not a no-op. Dropping it silently left the run scored
   * on whatever the previous delta said — the same lie as a truncated stream,
   * arriving through the ordinary path rather than the residual one.
   */
  const takeEvent = (block: string): void => {
    if (!consumeEvent(block)) failure ??= new Error("malformed SSE event");
    sse = "";
    sseBytes = 0;
  };

  let pendingCr = false;
  let pendingCrBelongsToEvent = false;
  let lineHasContent = false;

  const consumeEvents = (text: string): void => {
    let offset = 0;
    if (pendingCr) {
      if (text.charCodeAt(0) === LF) {
        if (pendingCrBelongsToEvent) appendEventFragment("\n");
        offset = 1;
      }
      pendingCr = false;
      pendingCrBelongsToEvent = false;
    }

    while (offset < text.length) {
      let end = offset;
      while (end < text.length) {
        const code = text.charCodeAt(end);
        if (code === CR || code === LF) break;
        end++;
      }
      if (end > offset) {
        appendEventFragment(text.slice(offset, end));
        lineHasContent = true;
      }
      if (end === text.length) return;

      const code = text.charCodeAt(end);
      if (lineHasContent) {
        appendEventFragment(code === CR ? "\r" : "\n");
        lineHasContent = false;
        if (code === CR) pendingCrBelongsToEvent = true;
      } else {
        takeEvent(sse);
        pendingCrBelongsToEvent = false;
      }
      pendingCr = code === CR;
      offset = end + 1;

      if (pendingCr && offset < text.length) {
        if (text.charCodeAt(offset) === LF) {
          if (pendingCrBelongsToEvent) appendEventFragment("\n");
          offset++;
        }
        pendingCr = false;
        pendingCrBelongsToEvent = false;
      }
    }
  };

  let socket: Bun.Socket<undefined> | null = null;

  /** Bun's `write` does not buffer the remainder, so a short write must be re-driven. */
  const writeAll = async (data: Uint8Array | string): Promise<void> => {
    let payload = typeof data === "string" ? new TextEncoder().encode(data) : data;
    while (payload.length) {
      if (failure) throw failure;
      const n = socket!.write(payload);
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

  let releaseLateSocket = false;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const timeout = setTimeout(() => {
    releaseLateSocket = true;
    const error = new Error(`no response within ${timeoutMs} ms`);
    if (socket) {
      abortSocket(socket, error);
    } else {
      failure ??= error;
      rejectPending(failure);
      settleResponse();
    }
    rejectDeadline(failure ?? error);
  }, timeoutMs);

  try {
    const connecting = connect({
      hostname: host,
      port: c.port,
      socket: {
        data: (s, chunk) => {
          try {
            consumeEvents(reader.push(chunk));
            if (reader.complete) {
              // HTTP/1.1 persistence leaves the socket open after the zero
              // chunk and trailer terminator, so framing completion owns this
              // signal rather than the transport's eventual close callback.
              flushPendingEvent();
              settleResponse();
            }
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
          socketReleased = true;
          if (!requestBodyDone) {
            failure ??= new Error("connection closed before request body completed");
          } else if (!reader.complete) {
            failure ??= new Error("connection closed before response completed");
          }
          if (failure) rejectPending(failure);
          settleResponse();
        },
        error: (s, err) => {
          abortSocket(s, err instanceof Error ? err : new Error(String(err)));
        },
      },
    });
    void connecting.then(
      (connected) => {
        if (releaseLateSocket) connected.terminate();
      },
      () => {},
    );
    socket = await Promise.race([connecting, deadline]);

    await writeAll(
      `POST ${path} HTTP/1.1\r\nHost: ${host}:${c.port}\r\n` +
      `Transfer-Encoding: chunked\r\nContent-Type: application/octet-stream\r\nAccept: text/event-stream\r\n\r\n`,
    );

    paceStartedAt = now();
    for (let off = 0; off < pcm.length && !failure; off += chunkBytes) {
      const slice = pcm.subarray(off, Math.min(off + chunkBytes, pcm.length));
      if (c.pace !== "fast") {
        // Wait until this chunk's final sample would have been captured before
        // sending it, so no sample arrives earlier than a live microphone could provide it.
        const playedMs = ((off + slice.length) / 2 / sampleRate) * 1000;
        const wait = paceStartedAt + playedMs - now();
        if (wait > 0) await waitForPace(wait);
      }
      await writeAll(`${slice.length.toString(16)}\r\n`);
      if (off === 0) firstPcmWrittenAt = now();
      await writeAll(slice);
      if (off + slice.length === pcm.length) lastPcmWrittenAt = now();
      await writeAll("\r\n");
    }
    await writeAll("0\r\n\r\n");
    requestBodyDone = true;
    await responseComplete;
    flushPendingEvent();
  } finally {
    clearTimeout(timeout);
    const cleanupError = failure ?? new Error("live transcription request ended");
    rejectPending(cleanupError);
    settleResponse();
    if (socket) releaseSocket(socket);
  }

  if (failure) throw failure;
  // A terminal event wins even when it is empty: the model said it heard
  // nothing, and the partials it has already retracted are not a substitute.
  const text = finalText ?? joined;
  if (!text.trim()) {
    throw new Error(finalText === null
      ? "stream closed without a transcript"
      : "stream ended with an empty final transcript");
  }

  return {
    text: text.trim(),
    audioMs,
    firstDeltaMs: firstDeltaAt === null ? null : firstDeltaAt - firstPcmWrittenAt,
    deltasDuringAudio: deltaTimes.filter((at) => at < lastPcmWrittenAt).length,
    deltas,
    // Without a terminal event, the last delta is the best available finish
    // estimate. A negative value is still meaningful when that final available
    // delta genuinely arrived before the audio itself finished.
    finalAfterAudioMs: (doneAt ?? lastDeltaAt ?? lastPcmWrittenAt) - lastPcmWrittenAt,
  };
}
