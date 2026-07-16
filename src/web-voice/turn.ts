import { unlink } from "node:fs/promises";
import type { Brain } from "../types";
import type { STTProvider } from "../backends/stt/provider";
import type { TTSProvider } from "../backends/tts/provider";
import { segmentSentences } from "../speaker/sentence-stream";
import { newTurnTimer } from "../timing";
import { log } from "../logger";
import type { PreparedFiller } from "../speaker/filler-bank";
import type { SpeculativeTurn } from "./speculative";
import { beginOwnedTone, settleTone, type OwnedTone, type ToneOptions } from "./tone";
import { writeSecureTempAudio } from "../platform/secure-temp-audio";
import {
  MAX_DECODED_WAV_BYTES,
  MAX_DECODED_WAV_DURATION_MS,
  inspectWavMetadata,
  snapshotSynthesizedWav,
  type WavMetadata,
} from "../platform/wav";

/**
 * Dependencies for a web-voice turn — the same providers the host-mic path uses,
 * narrowed to the one method each so the turn logic is trivially testable.
 */
export interface WebTurnDeps {
  stt: Pick<STTProvider, "transcribe">;
  brain: Pick<Brain, "send"> & { wasControlTurn?: Brain["wasControlTurn"] };
  tts: Pick<TTSProvider, "generateAudio">;
  /** Optional TLDR gate — see {@link TldrOptions}. Omit to speak every sentence. */
  tldr?: TldrOptions;
  /** Optional input-side tone tag — see {@link ToneOptions}. Omit for untagged turns. */
  tone?: ToneOptions;
  /**
   * Maximum encoded bytes retained in the final synthesized WAV, including
   * its RIFF header. Transport callers should pass their response-body limit.
   */
  maxAudioBytes?: number;
  /** Cancels this transport-owned turn during server quiescence. */
  signal?: AbortSignal;
  /** Retains latency-raced work until the transport's shutdown drain. */
  trackBackground?: (task: Promise<void>) => boolean;
  /** Per-invocation daemon snapshot. Omitted on non-conversational surfaces. */
  operationalContext?: (signal?: AbortSignal) => Promise<string | null>;
}

export interface WebTurnResult {
  transcript: string;
  reply: string;
  /** Synthesized reply audio (WAV). Empty when there was nothing to say. */
  audio: ArrayBuffer;
}

const EMPTY = new ArrayBuffer(0);
export const OPERATIONAL_CONTEXT_CAPTURE_TIMEOUT_MS = 750;

function throwIfTurnAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("Web voice turn aborted", "AbortError");
}

async function retainOwnedTone(
  tone: OwnedTone | null,
  trackBackground: ((task: Promise<void>) => boolean) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!tone || tone.settled()) return;
  if (trackBackground?.(tone.drain)) return;
  // A transport signal without a tracker still requires foreground ownership.
  // Pure library callers preserve the documented grace-window latency while
  // the always-observed tone promise safely finishes on its own.
  if (trackBackground || signal) await tone.drain;
}

/**
 * Process one browser-captured utterance end-to-end, reusing the existing
 * pipeline at the provider level: WAV → STT → brain → TTS → reply WAV.
 *
 * This is the headless web equivalent of {@link CiceroDaemon.handleCommand}'s brain
 * branch, but provider-only (no host speaker / conversational listener), so the
 * working Mac path is untouched. Streaming + routing come in later phases.
 */
export async function processWebTurn(wav: ArrayBuffer, deps: WebTurnDeps): Promise<WebTurnResult> {
  const maxAudioBytes = webTurnAudioLimit(deps.maxAudioBytes);
  throwIfTurnAborted(deps.signal);
  // Tone classifies in parallel with STT (same WAV, different question) and
  // the brain input waits for it at most the grace window past the transcript.
  const tonePending = beginOwnedTone(deps.tone, wav, "web turn tone classification");
  let tmpFile: string | undefined;
  try {
    tmpFile = await writeSecureTempAudio(wav, { prefix: "cicero-web" });
    throwIfTurnAborted(deps.signal);
    const transcript = (await deps.stt.transcribe(tmpFile))?.trim() ?? "";
    throwIfTurnAborted(deps.signal);
    if (!transcript) return { transcript: "", reply: "", audio: EMPTY };

    // Expand request: speak the gated remainder of the previous reply, no brain turn.
    if (deps.tldr?.pending && isExpandRequest(transcript)) {
      const detail = deps.tldr.pending();
      if (detail) {
        const providerAudio = await deps.tts.generateAudio(detail);
        throwIfTurnAborted(deps.signal);
        const audio = admitProviderAudio(providerAudio, maxAudioBytes);
        return {
          transcript,
          reply: detail,
          audio: concatWavs(audio.byteLength > 0 ? [audio] : [], maxAudioBytes),
        };
      }
    }

    const tag = await settleTone(tonePending?.result ?? null, deps.tone?.graceMs);
    throwIfTurnAborted(deps.signal);
    const systemContext = await captureOperationalContext(deps.operationalContext, deps.signal);
    throwIfTurnAborted(deps.signal);
    const reply = (await deps.brain.send(
      tag ? `${transcript}\n\n${tag}` : transcript,
      { signal: deps.signal, systemContext: systemContext ?? undefined },
    )).trim();
    throwIfTurnAborted(deps.signal);
    if (!reply) return { transcript, reply: "", audio: EMPTY };

    // The reply text stays complete (logs, history); only the VOICE is gated.
    // Rendered sentence-by-sentence like the streaming path, so per-sentence
    // voice resolution (lane voices, the roll call) works on this path too,
    // then concatenated into the single WAV this API returns.
    const control = deps.brain.wasControlTurn?.() ?? false;
    const spoken = control ? reply : await gateForSpeech(reply, deps.tldr);
    // Validate and budget every provider result before retaining the next one.
    // This keeps a malicious/broken TTS from building an unbounded parts array
    // only to fail at the final concatenation boundary.
    const parts = new WavPartsBuilder(
      maxAudioBytes,
      retainedWavPartsLimit(maxAudioBytes),
    );
    for await (const raw of segmentSentences(oneChunk(spoken))) {
      throwIfTurnAborted(deps.signal);
      const s = raw.trim();
      if (!s) continue;
      const providerAudio = await deps.tts.generateAudio(s);
      throwIfTurnAborted(deps.signal);
      const part = admitProviderAudio(providerAudio, maxAudioBytes);
      if (part.byteLength > 0) {
        // Same speaker-change beat as the streaming path (see SPEAKER_BEAT_MS).
        if (control && parts.hasParts) {
          const beat = silenceWavLike(SPEAKER_BEAT_MS, part);
          parts.appendMany(beat.byteLength > 0 ? [beat, part] : [part]);
        } else {
          parts.append(part);
        }
      }
    }
    return { transcript, reply, audio: parts.finish() };
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("web voice turn failed", { cause: error });
  } finally {
    await retainOwnedTone(tonePending, deps.trackBackground, deps.signal);
    if (tmpFile) await unlink(tmpFile).catch(() => { /* best-effort cleanup */ });
  }
}

