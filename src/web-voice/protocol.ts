import { inspectWavMetadata } from "../platform/wav";

/** Wire limits shared by the web-voice HTTP and WebSocket transports. */
export const MAX_TURN_AUDIO_BYTES = 4 * 1024 * 1024;
export const MAX_WS_TEXT_BYTES = 64 * 1024;
export const MAX_TURN_AUDIO_MS = 120_000;
export const MAX_WEB_VOICE_CLIENTS = 32;
export const MAX_CONCURRENT_WEB_JOBS = 8;
export const MAX_NOTIFY_JSON_BYTES = 16 * 1024;
export const MAX_CHAT_JSON_BYTES = 64 * 1024;
export const MAX_HEALTH_JSON_BYTES = 256 * 1024;
export const MAX_NOTIFY_TEXT_CHARS = 4_096;
export const MAX_CHAT_TEXT_CHARS = 16_384;
/** Tool summaries are untrusted brain/provider text displayed in approval cards. */
export const MAX_CONFIRM_SUMMARY_CHARS = 2_000;
export const MAX_HEALTH_ROWS = 100;

/**
 * Protocol-v2 binary frames carry both identities with the audio payload:
 *
 *   "CVP2" | session length (u16 LE) | turn length (u16 LE) | ids | payload
 *
 * The payload is a complete WAV utterance/reply, a PRB2 turn-detection probe,
 * or an opt-in CVS2 PCM chunk. Keeping the identity in the same WebSocket message as
 * the bytes prevents a late binary frame from being attributed to a newer turn.
 */
const MAGIC = new Uint8Array([0x43, 0x56, 0x50, 0x32]); // "CVP2"
const REPLY_MAGIC = new Uint8Array([0x43, 0x56, 0x41, 0x32]); // "CVA2"
const FIXED_HEADER_BYTES = 8;
export const MAX_PROTOCOL_ID_BYTES = 128;
export const MAX_WS_PAYLOAD_BYTES = MAX_TURN_AUDIO_BYTES + FIXED_HEADER_BYTES + MAX_PROTOCOL_ID_BYTES * 2;
/** CVP2 payload for opt-in continuous 16 kHz mono s16le capture. */
export const MAX_STREAM_PCM_CHUNK_BYTES = 64 * 1024;
const STREAM_MAGIC = new Uint8Array([0x43, 0x56, 0x53, 0x32]); // CVS2
export function encodeStreamPcmFrame(sequence: number, sampleRate: number, pcm: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 0xffffffff ||
      !Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
      pcm.byteLength < 2 || pcm.byteLength > MAX_STREAM_PCM_CHUNK_BYTES || pcm.byteLength % 2)
    throw new RangeError("invalid streaming PCM frame");
  const frame = new Uint8Array(12 + pcm.byteLength);
  frame.set(STREAM_MAGIC);
  new DataView(frame.buffer).setUint32(4, sequence, true);
  new DataView(frame.buffer).setUint32(8, sampleRate, true);
  frame.set(pcm, 12);
  return frame;
}
export function isStreamPcmFrame(frame: Uint8Array): boolean {
  return frame.byteLength >= 4 && STREAM_MAGIC.every((byte, i) => frame[i] === byte);
}
export function decodeStreamPcmFrame(frame: Uint8Array): { sequence: number; sampleRate: number; pcm: Uint8Array } | null {
  if (!isStreamPcmFrame(frame) || frame.byteLength < 14 || frame.byteLength > 12 + MAX_STREAM_PCM_CHUNK_BYTES || frame.byteLength % 2) return null;
  const sequence = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4, true);
  const sampleRate = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(8, true);
  if (!sequence || sampleRate < 8000 || sampleRate > 192000) return null;
  return { sequence, sampleRate, pcm: frame.subarray(12) };
}
export function admitStreamPcmChunk(
  frame: { sequence: number; sampleRate: number; pcm: Uint8Array },
  expectedSequence: number,
  sampleRate: number,
  receivedBytes: number,
): boolean {
  return expectedSequence <= 0xffffffff && frame.sequence === expectedSequence &&
    frame.sampleRate === sampleRate && receivedBytes + frame.pcm.byteLength <= MAX_TURN_AUDIO_BYTES;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isProtocolId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}

