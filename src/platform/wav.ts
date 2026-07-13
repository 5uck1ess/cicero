/**
 * Minimal RIFF/WAVE decoder — just enough to turn a recorded utterance into the
 * mono Float32 PCM that the Smart-Turn model expects. The recorder writes 16-bit
 * signed PCM at 16kHz; we also tolerate 32-bit float and downmix stereo so the
 * decoder doesn't silently mangle a slightly different capture format.
 */

export interface DecodedWav {
  /** Mono PCM normalized to [-1, 1]. */
  samples: Float32Array;
  sampleRate: number;
}

export interface WavMetadata {
  audioFormat: 1 | 3;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  fmtOffset: number;
  dataOffset: number;
  dataLength: number;
  frameCount: number;
  durationMs: number;
  declaredRiffLength: number;
}

export interface WavInspectionOptions {
  /** Require the RIFF size field to cover the complete input exactly. */
  requireExactRiffLength?: boolean;
  /** Require the format chunk to precede audio data, as mandated for wire WAVs. */
  requireFmtBeforeData?: boolean;
  /** Scan IEEE-float payloads in place and reject NaN/Infinity samples. */
  requireFiniteFloatSamples?: boolean;
  /** Reject audio longer than this duration. Omit for metadata-only inspection. */
  maxDurationMs?: number;
  /** Empty data chunks are useful for a few internal fixtures, but not wire audio. */
  allowEmpty?: boolean;
}

export interface SynthesizedWavAdmissionOptions {
  /** A stricter transport-specific encoded-byte cap. */
  maxBytes?: number;
  /** Treat a zero-byte provider result as "no clip" instead of malformed WAV. */
  allowEmpty?: boolean;
}

export interface SynthesizedWavSnapshot {
  /** Fixed-length buffer owned exclusively by the caller of the snapshot API. */
  audio: ArrayBuffer;
  metadata: WavMetadata | null;
}

export const MIN_WAV_SAMPLE_RATE = 8_000;
export const MAX_WAV_SAMPLE_RATE = 96_000;
export const MAX_DECODED_WAV_DURATION_MS = 5 * 60 * 1_000;
export const MAX_DECODED_WAV_BYTES = 64 * 1024 * 1024;
export const MAX_SYNTHESIZED_WAV_BYTES = MAX_DECODED_WAV_BYTES;

const RIFF = 0x46464952; // "RIFF" little-endian
const WAVE = 0x45564157; // "WAVE"
const FMT = 0x20746d66; // "fmt "
const DATA = 0x61746164; // "data"

/**
 * Encode mono 16-bit PCM samples as a canonical RIFF/WAVE buffer. Used by the
 * VAD recorder to turn a streamed, gate-trimmed utterance into the WAV file STT
 * expects. Samples are written little-endian via DataView so the output is
 * byte-for-byte correct regardless of host endianness.
 */
export function encodeWav(samples: Int16Array, sampleRate = 16000): Uint8Array {
  const dataSize = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i] ?? 0, true);
  return new Uint8Array(buf);
}

/**
 * Encode a short buffer of silence as a 16-bit mono PCM WAV. Used to warm an STT
 * model at boot (one throwaway inference loads the weights) so the first real
 * utterance isn't hit with the multi-second cold-start.
 */
export function encodeSilentWav(ms = 200, sampleRate = 16000): Uint8Array {
  const numSamples = Math.floor((sampleRate * ms) / 1000);
  return encodeWav(new Int16Array(numSamples), sampleRate);
}

/** Decode a WAV file at `path` to mono Float32 samples. Throws on malformed input. */
export async function decodeWavFile(path: string): Promise<DecodedWav> {
  try {
    const file = Bun.file(path);
    if (file.size > MAX_DECODED_WAV_BYTES) {
      throw new Error(`WAVE input exceeds the ${MAX_DECODED_WAV_BYTES}-byte decode limit`);
    }
    const buf = await file.arrayBuffer();
    return decodeWav(buf);
  } catch (error: unknown) {
    if (error instanceof Error) throw error;
    throw new Error(`could not decode WAVE file '${path}': ${String(error)}`);
  }
}

/**
 * Parse and validate uncompressed PCM/IEEE-float WAV metadata without allocating
 * decoded samples. This is the shared admission boundary for recorded and
 * synthesized audio before duration-derived allocations.
 */