/** Dependencies for a STREAMING web turn (Phase 2): brain must be able to stream. */
export interface WebStreamDeps {
  stt: Pick<STTProvider, "transcribe">;
  brain: Pick<Brain, "send"> & { sendStream?: Brain["sendStream"]; wasControlTurn?: Brain["wasControlTurn"] };
  tts: Pick<TTSProvider, "generateAudio">;
  /** Optional per-daemon-session voice controls for instant spoken commands. */
  voice?: VoiceControlOptions;
  /**
   * Optional instant filler to cover the brain's time-to-first-token. Called
   * once per turn (after the transcript, before the brain) and, if it returns a
   * pre-rendered clip, played ONLY when the brain's first sentence hasn't
   * arrived within {@link WebStreamDeps.fillerDelayMs} — a fast reply gets
   * natural silence, not a verbal tic. Omit it (the default) for no filler.
   */
  filler?: (transcript?: string) => PreparedFiller | undefined;
  /** How long the reply may take before the filler speaks (default 1200ms; 0 = immediately). */
  fillerDelayMs?: number;
  /** Optional TLDR gate — see {@link TldrOptions}. Omit to speak every sentence. */
  tldr?: TldrOptions;
  /** Optional interruption recovery — see {@link InterruptRecovery}. Omit to forget interrupted replies. */
  recover?: InterruptRecovery;
  /** Optional completed-reply replay — see {@link LastReplyOptions}. */
  lastReply?: LastReplyOptions;
  /** Optional long-turn parking — see {@link LongTurnOptions}. Omit to wait out slow turns in silence. */
  park?: LongTurnOptions;
  /** Optional input-side tone tag — see {@link ToneOptions}. Omit for untagged turns. */
  tone?: ToneOptions;
  /** Cancels the transport-owned turn and its brain invocation. */
  signal?: AbortSignal;
  /** Register work intentionally detached after long-turn parking. */
  /** False keeps the parked work foreground-owned when the host is at capacity. */
  trackBackground?: (task: Promise<void>) => boolean;
  /** Per-invocation daemon snapshot. Captured only when this path starts the brain. */
  operationalContext?: (signal?: AbortSignal) => Promise<string | null>;
}

/**
 * Long-turn parking: when the brain hasn't produced its FIRST sentence within
 * `afterMs` (a deep tool loop, a slow delegate), the turn stops holding the
 * floor — a short hand-back line is spoken, the client's turn closes, and the
 * brain keeps running detached. The eventual reply is handed to `onParked`
 * (the daemon routes it through the notify path, so it arrives spoken in the
 * lane's voice plus as a Telegram voice note). A turn that has already said
 * ANYTHING aloud never parks — parking only rescues dead air, it never cuts a
 * reply in half.
 */
export interface LongTurnOptions {
  /** Park when no reply sentence has arrived within this. */
  afterMs: number;
  /** Give up on a parked brain after this long (default 10 minutes). */
  maxBackgroundMs?: number;
  /** The spoken hand-back (rendered by the turn's TTS, so it lands in the current speaker's voice). */
  line?: string;
  /** Receives the finished (possibly partial, on cap/error) reply once it lands. Empty reply = nothing came back. */
  onParked: (reply: string, transcript: string) => void | Promise<void>;
}

export const DEFAULT_PARK_LINE =
  "This one's taking a while — I'll keep working on it and speak up when it's done.";

/**
 * TLDR speech gate: long replies aren't read aloud in full. The first `cap`
 * sentences stream to TTS as usual (latency untouched); the rest still reaches
 * the chat pane as text but stays silent, and the turn closes with one spoken
 * summary line offering the details. A follow-up "details"/"tell me more"
 * speaks the stored remainder without a brain turn.
 */
export interface TldrOptions {
  /** Speak at most this many reply sentences verbatim. */
  cap: number;
  /** Optional LLM summarizer for the unspoken remainder (one short sentence). */
  summarize?: (text: string) => Promise<string>;
  /** Receives the unspoken remainder for a later expand request. */
  store?: (remainder: string) => void;
  /** Returns the stored remainder (and keeps it) — consulted on expand requests. */
  pending?: () => string | null;
}

/** Last completed spoken reply, for a no-brain "repeat that" replay. */
export interface LastReplyOptions {
  /** Receives the text that was actually spoken after a clean completed turn. */
  store: (spokenReply: string) => void;
  /** Returns the last completed spoken reply, if any. */
  pending: () => string | null;
}

const EXPAND_RE = /^(?:ok[,\s]+)?(?:tell me more|more details?|(?:the )?details|give me the details|expand(?: on that)?|full version|read it all|read the rest|hear the rest)(?: please)?\s*[.,!?]*$/i;

/** True when the utterance asks to hear the gated remainder of the last reply. */
export function isExpandRequest(text: string): boolean {
  // STT decorates freely ("Details, please.") — strip interior commas so the
  // phrase list only has to cover word sequences, not punctuation variants.
  return EXPAND_RE.test(text.trim().replace(/,/g, ""));
}

const REPEAT_RE = /^(?:ok[\s]+)?(?:repeat that|say that again|what did you say)(?: please)?\s*[.,!?]*$/i;