export interface TurnAudioFrame {
  sessionId: string;
  turnId: string;
  payload: ArrayBuffer;
  /** Present on sequenced outbound audio; absent on the original CVP2 envelope. */
  sequence?: number;
}

export interface TurnAudioMetadata {
  durationMs: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/**
 * Admit only bounded, uncompressed PCM/float WAV utterances. Encoded-body byte
 * limits alone do not stop a tiny compressed file from expanding into hours of
 * decoded audio inside an STT or tone sidecar.
 */
export function inspectTurnAudio(input: ArrayBuffer | Uint8Array): TurnAudioMetadata | null {
  const bytes = input instanceof Uint8Array
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);
  if (bytes.byteLength > MAX_TURN_AUDIO_BYTES) return null;
  try {
    const metadata = inspectWavMetadata(bytes, {
      requireExactRiffLength: true,
      requireFmtBeforeData: true,
      requireFiniteFloatSamples: true,
      maxDurationMs: MAX_TURN_AUDIO_MS,
      allowEmpty: false,
    });
    return {
      durationMs: metadata.durationMs,
      sampleRate: metadata.sampleRate,
      channels: metadata.channels,
      bitsPerSample: metadata.bitsPerSample,
    };
  } catch {
    return null;
  }
}

export function encodeTurnAudioFrame(sessionId: string, turnId: string, payload: ArrayBuffer): ArrayBuffer {
  if (!isProtocolId(sessionId) || !isProtocolId(turnId)) {
    throw new Error("invalid web-voice session or turn id");
  }
  const encoder = new TextEncoder();
  const session = encoder.encode(sessionId);
  const turn = encoder.encode(turnId);
  if (session.byteLength > MAX_PROTOCOL_ID_BYTES || turn.byteLength > MAX_PROTOCOL_ID_BYTES) {
    throw new Error("web-voice session or turn id is too long");
  }

  const out = new Uint8Array(FIXED_HEADER_BYTES + session.byteLength + turn.byteLength + payload.byteLength);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint16(4, session.byteLength, true);
  view.setUint16(6, turn.byteLength, true);
  out.set(session, FIXED_HEADER_BYTES);
  out.set(turn, FIXED_HEADER_BYTES + session.byteLength);
  out.set(new Uint8Array(payload), FIXED_HEADER_BYTES + session.byteLength + turn.byteLength);
  return out.buffer;
}

export function decodeTurnAudioFrame(input: Uint8Array): TurnAudioFrame | null {
  if (input.byteLength < FIXED_HEADER_BYTES) return null;
  const sequenced = REPLY_MAGIC.every((byte, i) => input[i] === byte);
  if (!sequenced && !MAGIC.every((byte, i) => input[i] === byte)) return null;
  const headerBytes = sequenced ? FIXED_HEADER_BYTES + 4 : FIXED_HEADER_BYTES;
  if (input.byteLength < headerBytes) return null;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const sequence = sequenced ? view.getUint32(8, true) : undefined;
  if (sequenced && !sequence) return null;
  const sessionLength = view.getUint16(4, true);
  const turnLength = view.getUint16(6, true);
  if (
    sessionLength === 0 || turnLength === 0 ||
    sessionLength > MAX_PROTOCOL_ID_BYTES || turnLength > MAX_PROTOCOL_ID_BYTES
  ) return null;
  const payloadOffset = headerBytes + sessionLength + turnLength;
  if (payloadOffset > input.byteLength) return null;

  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    const sessionId = decoder.decode(input.subarray(headerBytes, headerBytes + sessionLength));
    const turnId = decoder.decode(input.subarray(headerBytes + sessionLength, payloadOffset));
    if (!isProtocolId(sessionId) || !isProtocolId(turnId)) return null;
    // Copy out of Bun's reusable WebSocket message buffer before async work.
    const payload = new Uint8Array(input.byteLength - payloadOffset);
    payload.set(input.subarray(payloadOffset));
    return sequenced ? { sessionId, turnId, payload: payload.buffer, sequence } : { sessionId, turnId, payload: payload.buffer };
  } catch {
    return null;
  }
}

