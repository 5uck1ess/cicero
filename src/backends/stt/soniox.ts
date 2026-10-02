import type { STTProvider, STTProviderConfig, STTTranscriptionResult } from "./provider";
import type { LivePcmSession } from "./live-client";
import { LiveSttError } from "./live-failure";
import { whisperLanguageCode } from "./language";
import { MAX_CLOUD_STT_UPLOAD_BYTES } from "./cloud-http";
import {
  checkCloudSpeechKey,
  cloudSpeechApiKey,
  cloudSpeechBackend,
  scrubProviderText,
  type CloudSpeechBackend,
} from "../cloud-speech";
import { PROVIDER_TIMEOUT_MS, requestTimeout } from "../http-transfer";
import { log } from "../../logger";

export const SONIOX_STT_URL = "wss://stt-rt.soniox.com/transcribe-websocket";

/** The slice of the WHATWG WebSocket this client uses; injectable for tests. */
export interface SonioxSocket {
  readonly readyState: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}
export type SonioxConnect = (url: string) => SonioxSocket;

const MAX_LIVE_PCM_BYTES = 8 * 1024 * 1024;
const MAX_PUSH_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 256 * 1024;
const MAX_TRANSCRIPT_CHARS = 16_384;
const MAX_PARTIAL_QUEUE = 16;
const MAX_VOCABULARY_TERMS = 200;
const LIVE_DEADLINE_MS = 180_000;
/** After the transcript resolves, how long a graceful close may take before release is forced. */
const CLOSE_GRACE_MS = 2_000;
const SOCKET_OPEN = 1;

interface SessionOptions {
  apiKey: string;
  model: string;
  /** "auto" lets Soniox sniff a WAV container; PCM states its own rate. */
  format: { kind: "auto" } | { kind: "pcm"; sampleRate: number };
  languageHints: string[];
  terms: string[];
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  onPartial?: (text: string, at: number) => void;
  connect: SonioxConnect;
  now: () => number;
}

/**
 * One Soniox real-time transcription socket.
 *
 * Audio streams while the caller is still talking; `end()` sends Soniox's
 * manual `finalize`, and the transcript resolves on the `<fin>` marker — tens
 * of milliseconds after the last audio, because everything before it was
 * already recognised. That, not a faster model, is the latency win over
 * uploading a finished utterance.
 *
 * Ownership: the socket is this session's alone. Every exit — final, server
 * error, deadline, abort — closes it, and `released` turns true only when the
 * close is confirmed (or forced after a bounded grace period).
 */