export function inspectWavMetadata(
  input: ArrayBuffer | Uint8Array,
  options: WavInspectionOptions = {},
): WavMetadata {
  const bytes = input instanceof Uint8Array
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || view.getUint32(0, true) !== RIFF || view.getUint32(8, true) !== WAVE) {
    throw new Error("not a RIFF/WAVE file");
  }

  const declaredRiffLength = view.getUint32(4, true) + 8;
  if (declaredRiffLength < 12) {
    throw new Error(`WAVE RIFF length ${declaredRiffLength} is shorter than its 12-byte header`);
  }
  if (declaredRiffLength > bytes.byteLength) {
    throw new Error(`WAVE RIFF length ${declaredRiffLength} extends beyond ${bytes.byteLength} input bytes`);
  }
  if (options.requireExactRiffLength && declaredRiffLength !== bytes.byteLength) {
    throw new Error(`WAVE RIFF length ${declaredRiffLength} does not match ${bytes.byteLength} input bytes`);
  }
  if (options.maxDurationMs !== undefined
    && (!Number.isFinite(options.maxDurationMs) || options.maxDurationMs <= 0)) {
    throw new RangeError("maxDurationMs must be a positive finite number");
  }

  let offset = 12;
  let format: {
    audioFormat: number;
    channels: number;
    sampleRate: number;
    byteRate: number;
    blockAlign: number;
    bitsPerSample: number;
  } | null = null;
  let fmtOffset = -1;
  let dataOffset = -1;
  let dataLength = -1;

  while (offset < declaredRiffLength) {
    if (offset + 8 > declaredRiffLength) {
      throw new Error("WAVE RIFF ends inside a chunk header");
    }
    const id = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (size > declaredRiffLength - body) {
      throw new Error("WAVE chunk extends beyond the declared RIFF boundary");
    }
    const end = body + size;
    const paddedEnd = end + (size & 1);
    if (paddedEnd > declaredRiffLength) {
      throw new Error("WAVE chunk padding extends beyond the declared RIFF boundary");
    }

    if (id === FMT) {
      if (format !== null) throw new Error("WAVE file has duplicate fmt chunks");
      if (size < 16) throw new Error("WAVE fmt chunk is shorter than 16 bytes");
      fmtOffset = body;
      format = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        byteRate: view.getUint32(body + 8, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === DATA) {
      if (dataOffset >= 0) throw new Error("WAVE file has duplicate data chunks");
      if (options.requireFmtBeforeData && format === null) {
        throw new Error("WAVE fmt chunk must precede its data chunk");
      }
      dataOffset = body;
      dataLength = size;
    }

    offset = paddedEnd;
  }

  if (!format) throw new Error("WAVE file has no fmt chunk");
  if (dataOffset < 0 || dataLength < 0) throw new Error("WAVE file has no data chunk");
  if (format.audioFormat !== 1 && format.audioFormat !== 3) {
    throw new Error(`unsupported WAVE format code: ${format.audioFormat}`);
  }
  if (format.channels < 1 || format.channels > 2) {
    throw new Error(`unsupported channel count: ${format.channels}`);
  }
  if (format.sampleRate < MIN_WAV_SAMPLE_RATE || format.sampleRate > MAX_WAV_SAMPLE_RATE) {
    throw new Error(`unsupported sample rate: ${format.sampleRate}`);
  }
  if (format.audioFormat === 3) {
    if (format.bitsPerSample !== 32) {
      throw new Error(`unsupported IEEE-float bit depth: ${format.bitsPerSample}`);
    }
  } else if (![8, 16, 24, 32].includes(format.bitsPerSample)) {
    throw new Error(`unsupported PCM bit depth: ${format.bitsPerSample}`);
  }

  const bytesPerSample = format.bitsPerSample / 8;
  const expectedBlockAlign = format.channels * bytesPerSample;
  const expectedByteRate = format.sampleRate * expectedBlockAlign;
  if (format.blockAlign !== expectedBlockAlign) {
    throw new Error(`invalid WAVE block alignment: ${format.blockAlign}`);
  }
  if (format.byteRate !== expectedByteRate) {
    throw new Error(`invalid WAVE byte rate: ${format.byteRate}`);
  }
  if (dataLength % format.blockAlign !== 0) {
    throw new Error("WAVE data length is not frame-aligned");
  }
  if (dataLength === 0 && options.allowEmpty === false) {
    throw new Error("WAVE data chunk is empty");
  }

  const frameCount = dataLength / format.blockAlign;
  const durationMs = (frameCount / format.sampleRate) * 1_000;
  if (!Number.isFinite(durationMs)) throw new Error("WAVE duration is not finite");
  if (options.maxDurationMs !== undefined && durationMs > options.maxDurationMs) {
    throw new Error(`WAVE duration ${durationMs}ms exceeds the ${options.maxDurationMs}ms limit`);
  }
  if (format.audioFormat === 3 && options.requireFiniteFloatSamples) {
    const dataEnd = dataOffset + dataLength;
    for (let pos = dataOffset; pos < dataEnd; pos += bytesPerSample) {
      if (!Number.isFinite(view.getFloat32(pos, true))) {
        throw new Error("WAVE sample is not finite");
      }
    }
  }

  return {
    audioFormat: format.audioFormat,
    channels: format.channels,
    sampleRate: format.sampleRate,
    byteRate: format.byteRate,
    blockAlign: format.blockAlign,
    bitsPerSample: format.bitsPerSample,
    fmtOffset,
    dataOffset,
    dataLength,
    frameCount,
    durationMs,
    declaredRiffLength,
  };
}

