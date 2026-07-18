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
 * The payload is either a complete WAV utterance/reply or an existing PRB2
 * turn-detection probe. Keeping the identity in the same WebSocket message as
 * the bytes prevents a late binary frame from being attributed to a newer turn.
 */
const MAGIC = new Uint8Array([0x43, 0x56, 0x50, 0x32]); // "CVP2"
const FIXED_HEADER_BYTES = 8;
export const MAX_PROTOCOL_ID_BYTES = 128;
export const MAX_WS_PAYLOAD_BYTES = MAX_TURN_AUDIO_BYTES + FIXED_HEADER_BYTES + MAX_PROTOCOL_ID_BYTES * 2;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isProtocolId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}

export interface TurnAudioFrame {
  sessionId: string;
  turnId: string;
  payload: ArrayBuffer;
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
  for (let i = 0; i < MAGIC.byteLength; i++) {
    if (input[i] !== MAGIC[i]) return null;
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const sessionLength = view.getUint16(4, true);
  const turnLength = view.getUint16(6, true);
  if (
    sessionLength === 0 || turnLength === 0 ||
    sessionLength > MAX_PROTOCOL_ID_BYTES || turnLength > MAX_PROTOCOL_ID_BYTES
  ) return null;
  const payloadOffset = FIXED_HEADER_BYTES + sessionLength + turnLength;
  if (payloadOffset > input.byteLength) return null;

  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    const sessionId = decoder.decode(input.subarray(FIXED_HEADER_BYTES, FIXED_HEADER_BYTES + sessionLength));
    const turnId = decoder.decode(input.subarray(FIXED_HEADER_BYTES + sessionLength, payloadOffset));
    if (!isProtocolId(sessionId) || !isProtocolId(turnId)) return null;
    // Copy out of Bun's reusable WebSocket message buffer before async work.
    const payload = new Uint8Array(input.byteLength - payloadOffset);
    payload.set(input.subarray(payloadOffset));
    return { sessionId, turnId, payload: payload.buffer };
  } catch {
    return null;
  }
}
