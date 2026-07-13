/**
 * Turn-probe wire format: the web client asks "has the speaker finished?"
 * mid-pause, without ending the utterance. A probe is a binary WS frame so it
 * shares the socket with utterance WAVs — the magic distinguishes them (WAVs
 * start with "RIFF", probes with "PRB2" / legacy "PROB"):
 *
 *   bytes 0-3   "PRB2"
 *   bytes 4-7   uint32 LE sample rate
 *   bytes 8-11  uint32 LE total utterance duration so far, ms (speech + the
 *               pause being probed) — lets the server know whether the PCM
 *               tail below covers the WHOLE utterance, which is the safety
 *               gate for speculative generation (see speculative.ts)
 *   bytes 12-   int16 LE mono PCM (the utterance tail, ≤ the model's 8s window)
 *
 * Legacy "PROB" frames (bytes 8- are PCM, no duration) still decode — a PWA
 * client with cached page JS keeps working, it just never triggers speculation.
 *
 * The server answers over the same socket with {type:"verdict", complete,
 * probability} and the client either ends the turn early (complete) or
 * stretches its silence hangover (incomplete — a mid-thought pause), scaled
 * by how sure the model was.
 */

export const PROBE_MAGIC = "PROB";
export const PROBE_MAGIC_V2 = "PRB2";

export interface ProbeFrame {
  sampleRate: number;
  /** Mono PCM in [-1, 1]. */
  samples: Float32Array;
  /** Total utterance duration at probe time (ms); undefined on legacy frames. */
  utterMs?: number;
}

/** True when a binary WS frame is a turn probe rather than an utterance WAV. */
export function isProbeFrame(data: Uint8Array): boolean {
  if (data.byteLength < 8) return false;
  const v2 =
    data[0] === 0x50 && data[1] === 0x52 && data[2] === 0x42 && data[3] === 0x32; // "PRB2"
  const v1 =
    data[0] === 0x50 && data[1] === 0x52 && data[2] === 0x4f && data[3] === 0x42; // "PROB"
  return v1 || v2;
}

/** Decode a probe frame (either version); null when malformed or empty. */
export function decodeProbeFrame(data: Uint8Array): ProbeFrame | null {
  if (!isProbeFrame(data)) return null;
  const v2 = data[2] === 0x42 && data[3] === 0x32;
  const pcmOff = v2 ? 12 : 8;
  if (data.byteLength < pcmOff + 2) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sampleRate = view.getUint32(4, true);
  if (sampleRate < 8000 || sampleRate > 96000) return null;
  const utterMs = v2 ? view.getUint32(8, true) : undefined;
  const n = Math.floor((data.byteLength - pcmOff) / 2);
  if (n === 0) return null;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = view.getInt16(pcmOff + i * 2, true) / 32768;
  return { sampleRate, samples, utterMs };
}

/** Encode a v2 probe frame (mirrors the client-side encoder in page.ts — kept
 * here so the round-trip is testable server-side). */
export function encodeProbeFrame(samples: Float32Array, sampleRate: number, utterMs?: number): ArrayBuffer {
  const v2 = utterMs !== undefined;
  const pcmOff = v2 ? 12 : 8;
  const buf = new ArrayBuffer(pcmOff + samples.length * 2);
  const view = new DataView(buf);
  if (v2) {
    view.setUint8(0, 0x50); view.setUint8(1, 0x52); view.setUint8(2, 0x42); view.setUint8(3, 0x32); // "PRB2"
  } else {
    view.setUint8(0, 0x50); view.setUint8(1, 0x52); view.setUint8(2, 0x4f); view.setUint8(3, 0x42); // "PROB"
  }
  view.setUint32(4, sampleRate, true);
  if (v2) view.setUint32(8, Math.round(utterMs), true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(pcmOff + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