/** True when the utterance asks to hear the last completed spoken reply again. */
export function isRepeatRequest(text: string): boolean {
  return REPEAT_RE.test(text.trim().replace(/,/g, ""));
}

export interface VoiceControlState {
  volume: number;
  rate: number;
}

export interface VoiceControlOptions {
  state: VoiceControlState;
}

export interface VoiceControlResult {
  type: "volume" | "rate" | "reset";
  ack: string;
  volume: number;
  rate: number;
  delta?: number;
}

export const DEFAULT_VOICE_CONTROL_STATE: VoiceControlState = { volume: 1.0, rate: 1.0 };
export const VOICE_VOLUME_STEP = 0.2;
export const VOICE_RATE_STEP = 0.15;
export const VOICE_VOLUME_MIN = 0.2;
export const VOICE_VOLUME_MAX = 2.0;
export const VOICE_RATE_MIN = 0.7;
export const VOICE_RATE_MAX = 1.4;

const LOUDER_RE = /^(?:ok[\s]+)?(?:louder|speak up|turn (?:it )?up)(?: please)?\s*[.,!?]*$/i;
const QUIETER_RE = /^(?:ok[\s]+)?(?:quieter|speak softer|lower (?:the )?volume|turn (?:it )?down)(?: please)?\s*[.,!?]*$/i;
const FASTER_RE = /^(?:ok[\s]+)?(?:faster|speak faster|speed up)(?: please)?\s*[.,!?]*$/i;
const SLOWER_RE = /^(?:ok[\s]+)?(?:slower|speak slower|slow down)(?: please)?\s*[.,!?]*$/i;
const RESET_VOICE_RE = /^(?:ok[\s]+)?(?:normal speed|reset voice)(?: please)?\s*[.,!?]*$/i;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Apply a whole-utterance spoken voice-control command, or return null. */
export function applyVoiceControl(text: string, state: VoiceControlState): VoiceControlResult | null {
  const normalized = text.trim().replace(/,/g, "");
  if (LOUDER_RE.test(normalized)) {
    const before = state.volume;
    state.volume = clamp(state.volume + VOICE_VOLUME_STEP, VOICE_VOLUME_MIN, VOICE_VOLUME_MAX);
    return { type: "volume", ack: "Louder.", volume: state.volume, rate: state.rate, delta: state.volume - before };
  }
  if (QUIETER_RE.test(normalized)) {
    const before = state.volume;
    state.volume = clamp(state.volume - VOICE_VOLUME_STEP, VOICE_VOLUME_MIN, VOICE_VOLUME_MAX);
    return { type: "volume", ack: "Quieter.", volume: state.volume, rate: state.rate, delta: state.volume - before };
  }
  if (FASTER_RE.test(normalized)) {
    state.rate = clamp(state.rate + VOICE_RATE_STEP, VOICE_RATE_MIN, VOICE_RATE_MAX);
    return { type: "rate", ack: "Faster.", volume: state.volume, rate: state.rate };
  }
  if (SLOWER_RE.test(normalized)) {
    state.rate = clamp(state.rate - VOICE_RATE_STEP, VOICE_RATE_MIN, VOICE_RATE_MAX);
    return { type: "rate", ack: "Slower.", volume: state.volume, rate: state.rate };
  }
  if (RESET_VOICE_RE.test(normalized)) {
    state.volume = DEFAULT_VOICE_CONTROL_STATE.volume;
    state.rate = DEFAULT_VOICE_CONTROL_STATE.rate;
    return { type: "reset", ack: "Normal voice.", volume: state.volume, rate: state.rate };
  }
  return null;
}

/**
 * Interruption recovery: when a barge-in cuts a reply off mid-sentence, the
 * pipeline remembers what was actually SPOKEN, so a later "continue" / "go on"
 * can hand the brain that prefix and ask it to pick the thread back up
 * ("as I was saying…") instead of starting a brand-new answer.
 */
export interface InterruptRecovery {
  /** Called when a turn is aborted after speech started: the spoken tail of the reply. */
  store: (spokenPrefix: string) => void;
  /** The interrupted reply's spoken tail, if recent enough to resume (one-shot). */
  pending: () => string | null;
}

const RESUME_RE = /^(?:ok[\s]+|so[\s]+)?(?:continue|go on|keep going|carry on|as you were(?: saying)?|what were you saying|where were you|finish (?:that|your) (?:thought|sentence|reply))(?: please)?\s*[.,!?]*$/i;

/** True when the utterance asks to resume an interrupted reply. */
export function isResumeRequest(text: string): boolean {
  return RESUME_RE.test(text.trim().replace(/,/g, ""));
}

/**
 * True when {@link streamReply} would answer this utterance WITHOUT a brain
 * turn (voice controls, "repeat that", "details", "continue"). The speculative
 * path must not start a brain turn for these — it would never be consumed and
 * would pollute the agent's conversation with a phantom exchange.
 */
export function isLocalFastPath(text: string): boolean {
  const normalized = text.trim().replace(/,/g, "");
  return (
    isRepeatRequest(normalized) ||
    isExpandRequest(normalized) ||
    isResumeRequest(normalized) ||
    LOUDER_RE.test(normalized) ||
    QUIETER_RE.test(normalized) ||
    FASTER_RE.test(normalized) ||
    SLOWER_RE.test(normalized) ||
    RESET_VOICE_RE.test(normalized)
  );
}

/**
 * Non-streaming counterpart of the gate in {@link streamReply}, for paths that
 * render one WAV per turn (the Telegram call bridge's /api/turn). Returns the
 * text to SPEAK: the whole reply when it's short, otherwise the first `cap`
 * sentences plus the summary coda, storing the remainder for "details".
 */
async function gateForSpeech(reply: string, tldr?: TldrOptions): Promise<string> {
  if (!tldr) return reply;
  const sentences: string[] = [];
  for await (const raw of segmentSentences(oneChunk(reply))) {
    const s = raw.trim();
    if (s) sentences.push(s);
  }
  if (sentences.length <= tldr.cap) return reply;
  const remainder = sentences.slice(tldr.cap).join(" ");
  tldr.store?.(remainder);
  let coda = `Plus ${sentences.length - tldr.cap} more sentences in the log — say "details" if you want them read out.`;
  if (tldr.summarize) {
    try {
      coda = `In short: ${(await tldr.summarize(remainder)).trim()} Say "details" for the full version.`;
    } catch { /* summarizer down — the generic coda still tells the user there's more */ }
  }
  return `${sentences.slice(0, tldr.cap).join(" ")} ${coda}`;
}