function openSonioxSession(options: SessionOptions): LivePcmSession {
  let socket: SonioxSocket | null = null;
  let opened = false;
  let settled = false;
  let ended = false;
  let finalizeSent = false;
  let released = false;
  let sentBytes = 0;
  let finalText = "";
  let lastPartial = "";
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const queued: Uint8Array[] = [];
  const partialQueue: string[] = [];
  let partialWake: (() => void) | null = null;
  let resolveFinal!: (text: string) => void;
  let rejectFinal!: (reason: Error) => void;
  const final = new Promise<string>((resolve, reject) => { resolveFinal = resolve; rejectFinal = reject; });
  void final.catch(() => {});

  const markReleased = (): void => {
    released = true;
    if (closeTimer !== undefined) { clearTimeout(closeTimer); closeTimer = undefined; }
  };
  const release = (graceful: boolean): void => {
    const current = socket;
    if (!current) { markReleased(); return; }
    try {
      if (graceful && current.readyState === SOCKET_OPEN) current.send(""); // end of audio; Soniox closes the socket
      current.close(1000);
    } catch { /* the close below is the release; a throw here means it is already closing */ }
    // Bound the release: a peer that never acknowledges the close must not
    // hold the session open. After the grace period the socket is abandoned
    // to the runtime's own teardown, and released reflects that decision.
    closeTimer = setTimeout(markReleased, CLOSE_GRACE_MS);
  };
  const settle = (outcome: { text: string } | { error: Error }): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", onAbort);
    if ("text" in outcome) resolveFinal(outcome.text.trim());
    else rejectFinal(outcome.error);
    partialWake?.(); partialWake = null;
    release("text" in outcome);
  };
  const fail = (error: Error): void => settle({ error });
  const onAbort = (): void => fail(new LiveSttError("aborted", new DOMException("live transcription aborted", "AbortError")));
  const deadline = setTimeout(
    () => fail(new LiveSttError("deadline", new Error("Soniox transcription deadline exceeded"))),
    options.timeoutMs,
  );
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const sendFinalize = (): void => {
    if (finalizeSent || !socket || !opened) return;
    finalizeSent = true;
    socket.send(JSON.stringify({ type: "finalize" }));
  };
  const sendAudio = (bytes: Uint8Array): void => {
    if (opened && socket) socket.send(bytes);
    else queued.push(bytes);
  };
  const consume = (raw: unknown): void => {
    if (typeof raw !== "string") throw new LiveSttError("server_error", new Error("Soniox sent a non-text message"));
    if (raw.length > MAX_MESSAGE_CHARS) throw new LiveSttError("server_error", new Error("Soniox message exceeds size limit"));
    let message: { tokens?: unknown; error_code?: unknown; error_type?: unknown; error_message?: unknown; finished?: unknown };
    try { message = JSON.parse(raw); } catch { throw new LiveSttError("server_error", new Error("Soniox sent malformed JSON")); }
    if (!message || typeof message !== "object") throw new LiveSttError("server_error", new Error("Soniox sent a malformed message"));
    if (message.error_code !== undefined || message.error_type !== undefined) {
      const type = scrubProviderText(message.error_type, options.apiKey) || "error";
      const detail = scrubProviderText(message.error_message, options.apiKey);
      const code = typeof message.error_code === "number" ? ` ${message.error_code}` : "";
      throw new LiveSttError("server_error", new Error(`Soniox${code} ${type}${detail ? `: ${detail}` : ""}`));
    }
    let tentative = "";
    let finalized = false;
    if (message.tokens !== undefined) {
      if (!Array.isArray(message.tokens)) throw new LiveSttError("server_error", new Error("Soniox tokens were not a list"));
      for (const token of message.tokens) {
        const text = (token as { text?: unknown })?.text;
        if (typeof text !== "string") continue;
        if (text === "<fin>") { finalized = true; continue; }
        if (text.startsWith("<") && text.endsWith(">")) continue; // <end> and other control markers
        if ((token as { is_final?: unknown }).is_final === true) finalText += text;
        else tentative += text;
      }
      if (finalText.length + tentative.length > MAX_TRANSCRIPT_CHARS) {
        throw new LiveSttError("server_error", new RangeError("Soniox transcript exceeds character limit"));
      }
      const partial = (finalText + tentative).trim();
      if (partial && partial !== lastPartial) {
        lastPartial = partial;
        if (partialQueue.length === MAX_PARTIAL_QUEUE) partialQueue.shift();
        partialQueue.push(partial);
        options.onPartial?.(partial, options.now());
        partialWake?.(); partialWake = null;
      }
    }
    // A <fin> answers our finalize; `finished` answers end-of-audio. Either one
    // after end() is the terminal transcript. An empty one means no speech.
    if (ended && (finalized || message.finished === true)) settle({ text: finalText });
  };

  if (options.signal?.aborted) onAbort();
  else {
    try {
      socket = options.connect(SONIOX_STT_URL);
      socket.binaryType = "arraybuffer";
    } catch (error: unknown) {
      fail(new LiveSttError("open_failed", error instanceof Error ? error : new Error("Soniox connection failed")));
    }
  }
  if (socket) {
    socket.onopen = () => {
      if (settled) return;
      opened = true;
      const config: Record<string, unknown> = {
        api_key: options.apiKey,
        model: options.model,
        enable_endpoint_detection: false,
      };
      if (options.format.kind === "auto") config.audio_format = "auto";
      else Object.assign(config, { audio_format: "pcm_s16le", sample_rate: options.format.sampleRate, num_channels: 1 });
      if (options.languageHints.length) config.language_hints = options.languageHints;
      if (options.terms.length) config.context = { terms: options.terms };
      try {
        socket!.send(JSON.stringify(config));
        for (const chunk of queued.splice(0)) socket!.send(chunk);
        if (ended) sendFinalize();
      } catch (error: unknown) {
        fail(new LiveSttError("push_rejected", error instanceof Error ? error : new Error("Soniox send failed")));
      }
    };
    socket.onmessage = (event) => {
      if (settled) return;
      try { consume(event.data); }
      catch (error: unknown) { fail(error instanceof Error ? error : new Error(String(error))); }
    };
    socket.onerror = () => {
      if (!settled) fail(new LiveSttError(opened ? "server_error" : "open_failed", new Error("Soniox socket error")));
    };
    socket.onclose = () => {
      markReleased();
      if (!settled) fail(new LiveSttError(opened ? "missing_terminal" : "open_failed", new Error("Soniox closed before the final transcript")));
    };
  }

  return {
    get released() { return released; },
    push(pcm) {
      if (settled || ended) throw new Error("live stream is closed");
      if (!(pcm instanceof Uint8Array) || pcm.length === 0 || pcm.length > MAX_PUSH_BYTES)
        throw new RangeError("invalid live PCM chunk");
      if (options.format.kind === "pcm" && pcm.length % 2) throw new RangeError("invalid live PCM chunk");
      if (sentBytes + pcm.length > options.maxBytes) throw new RangeError("live PCM exceeds byte limit");
      sentBytes += pcm.length;
      try { sendAudio(pcm.slice()); }
      catch (error: unknown) { fail(new LiveSttError("push_rejected", error instanceof Error ? error : new Error("Soniox send failed"))); }
    },
    end() {
      if (!ended && !settled) {
        ended = true;
        try { sendFinalize(); }
        catch (error: unknown) { fail(new LiveSttError("push_rejected", error instanceof Error ? error : new Error("Soniox finalize failed"))); }
      }
      return final;
    },
    abort() { onAbort(); },
    final,
    partials: {
      async *[Symbol.asyncIterator]() {
        while (!settled || partialQueue.length) {
          if (partialQueue.length) { yield partialQueue.shift()!; continue; }
          await new Promise<void>((resolve) => { partialWake = resolve; });
        }
      },
    },
  };
}