/**
 * Shared admission boundary for TTS/provider output before it is retained,
 * forwarded, written, decoded, or played.
 *
 * ArrayBuffers are mutable, so every boundary performs a fresh inspection.
 * Caching by object identity would let a caller admit a valid clip, mutate its
 * RIFF header or samples, and then reuse the stale admission result.
 */
export function admitSynthesizedWav(
  input: ArrayBuffer,
  options: SynthesizedWavAdmissionOptions = {},
): WavMetadata | null {
  const requestedMaxBytes = options.maxBytes ?? MAX_SYNTHESIZED_WAV_BYTES;
  if (!Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes <= 0) {
    throw new RangeError("synthesized WAV byte limit must be a positive integer");
  }
  const maxBytes = Math.min(requestedMaxBytes, MAX_SYNTHESIZED_WAV_BYTES);
  if (input.byteLength === 0) {
    if (options.allowEmpty) return null;
    throw new Error("synthesized WAV is empty");
  }
  if (input.byteLength > maxBytes) {
    throw new Error(`synthesized WAV exceeds the ${maxBytes}-byte limit`);
  }

  return inspectWavMetadata(input, {
    requireExactRiffLength: true,
    requireFmtBeforeData: true,
    requireFiniteFloatSamples: true,
    maxDurationMs: MAX_DECODED_WAV_DURATION_MS,
    allowEmpty: false,
  });
}

/**
 * Copy a provider-owned (and potentially resizable) buffer into fixed storage,
 * then validate the copy. Consumers that retain or expose synthesized audio
 * must use this boundary instead of trusting provider ownership after await.
 */
export function snapshotSynthesizedWav(
  input: ArrayBuffer,
  options: SynthesizedWavAdmissionOptions = {},
): SynthesizedWavSnapshot {
  const source = new Uint8Array(input);
  const requestedMaxBytes = options.maxBytes ?? MAX_SYNTHESIZED_WAV_BYTES;
  if (!Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes <= 0) {
    throw new RangeError("synthesized WAV byte limit must be a positive integer");
  }
  const maxBytes = Math.min(requestedMaxBytes, MAX_SYNTHESIZED_WAV_BYTES);
  if (source.byteLength > maxBytes) {
    throw new Error(`synthesized WAV exceeds the ${maxBytes}-byte limit`);
  }

  const audio = new ArrayBuffer(source.byteLength);
  new Uint8Array(audio).set(source);
  return {
    audio,
    metadata: admitSynthesizedWav(audio, { ...options, maxBytes }),
  };
}

/** Decode an in-memory WAV buffer to mono Float32 samples. Throws on malformed input. */
export function decodeWav(buffer: ArrayBuffer): DecodedWav {
  if (buffer.byteLength > MAX_DECODED_WAV_BYTES) {
    throw new Error(`WAVE input exceeds the ${MAX_DECODED_WAV_BYTES}-byte decode limit`);
  }
  const metadata = inspectWavMetadata(buffer, {
    maxDurationMs: MAX_DECODED_WAV_DURATION_MS,
  });
  const view = new DataView(buffer);
  const out = new Float32Array(metadata.frameCount);
  const isFloat = metadata.audioFormat === 3;
  const bytesPerSample = metadata.bitsPerSample / 8;

  for (let frame = 0; frame < metadata.frameCount; frame++) {
    let acc = 0;
    for (let ch = 0; ch < metadata.channels; ch++) {
      const pos = metadata.dataOffset + (frame * metadata.channels + ch) * bytesPerSample;
      const sample = readSample(view, pos, metadata.bitsPerSample, isFloat);
      if (!Number.isFinite(sample)) throw new Error("WAVE sample is not finite");
      acc += sample;
    }
    out[frame] = acc / metadata.channels; // downmix to mono
  }

  return { samples: out, sampleRate: metadata.sampleRate };
}

function readSample(view: DataView, pos: number, bits: number, isFloat: boolean): number {
  if (isFloat) {
    return bits === 64 ? view.getFloat64(pos, true) : view.getFloat32(pos, true);
  }
  switch (bits) {
    case 8:
      return (view.getUint8(pos) - 128) / 128; // 8-bit PCM is unsigned
    case 16:
      return view.getInt16(pos, true) / 32768;
    case 24: {
      const b0 = view.getUint8(pos);
      const b1 = view.getUint8(pos + 1);
      const b2 = view.getUint8(pos + 2);
      let val = b0 | (b1 << 8) | (b2 << 16);
      if (val & 0x800000) val |= ~0xffffff; // sign-extend 24→32 bits
      return val / 8388608;
    }
    case 32:
      return view.getInt32(pos, true) / 2147483648;
    default:
      throw new Error(`unsupported PCM bit depth: ${bits}`);
  }
}