/**
 * Where a streaming turn pushes its output. The web-voice server implements this
 * by sending WebSocket messages (JSON for text/control, binary for audio). Kept
 * transport-agnostic so the turn logic is testable with a capturing fake.
 */
export interface WebReplySink {
  transcript(text: string): void;     // what STT heard
  sentence(text: string): void;       // a reply sentence (text), sent before its audio
  audio(wav: ArrayBuffer): void;      // synthesized audio for the most recent sentence
  control(message: { type: "volume"; delta: number; volume: number } | { type: "rate"; rate: number }): void;
  done(): void;                        // turn complete
  error(message: string): void;
  /** True once the client asked to abort (barge-in). Checked between sentences. */
  aborted(): boolean;
}

async function* oneChunk(text: string): AsyncGenerator<string> {
  yield text;
}

/** Keep a batch brain call lazy so abort polling starts while it is pending. */
async function* oneChunkPromise(text: Promise<string>): AsyncGenerator<string> {
  yield await text;
}

/** Admit one provider result immediately; zero bytes retain legacy "no clip" semantics. */
function admitProviderAudio(
  audio: ArrayBuffer,
  maxBytes = MAX_CONCATENATED_WAV_BYTES,
): ArrayBuffer {
  return snapshotSynthesizedWav(audio, { maxBytes, allowEmpty: true }).audio;
}

function webTurnAudioLimit(requested: number | undefined): number {
  const limit = requested ?? MAX_CONCATENATED_WAV_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_CONCATENATED_WAV_BYTES) {
    throw new RangeError(
      `web-turn synthesized audio limit must be an integer between 1 and ${MAX_CONCATENATED_WAV_BYTES}`,
    );
  }
  return limit;
}

/**
 * A WAV's audio duration in ms from its header + data chunk; null when it
 * isn't parseable PCM. Used as the speculative-adoption gate: comparing the
 * final utterance's duration against the probed one is how we know nothing
 * new was said — without paying for a second transcription.
 */
export function wavDurationMs(buf: ArrayBuffer): number | null {
  try {
    return inspectWavMetadata(buf, {
      maxDurationMs: MAX_DECODED_WAV_DURATION_MS,
      allowEmpty: false,
    }).durationMs;
  } catch {
    return null;
  }
}

interface WavSegment {
  source: ArrayBuffer;
  header: Uint8Array;
  data: Uint8Array;
  metadata: WavMetadata;
}

/** Locate and admit a composable PCM WAV (no fixed-44-byte assumption). */
function riffData(buf: ArrayBuffer): WavSegment {
  if (buf.byteLength > MAX_CONCATENATED_WAV_BYTES) {
    throw new Error(`WAV clip exceeds the ${MAX_CONCATENATED_WAV_BYTES}-byte limit`);
  }
  // WavPartsBuilder may hold this segment while later provider calls await.
  // Take its own snapshot even when an upstream boundary already copied it.
  const snapshot = snapshotSynthesizedWav(buf);
  const metadata = snapshot.metadata;
  if (!metadata) throw new Error("cannot compose an empty WAV");
  if (metadata.fmtOffset >= metadata.dataOffset) {
    throw new Error("cannot compose a WAV whose fmt chunk follows its data chunk");
  }
  // Rewriting RIFF/data sizes would leave a WAVE_FORMAT_IEEE_FLOAT `fact`
  // sample count stale. TTS providers emit PCM in practice, so restrict the
  // generated-composition boundary instead of publishing false metadata.
  if (metadata.audioFormat !== 1) {
    throw new Error("cannot compose a non-PCM WAV safely");
  }
  return {
    source: snapshot.audio,
    header: new Uint8Array(snapshot.audio, 0, metadata.dataOffset),
    data: new Uint8Array(snapshot.audio, metadata.dataOffset, metadata.dataLength),
    metadata,
  };
}

/**
 * Concatenate same-format WAVs (all from the same TTS engine config) into one:
 * the first file's header, everyone's samples, sizes rewritten.
 */
/**
 * How long a colleague waits before speaking after someone else — the beat a
 * human takes when the floor changes hands. Applied between sentences of
 * control turns (roll call, standup, transfer acks), where each sentence is a
 * different speaker; back-to-back clips there sound like one rushed robot.
 */
export const SPEAKER_BEAT_MS = 450;
export const MAX_CONCATENATED_WAV_BYTES = MAX_DECODED_WAV_BYTES;
const MAX_RETAINED_WAV_PARTS_OVERHEAD_BYTES = 1024 * 1024;
const MAX_RETAINED_WAV_PARTS = 4_096;
const MAX_INSERTED_SILENCE_MS = 10_000;

function retainedWavPartsLimit(maxOutputBytes: number): number {
  return Math.min(
    MAX_CONCATENATED_WAV_BYTES + MAX_RETAINED_WAV_PARTS_OVERHEAD_BYTES,
    maxOutputBytes + MAX_RETAINED_WAV_PARTS_OVERHEAD_BYTES,
  );
}

/**
 * A silence clip matching `like`'s WAV format (sample rate / channels / bit
 * depth read from its canonical header), so it can sit next to real clips in
 * a stream or inside concatWavs without a format mismatch.
 */