/** Outbound v2 audio uses a distinct magic and a u32 sequence before the ids. */
export function encodeReplyAudioFrame(sessionId: string, turnId: string, sequence: number, payload: ArrayBuffer): ArrayBuffer {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 0xffffffff) throw new Error("invalid audio sequence");
  const base = new Uint8Array(encodeTurnAudioFrame(sessionId, turnId, payload));
  const out = new Uint8Array(base.length + 4);
  out.set([0x43, 0x56, 0x41, 0x32]); // CVA2
  out.set(base.subarray(4, 8), 4);
  new DataView(out.buffer).setUint32(8, sequence, true);
  out.set(base.subarray(8), 12);
  return out.buffer;
}

export function decodeReplyAudioFrame(input: Uint8Array): (TurnAudioFrame & { sequence: number }) | null {
  const frame = decodeTurnAudioFrame(input);
  return frame?.sequence ? frame as TurnAudioFrame & { sequence: number } : null;
}

export type AudioAck = { type: "audio_ack"; sessionId: string; turnId: string; sequence: number; status: "played" | "interrupted"; atMs?: number };
export function decodeAudioAck(value: unknown): AudioAck | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.type !== "audio_ack" || !isProtocolId(v.sessionId) || !isProtocolId(v.turnId)
    || !Number.isSafeInteger(v.sequence) || (v.sequence as number) < 1 || (v.sequence as number) > 0xffffffff
    || (v.status !== "played" && v.status !== "interrupted")) return null;
  if (v.status === "interrupted" && (typeof v.atMs !== "number" || !Number.isFinite(v.atMs) || v.atMs < 0 || v.atMs > MAX_TURN_AUDIO_MS)) return null;
  if (v.status === "played" && v.atMs !== undefined) return null;
  return v as AudioAck;
}

/** Browser monotonic elapsed time, already relative to its own speech end. */
export type ClientMetric = { type: "client_metric"; sessionId: string; turnId: string;
  event: "speech_end" | "audio_started" | "barge_in";
  sinceSpeechEndMs: number; sequence?: number };
export const MAX_CLIENT_METRIC_MS = 300_000;
export function decodeClientMetric(value: unknown, protocol: 1 | 2 = 2): ClientMetric | null {
  if (protocol !== 2) return null;
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.type !== "client_metric" || !isProtocolId(v.sessionId) || !isProtocolId(v.turnId)
    || !["speech_end", "audio_started", "barge_in"].includes(String(v.event))
    || typeof v.sinceSpeechEndMs !== "number" || !Number.isFinite(v.sinceSpeechEndMs)
    || v.sinceSpeechEndMs < 0 || v.sinceSpeechEndMs > MAX_CLIENT_METRIC_MS) return null;
  if (v.event === "speech_end" && v.sinceSpeechEndMs !== 0) return null;
  if (v.event === "audio_started"
    ? !Number.isSafeInteger(v.sequence) || (v.sequence as number) < 1 || (v.sequence as number) > 0xffffffff
    : v.sequence !== undefined) return null;
  return { type: "client_metric", sessionId: v.sessionId, turnId: v.turnId,
    event: v.event as ClientMetric["event"], sinceSpeechEndMs: Math.round(v.sinceSpeechEndMs),
    ...(v.event === "audio_started" ? { sequence: v.sequence as number } : {}) };
}