export interface SonioxSttDeps {
  connect?: SonioxConnect;
  fetcher?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

/**
 * Soniox real-time STT. With `openStream` (on by default) the browser's live
 * microphone PCM is transcribed during speech, so the transcript is ready as
 * the turn ends. `transcribe()` sends a finished WAV over the same socket for
 * the non-live paths; it is correct but pays roughly half the utterance
 * duration, because Soniox processes uploaded audio at about 2x real time.
 */
export class SonioxSTTProvider implements STTProvider {
  readonly name = "soniox";
  private readonly entry: CloudSpeechBackend;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly languageHints: string[];
  private readonly terms: string[];
  private readonly timeoutMs: number;
  private readonly live: boolean;
  private readonly connect: SonioxConnect;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private activeStream: LivePcmSession | null = null;

  constructor(config: STTProviderConfig, deps: SonioxSttDeps = {}) {
    this.entry = cloudSpeechBackend("stt", "soniox")!;
    this.apiKey = cloudSpeechApiKey(this.entry, config.apiKey, deps.env);
    this.model = config.model ?? this.entry.defaultModel;
    this.languageHints = config.language ? [whisperLanguageCode(config.language)] : [];
    this.terms = (config.vocabulary ?? []).slice(0, MAX_VOCABULARY_TERMS);
    this.timeoutMs = requestTimeout(config.timeout_ms, PROVIDER_TIMEOUT_MS.stt);
    this.live = config.streaming !== false;
    this.connect = deps.connect ?? ((url) => new WebSocket(url) as unknown as SonioxSocket);
    this.fetcher = deps.fetcher ?? fetch;
    this.now = deps.now ?? (() => performance.now());
  }

  get openStream(): STTProvider["openStream"] {
    return this.live ? (options) => this.openLiveStream(options) : undefined;
  }

  private openLiveStream(options: { signal?: AbortSignal; sampleRate: number; onPartial?: (text: string, at: number) => void }): LivePcmSession {
    if (!this.apiKey) throw new LiveSttError("never_opened", new Error(`Soniox API key not found; set ${this.entry.apiKeyEnv}`));
    if (!Number.isSafeInteger(options.sampleRate) || options.sampleRate < 8000 || options.sampleRate > 192000)
      throw new RangeError("invalid live PCM sample rate");
    // One live microphone at a time: a newer capture supersedes the previous socket.
    this.activeStream?.abort();
    const session = openSonioxSession({
      apiKey: this.apiKey,
      model: this.model,
      format: { kind: "pcm", sampleRate: options.sampleRate },
      languageHints: this.languageHints,
      terms: this.terms,
      maxBytes: MAX_LIVE_PCM_BYTES,
      timeoutMs: LIVE_DEADLINE_MS,
      signal: options.signal,
      onPartial: options.onPartial,
      connect: this.connect,
      now: this.now,
    });
    this.activeStream = session;
    void session.final.finally(() => { if (this.activeStream === session) this.activeStream = null; }).catch(() => {});
    return session;
  }

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
    if (!this.apiKey) return { kind: "failure", reason: `Soniox API key not found; set ${this.entry.apiKeyEnv}` };
    try {
      const file = Bun.file(audioFile);
      if (file.size > MAX_CLOUD_STT_UPLOAD_BYTES) {
        return { kind: "failure", reason: `Soniox upload refused: utterance exceeds ${MAX_CLOUD_STT_UPLOAD_BYTES} bytes` };
      }
      const audio = new Uint8Array(await file.arrayBuffer());
      const session = openSonioxSession({
        apiKey: this.apiKey,
        model: this.model,
        format: { kind: "auto" },
        languageHints: this.languageHints,
        terms: this.terms,
        maxBytes: MAX_CLOUD_STT_UPLOAD_BYTES,
        timeoutMs: this.timeoutMs,
        signal,
        connect: this.connect,
        now: this.now,
      });
      for (let offset = 0; offset < audio.length; offset += MAX_PUSH_BYTES) {
        session.push(audio.subarray(offset, offset + MAX_PUSH_BYTES));
      }
      const text = await session.end();
      signal?.throwIfAborted();
      if (text.length < 2) return { kind: "empty" };
      return { kind: "transcript", text };
    } catch (error: unknown) {
      signal?.throwIfAborted();
      const message = scrubProviderText(error instanceof Error ? error.message : String(error), this.apiKey);
      return { kind: "failure", reason: `Soniox transcription failed: ${message}` };
    }
  }

  async health(): Promise<boolean> {
    const result = await checkCloudSpeechKey(this.entry, this.apiKey, { fetcher: this.fetcher });
    if (!result.ok) log("info", `Soniox STT health: ${result.reason}`);
    return result.ok;
  }

  async stop(): Promise<void> {
    this.activeStream?.abort();
    this.activeStream = null;
  }
}