export function silenceWavLike(ms: number, like: ArrayBuffer): ArrayBuffer {
  try {
    if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_INSERTED_SILENCE_MS) {
      return new ArrayBuffer(0);
    }
    const source = riffData(like);
    const frames = Math.round((source.metadata.sampleRate * ms) / 1_000);
    const dataBytes = frames * source.metadata.blockAlign;
    const outputBytes = source.header.byteLength + dataBytes + (dataBytes & 1);
    if (!Number.isSafeInteger(outputBytes) || outputBytes > MAX_CONCATENATED_WAV_BYTES) {
      return new ArrayBuffer(0);
    }

    const out = new Uint8Array(outputBytes);
    out.set(source.header);
    if (source.metadata.audioFormat === 1 && source.metadata.bitsPerSample === 8) {
      // The RIFF pad byte remains zero; only actual unsigned PCM samples use
      // the 128 midpoint.
      out.fill(128, source.header.byteLength, source.header.byteLength + dataBytes);
    }
    const view = new DataView(out.buffer);
    view.setUint32(4, out.byteLength - 8, true);
    view.setUint32(source.metadata.dataOffset - 4, dataBytes, true);
    return out.buffer;
  } catch {
    return new ArrayBuffer(0);
  }
}

export function concatWavs(
  parts: ArrayBuffer[],
  maxBytes = MAX_CONCATENATED_WAV_BYTES,
): ArrayBuffer {
  if (!Number.isSafeInteger(maxBytes)
    || maxBytes <= 0
    || maxBytes > MAX_CONCATENATED_WAV_BYTES) {
    throw new RangeError(
      `WAV concatenation limit must be an integer between 1 and ${MAX_CONCATENATED_WAV_BYTES}`,
    );
  }
  const builder = new WavPartsBuilder(maxBytes, retainedWavPartsLimit(maxBytes));
  builder.appendMany(parts);
  return builder.finish();
}

/**
 * Incrementally validate and budget WAV parts before retaining them. The
 * output and aggregate-duration limits are checked on every append, while the
 * separate retained-byte limit also accounts for the repeated provider
 * headers held until the final one-shot allocation.
 */
class WavPartsBuilder {
  private readonly segments: WavSegment[] = [];
  private retainedBytes = 0;
  private dataBytes = 0;
  private frameCount = 0;

  constructor(
    private readonly maxOutputBytes: number,
    private readonly maxRetainedBytes: number,
  ) {}

  get hasParts(): boolean { return this.segments.length > 0; }

  append(part: ArrayBuffer): void {
    this.appendMany([part]);
  }

  appendMany(parts: ArrayBuffer[]): void {
    const pending: WavSegment[] = [];
    let retainedBytes = this.retainedBytes;
    let dataBytes = this.dataBytes;
    let frameCount = this.frameCount;
    let first = this.segments[0];

    for (const part of parts) {
      if (part.byteLength === 0) continue;
      if (this.segments.length + pending.length >= MAX_RETAINED_WAV_PARTS) {
        throw new Error(`WAV composition exceeds the ${MAX_RETAINED_WAV_PARTS}-part limit`);
      }
      if (part.byteLength > this.maxRetainedBytes - retainedBytes) {
        throw new Error(`retained WAV clips exceed the ${this.maxRetainedBytes}-byte limit`);
      }
      const segment = riffData(part);
      first ??= segment;
      if (!sameWavFormat(first.metadata, segment.metadata)) {
        throw new Error("cannot concatenate WAVs with different PCM formats");
      }

      const nextDataBytes = dataBytes + segment.data.byteLength;
      const nextOutputBytes = first.header.byteLength + nextDataBytes + (nextDataBytes & 1);
      if (!Number.isSafeInteger(nextOutputBytes) || nextOutputBytes > this.maxOutputBytes) {
        throw new Error(`concatenated WAV exceeds the ${this.maxOutputBytes}-byte limit`);
      }

      const maxFrames = Math.floor(
        (first.metadata.sampleRate * MAX_DECODED_WAV_DURATION_MS) / 1_000,
      );
      if (segment.metadata.frameCount > maxFrames - frameCount) {
        throw new Error(
          `concatenated WAV duration exceeds the ${MAX_DECODED_WAV_DURATION_MS}ms limit`,
        );
      }

      retainedBytes += part.byteLength;
      dataBytes = nextDataBytes;
      frameCount += segment.metadata.frameCount;
      pending.push(segment);
    }

    for (const segment of pending) this.segments.push(segment);
    this.retainedBytes = retainedBytes;
    this.dataBytes = dataBytes;
    this.frameCount = frameCount;
  }

  finish(): ArrayBuffer {
    if (this.segments.length === 0) return new ArrayBuffer(0);
    if (this.segments.length === 1) {
      const source = this.segments[0]!.source;
      if (source.byteLength > this.maxOutputBytes) {
        throw new Error(`concatenated WAV exceeds the ${this.maxOutputBytes}-byte limit`);
      }
      return source;
    }

    const first = this.segments[0]!;
    const outputBytes = first.header.byteLength + this.dataBytes + (this.dataBytes & 1);
    const out = new Uint8Array(outputBytes);
    out.set(first.header, 0);
    let offset = first.header.byteLength;
    for (const segment of this.segments) {
      out.set(segment.data, offset);
      offset += segment.data.byteLength;
    }
    const view = new DataView(out.buffer);
    view.setUint32(4, out.byteLength - 8, true);
    view.setUint32(first.metadata.dataOffset - 4, this.dataBytes, true);
    return out.buffer;
  }
}

function sameWavFormat(left: WavMetadata, right: WavMetadata): boolean {
  return left.audioFormat === right.audioFormat
    && left.channels === right.channels
    && left.sampleRate === right.sampleRate
    && left.byteRate === right.byteRate
    && left.blockAlign === right.blockAlign
    && left.bitsPerSample === right.bitsPerSample;
}

/**
 * Make a token stream abort-responsive: poll `isAborted` while WAITING for the
 * next token, not just between sentences. `cancelSource` reaches signal-aware
 * brains immediately; generator finalization remains a compatibility fallback.
 */
async function* abortable(
  src: AsyncIterable<string>,
  isAborted: () => boolean,
  cancelSource?: () => void,
  drainSource = false,
  trackFinalization?: (task: Promise<void>) => boolean,
): AsyncGenerator<string> {
  const it = src[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const next = it.next();
      let result: IteratorResult<string> | null = null;
      while (result === null) {
        result = await Promise.race([next, Bun.sleep(200).then(() => null)]);
        if (result === null && isAborted()) {
          cancelSource?.();
          // Signal-aware sources commonly reject their pending next() with an
          // AbortError. Observe it even though this wrapper is returning now.
          void next.catch(() => {});
          return;
        }
      }
      if (result.done) { completed = true; return; }
      yield result.value;
    }
  } finally {
    // The polling branch may already have cancelled a silent source; finalizer
    // cancellation is deliberately idempotent for consumer-driven return().
    if (!completed) cancelSource?.();
    let finalization: Promise<void>;
    try {
      finalization = Promise.resolve(it.return?.(undefined)).then(() => undefined);
    } catch (error: unknown) {
      finalization = Promise.reject(error);
    }
    if (drainSource) {
      try {
        await finalization;
      } catch (error: unknown) {
        log("warn", `speculative token finalization failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      return;
    }
    const observedFinalization = finalization.catch((error: unknown) => {
      log("warn", `brain token finalization failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (trackFinalization && !trackFinalization(observedFinalization)) {
      await observedFinalization;
    } else if (!trackFinalization) {
      void observedFinalization;
    }
  }
}

/**
 * Streaming version of {@link processWebTurn}: transcribe, then stream the brain's
 * reply sentence-by-sentence — synthesizing and emitting each sentence's audio as
 * soon as it's ready, so the first audio plays while later sentences still generate.
 * Mirrors the host path's {@link streamBrainToSpeaker}, but emits to a {@link WebReplySink}.
 */
export async function streamWebTurn(
  wav: ArrayBuffer,
  deps: WebStreamDeps,
  sink: WebReplySink,
  spec?: SpeculativeTurn | null,
): Promise<void> {
  const timer = newTurnTimer();
  if (deps.signal?.aborted || sink.aborted()) return;

  // A speculative turn raced ahead on the probe tail (see speculative.ts).
  // Adopt it when the final WAV's duration says nothing new was said — the
  // tail transcript IS the transcript, and the brain may already be talking.
  if (spec?.claim()) {
    const finalMs = wavDurationMs(wav);
    if (finalMs !== null && spec.coverageOk(finalMs)) {
      const transcript = (await spec.transcript())?.trim() ?? "";
      if (deps.signal?.aborted || sink.aborted()) {
        await spec.abort();
        return;
      }
      if (transcript) {
        timer.mark("stt");
        sink.transcript(transcript);
        try {
          await streamReply(transcript, deps, sink, timer, spec.tokens() ?? undefined);
        } catch (err: unknown) {
          sink.error(err instanceof Error ? err.message : String(err));
        } finally {
          // Token exhaustion is not the whole speculative lifetime: the probe
          // tone classifier (and third-party provider work) may still be live.
          // abort() is the turn's idempotent completion/cleanup barrier.
          await spec.abort();
          timer.report("web-turn-speculative");
        }
        return;
      }
    }
    await spec.abort(); // longer utterance / unparseable WAV / dry STT — full pipeline below
  }

  // Tone classifies in parallel with STT (same WAV, different question); the
  // adopted-speculation path above skips it — its brain input was tagged (or
  // not) at speculation time, from the probe tail.
  const tonePending = beginOwnedTone(deps.tone, wav, "streaming web turn tone classification");
  let tmpFile: string | undefined;
  try {
    tmpFile = await writeSecureTempAudio(wav, { prefix: "cicero-web" });
    if (deps.signal?.aborted || sink.aborted()) return;
    const transcript = (await deps.stt.transcribe(tmpFile))?.trim() ?? "";
    if (deps.signal?.aborted || sink.aborted()) return;
    timer.mark("stt");
    sink.transcript(transcript);
    if (!transcript) { sink.done(); return; }
    const tag = await settleTone(tonePending?.result ?? null, deps.tone?.graceMs);
    await streamReply(transcript, deps, sink, timer, undefined, tag);
  } catch (err: unknown) {
    sink.error(err instanceof Error ? err.message : String(err));
  } finally {
    timer.report("web-turn");
    await retainOwnedTone(tonePending, deps.trackBackground, deps.signal);
    if (tmpFile) await unlink(tmpFile).catch(() => { /* best-effort cleanup */ });
  }
}

/**
 * A typed turn: same reply pipeline as {@link streamWebTurn} minus STT. The
 * text is echoed back as the transcript so the client renders it like a
 * spoken utterance.
 */
export async function streamWebTextTurn(text: string, deps: WebStreamDeps, sink: WebReplySink): Promise<void> {
  const timer = newTurnTimer();
  try {
    if (deps.signal?.aborted || sink.aborted()) return;
    const transcript = text.trim();
    sink.transcript(transcript);
    if (!transcript) { sink.done(); return; }
    await streamReply(transcript, deps, sink, timer);
  } catch (err: unknown) {
    sink.error(err instanceof Error ? err.message : String(err));
  } finally {
    timer.report("web-text-turn");
  }
}

async function speakDirect(text: string, deps: WebStreamDeps, sink: WebReplySink): Promise<string[]> {
  const spokenTexts: string[] = [];
  for await (const raw of segmentSentences(oneChunk(text))) {
    if (sink.aborted()) break;
    const s = raw.trim();
    if (!s) continue;
    sink.sentence(s);
    const audio = admitProviderAudio(
      await deps.tts.generateAudio(s, undefined, { speed: deps.voice?.state.rate }),
    );
    if (sink.aborted()) break;
    if (audio.byteLength > 0) {
      sink.audio(audio);
      spokenTexts.push(s);
    }
  }
  sink.done();
  return spokenTexts;
}

/** Shared reply pipeline: transcript → brain stream → sentences → TTS → sink.
 * `pretokens` (an adopted speculative turn's buffered brain stream) replaces
 * the brain call — everything downstream is identical. `toneTag` (the settled
 * input-tone verdict, if informative) rides into the brain input only — the
 * local fast paths above the brain never see it. */
async function streamReply(
  transcript: string,
  deps: WebStreamDeps,
  sink: WebReplySink,
  timer: ReturnType<typeof newTurnTimer>,
  pretokens?: AsyncIterable<string>,
  toneTag?: string | null,
): Promise<void> {
  // Spoken voice controls are session-local fast paths: no brain turn, no
  // conversation-state perturbation. Volume applies on the client before the
  // acknowledgement audio, so "Louder." is heard at the new level.
  if (deps.voice) {
    const control = applyVoiceControl(transcript, deps.voice.state);
    if (control) {
      if (control.type === "volume") {
        sink.control({ type: "volume", delta: control.delta ?? 0, volume: control.volume });
      } else {
        sink.control({ type: "rate", rate: control.rate });
      }
      const spoken = await speakDirect(control.ack, deps, sink);
      if (spoken.length > 0) deps.lastReply?.store(spoken.join(" "));
      return;
    }
  }

  // Repeat request: replay the last completed spoken reply verbatim — no brain
  // turn, so this is instant and doesn't perturb the agent's conversation state.
  if (deps.lastReply && isRepeatRequest(transcript)) {
    const replay = deps.lastReply.pending() || "I haven't said anything yet.";
    const spoken = await speakDirect(replay, deps, sink);
    if (spoken.length > 0 && replay !== "I haven't said anything yet.") {
      deps.lastReply.store(spoken.join(" "));
    }
    return;
  }

  // Expand request: speak the gated remainder of the previous reply directly —
  // no brain turn, so it works even while the agent is busy elsewhere.
  if (deps.tldr?.pending && isExpandRequest(transcript)) {
    const detail = deps.tldr.pending();
    if (detail) {
      const spoken = await speakDirect(detail, deps, sink);
      if (spoken.length > 0) deps.lastReply?.store(spoken.join(" "));
      return;
    }
  }

  // Resume request: the user barged in earlier and now wants the rest. The
  // brain gets its own spoken prefix back with instructions to continue —
  // through the normal turn path, so the pinned lane's persona does the
  // resuming ("as I was saying…"), not a canned playback.
  let brainInput = transcript;
  if (deps.recover && isResumeRequest(transcript)) {
    const prefix = deps.recover.pending();
    if (prefix) {
      brainInput =
        `(You were interrupted mid-reply. The last thing you said aloud was: "${prefix}" ` +
        `Continue from where you left off — open with a brief re-anchor like "As I was saying," ` +
        `and don't repeat what you already said.)`;
    }
  }
  if (toneTag) brainInput = `${brainInput}\n\n${toneTag}`;

  // Adopted speculation already captured the snapshot attached to its original
  // brain invocation. Normal turns capture only now, after every local path.
  const systemContext = pretokens === undefined
    ? await captureOperationalContext(deps.operationalContext, deps.signal)
    : null;
  if (deps.signal?.aborted || sink.aborted()) return;

  let fillerTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelFiller = () => {
    if (fillerTimer !== undefined) { clearTimeout(fillerTimer); fillerTimer = undefined; }
  };
  const turnAbort = pretokens ? null : new AbortController();
  const abortFromTransport = (): void => {
    if (turnAbort && !turnAbort.signal.aborted) turnAbort.abort(deps.signal?.reason);
  };
  if (deps.signal) {
    if (deps.signal.aborted) abortFromTransport();
    else deps.signal.addEventListener("abort", abortFromTransport, { once: true });
  }
  let detached = false;
  try {
    // Latency-gated filler: arm a pre-rendered "let me think…" clip (0 ms synth —
    // it's cached), but only speak it if the brain's first sentence hasn't shown
    // up within the gate. A fast reply gets natural silence instead of a filler
    // on every turn, which reads as a scripted tic in real conversation.
    const fillerCandidate = deps.filler?.(transcript);
    let filler: PreparedFiller | undefined;
    if (fillerCandidate?.audio.byteLength) {
      try {
        admitProviderAudio(fillerCandidate.audio);
        filler = fillerCandidate;
      } catch {
        // Optional cached filler is corrupt/oversized; the real reply continues.
      }
    }
    if (filler && !sink.aborted()) {
      fillerTimer = setTimeout(() => {
        fillerTimer = undefined;
        if (sink.aborted()) return;
        sink.sentence(filler.text);
        sink.audio(filler.audio);
        timer.mark("filler_audio");
      }, deps.fillerDelayMs ?? 1200);
    }

    // Mark the brain's first token (time-to-first-token) as it flows past. For a
    // non-streaming brain the whole reply is already resolved here, so this marks
    // total brain time instead — still the honest number for that path.
    let firstToken = false;
    const timed = async function* (src: AsyncIterable<string>): AsyncGenerator<string> {
      for await (const t of src) {
        if (!firstToken) { firstToken = true; timer.mark("brain_first_token"); }
        yield t;
      }
    };
    const turnOptions = turnAbort
      ? { signal: turnAbort.signal, systemContext: systemContext ?? undefined }
      : undefined;
    const tokens: AsyncIterable<string> = pretokens
      ? timed(pretokens)
      : deps.brain.sendStream
        ? timed(deps.brain.sendStream(brainInput, turnOptions))
        : timed(oneChunkPromise(deps.brain.send(brainInput, turnOptions)));

    let firstSentence = false;
    let firstAudio = false;
    let spoken = 0;
    const spokenTexts: string[] = []; // what the user actually HEARD, for barge-in recovery
    let control: boolean | undefined; // control-plane turns (roll call, standup) are never TLDR-gated
    const gated: string[] = [];
    // Long-turn parking state: once parked, the loop keeps consuming DETACHED —
    // it ignores sink aborts (the floor belongs to new turns now) and collects
    // text for the notify path instead of speaking.
    let parked = false;
    let parkDeadline = 0;
    const parkedTexts: string[] = [];
    const stopConsuming = () => deps.signal?.aborted === true || (parked ? Date.now() > parkDeadline : sink.aborted());
    const consumption = (async () => {
      for await (const raw of segmentSentences(abortable(
        tokens,
        stopConsuming,
        () => turnAbort?.abort(),
        pretokens !== undefined,
        deps.trackBackground,
      ))) {
        cancelFiller(); // the real reply arrived — an unfired filler stays silent
        const sentence = raw.trim();
        if (!sentence) continue;
        if (parked) { parkedTexts.push(sentence); continue; }
        if (sink.aborted()) break;
        if (!firstSentence) { firstSentence = true; timer.mark("first_sentence"); }
        control ??= deps.brain.wasControlTurn?.() ?? false;
        sink.sentence(sentence);
        if (deps.tldr && !control && spoken >= deps.tldr.cap) {
          gated.push(sentence); // pane gets the text; the voice stays quiet
          continue;
        }
        const audio = admitProviderAudio(
          await deps.tts.generateAudio(sentence, undefined, { speed: deps.voice?.state.rate }),
        );
        if (sink.aborted() && !parked) break;
        if (audio.byteLength > 0) {
          if (!firstAudio) { firstAudio = true; timer.mark("first_audio"); }
          // Control turns hand the floor between speakers each sentence — give
          // the next voice a human beat instead of cutting in mid-breath.
          if (control && spoken > 0) {
            const beat = silenceWavLike(SPEAKER_BEAT_MS, audio);
            if (beat.byteLength > 0) sink.audio(beat);
          }
          sink.audio(audio);
          spoken++;
          spokenTexts.push(sentence);
        }
      }
    })();

    if (deps.park) {
      const parkCfg = deps.park;
      const outcome = await new Promise<"park" | "done">((resolve) => {
        const watchdog = setTimeout(() => resolve("park"), parkCfg.afterMs);
        void consumption
          .catch(() => { /* handled by the awaits below */ })
          .finally(() => { clearTimeout(watchdog); resolve("done"); });
      });
      if (outcome === "park" && !firstSentence && !sink.aborted()) {
        // Nothing has been said and the brain is deep in something — hand the
        // floor back. The reply finishes in the background and arrives through
        // onParked (spoken via notify, in the lane's voice).
        parked = true;
        parkDeadline = Date.now() + (parkCfg.maxBackgroundMs ?? 600_000);
        cancelFiller();
        const line = parkCfg.line ?? DEFAULT_PARK_LINE;
        sink.sentence(line);
        const audio = admitProviderAudio(
          await deps.tts.generateAudio(line, undefined, { speed: deps.voice?.state.rate }),
        );
        if (audio.byteLength > 0) sink.audio(audio);
        sink.done();
        timer.mark("parked");
        detached = true;
        const background = consumption
          .catch(() => { /* brain died mid-background — deliver what we have */ })
          .then(() => deps.signal?.aborted
            ? undefined
            : parkCfg.onParked(parkedTexts.join(" "), transcript))
          .finally(() => { deps.signal?.removeEventListener("abort", abortFromTransport); });
        if (deps.trackBackground) {
          if (!deps.trackBackground(background)) {
            // The hand-back already closed the client turn, but retaining this
            // invocation as foreground work preserves the host's hard cap.
            await background;
          }
        } else {
          void background.catch((error: unknown) => {
            log("warn", `parked web turn delivery failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        return;
      }
    }
    await consumption;
    // Barge-in after speech started: remember the spoken tail so "continue"
    // can resume. A turn cut off before any audio has nothing to resume.
    if (sink.aborted() && spokenTexts.length > 0) {
      deps.recover?.store(spokenTexts.slice(-3).join(" "));
    }
    if (gated.length > 0 && !sink.aborted()) {
      const remainder = gated.join(" ");
      deps.tldr?.store?.(remainder);
      let coda = `Plus ${gated.length} more sentences in the log — say "details" if you want them read out.`;
      if (deps.tldr?.summarize) {
        try {
          coda = `In short: ${(await deps.tldr.summarize(remainder)).trim()} Say "details" for the full version.`;
        } catch { /* summarizer down — the generic coda still tells the user there's more */ }
      }
      sink.sentence(coda);
      const audio = admitProviderAudio(
        await deps.tts.generateAudio(coda, undefined, { speed: deps.voice?.state.rate }),
      );
      if (!sink.aborted() && audio.byteLength > 0) {
        sink.audio(audio);
        spokenTexts.push(coda);
      }
    }
    if (!sink.aborted() && spokenTexts.length > 0) {
      deps.lastReply?.store(spokenTexts.join(" "));
    }
    sink.done();
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("streaming web reply failed", { cause: error });
  } finally {
    cancelFiller(); // turn over (or failed) — never speak a filler after the fact
    if (!detached) deps.signal?.removeEventListener("abort", abortFromTransport);
  }
}

export async function captureOperationalContext(
  provider: ((signal?: AbortSignal) => Promise<string | null>) | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  if (!provider) return null;
  const captureAbort = new AbortController();
  let timedOut = false;
  const abortFromTurn = (): void => {
    if (!captureAbort.signal.aborted) captureAbort.abort(signal?.reason);
  };
  if (signal) signal.addEventListener("abort", abortFromTurn, { once: true });
  if (signal?.aborted) abortFromTurn();
  const timer = setTimeout(() => {
    timedOut = true;
    captureAbort.abort(new Error(`operational snapshot timed out after ${OPERATIONAL_CONTEXT_CAPTURE_TIMEOUT_MS}ms`));
  }, OPERATIONAL_CONTEXT_CAPTURE_TIMEOUT_MS);
  let resolveCancelled: ((value: { kind: "cancelled" }) => void) | undefined;
  const captureCancelled = (): void => resolveCancelled?.({ kind: "cancelled" });
  try {
    const captured = Promise.resolve().then(() => provider(captureAbort.signal)).then(
      (context) => ({ kind: "captured" as const, context }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    const cancelled = new Promise<{ kind: "cancelled" }>((resolve) => {
      resolveCancelled = resolve;
      if (captureAbort.signal.aborted) resolve({ kind: "cancelled" });
      else captureAbort.signal.addEventListener("abort", captureCancelled, { once: true });
    });
    const result = await Promise.race([captured, cancelled]);
    if (result.kind === "cancelled") {
      if (timedOut) log("warn", `operational snapshot unavailable for this turn: capture exceeded ${OPERATIONAL_CONTEXT_CAPTURE_TIMEOUT_MS}ms`);
      return null;
    }
    if (result.kind === "captured") return result.context;
    if (signal?.aborted) return null;
    log("warn", `operational snapshot unavailable for this turn: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
    return null;
  } catch (error: unknown) {
    if (signal?.aborted) return null;
    log("warn", `operational snapshot unavailable for this turn: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromTurn);
    captureAbort.signal.removeEventListener("abort", captureCancelled);
  }
}
