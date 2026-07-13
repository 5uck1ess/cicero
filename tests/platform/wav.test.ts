import { test, expect } from "bun:test";
import {
  MAX_DECODED_WAV_DURATION_MS,
  admitSynthesizedWav,
  decodeWav,
  encodeSilentWav,
  encodeWav,
  inspectWavMetadata,
  snapshotSynthesizedWav,
} from "../../src/platform/wav";

test("encodeSilentWav round-trips to the right amount of silence", () => {
  const bytes = encodeSilentWav(100, 16000); // 100ms @ 16kHz = 1600 samples
  const decoded = decodeWav(bytes.buffer as ArrayBuffer);
  expect(decoded.sampleRate).toBe(16000);
  expect(decoded.samples.length).toBe(1600);
  expect(decoded.samples.every((s) => s === 0)).toBe(true);
});

test("encodeWav round-trips PCM samples through decodeWav", () => {
  const samples = new Int16Array([0, 32767, -32768, 16384, -16384]);
  const decoded = decodeWav(encodeWav(samples, 16000).buffer as ArrayBuffer);
  expect(decoded.sampleRate).toBe(16000);
  expect(decoded.samples.length).toBe(5);
  expect(decoded.samples[0]).toBeCloseTo(0, 5);
  expect(decoded.samples[1]).toBeCloseTo(32767 / 32768, 4);
  expect(decoded.samples[2]).toBeCloseTo(-1, 5);
  expect(decoded.samples[3]).toBeCloseTo(0.5, 5);
  expect(decoded.samples[4]).toBeCloseTo(-0.5, 5);
});

/** Build a minimal canonical WAV (RIFF/fmt/data) for a given PCM/float payload. */
function buildWav(opts: {
  format: 1 | 3; // 1 = PCM, 3 = IEEE float
  bitsPerSample: number;
  channels: number;
  sampleRate: number;
  data: Uint8Array;
  extraChunkBeforeData?: boolean;
}): ArrayBuffer {
  const { format, bitsPerSample, channels, sampleRate, data } = opts;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  const extra = opts.extraChunkBeforeData ? 8 + 4 : 0; // a junk "LIST" chunk
  const size = 12 + 24 + extra + 8 + data.byteLength + (data.byteLength & 1);
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let o = 0;
  const tag = (s: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(o + i, s.charCodeAt(i));
    o += 4;
  };
  const u32 = (n: number) => { view.setUint32(o, n, true); o += 4; };
  const u16 = (n: number) => { view.setUint16(o, n, true); o += 2; };

  tag("RIFF"); u32(size - 8); tag("WAVE");
  tag("fmt "); u32(16); u16(format); u16(channels); u32(sampleRate); u32(byteRate); u16(blockAlign); u16(bitsPerSample);
  if (opts.extraChunkBeforeData) { tag("LIST"); u32(4); u32(0xdeadbeef); }
  tag("data"); u32(data.byteLength);
  bytes.set(data, o);
  return buf;
}

function buildDataBeforeFmt(): ArrayBuffer {
  const data = pcm16([7]);
  const size = 12 + 8 + data.byteLength + 24;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const tag = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  tag(0, "RIFF"); view.setUint32(4, size - 8, true); tag(8, "WAVE");
  tag(12, "data"); view.setUint32(16, data.byteLength, true); bytes.set(data, 20);
  tag(22, "fmt "); view.setUint32(26, 16, true); view.setUint16(30, 1, true);
  view.setUint16(32, 1, true); view.setUint32(34, 16_000, true);
  view.setUint32(38, 32_000, true); view.setUint16(42, 2, true); view.setUint16(44, 16, true);
  return buf;
}

function pcm16(samples: number[]): Uint8Array {
  const b = new Uint8Array(samples.length * 2);
  const v = new DataView(b.buffer);
  samples.forEach((s, i) => v.setInt16(i * 2, s, true));
  return b;
}

function appendChunk(input: ArrayBuffer, id: string, body: Uint8Array): ArrayBuffer {
  const padding = body.byteLength & 1;
  const out = new Uint8Array(input.byteLength + 8 + body.byteLength + padding);
  out.set(new Uint8Array(input));
  const view = new DataView(out.buffer);
  const offset = input.byteLength;
  for (let index = 0; index < 4; index++) out[offset + index] = id.charCodeAt(index);
  view.setUint32(offset + 4, body.byteLength, true);
  out.set(body, offset + 8);
  view.setUint32(4, out.byteLength - 8, true);
  return out.buffer;
}

test("decodes 16-bit PCM mono and normalizes to [-1, 1]", () => {
  const data = pcm16([0, 32767, -32768, 16384]);
  const { samples, sampleRate } = decodeWav(buildWav({ format: 1, bitsPerSample: 16, channels: 1, sampleRate: 16000, data }));
  expect(sampleRate).toBe(16000);
  expect(samples.length).toBe(4);
  expect(samples[0]).toBeCloseTo(0, 5);
  expect(samples[1]).toBeCloseTo(32767 / 32768, 4);
  expect(samples[2]).toBeCloseTo(-1, 5);
  expect(samples[3]).toBeCloseTo(0.5, 5);
});

test("downmixes stereo to mono by averaging channels", () => {
  // L=1.0, R=0.0 interleaved → mono 0.5
  const data = pcm16([32767, 0, -32768, 0]);
  const { samples } = decodeWav(buildWav({ format: 1, bitsPerSample: 16, channels: 2, sampleRate: 16000, data }));
  expect(samples.length).toBe(2);
  expect(samples[0]).toBeCloseTo((32767 / 32768 + 0) / 2, 4);
  expect(samples[1]).toBeCloseTo((-1 + 0) / 2, 4);
});

test("skips unknown chunks before the data chunk", () => {
  const data = pcm16([32767]);
  const { samples } = decodeWav(buildWav({ format: 1, bitsPerSample: 16, channels: 1, sampleRate: 16000, data, extraChunkBeforeData: true }));
  expect(samples.length).toBe(1);
  expect(samples[0]).toBeCloseTo(1, 4);
});

test("decodes 8-bit unsigned PCM", () => {
  const data = new Uint8Array([128, 255, 0]); // midpoint, max, min
  const { samples } = decodeWav(buildWav({ format: 1, bitsPerSample: 8, channels: 1, sampleRate: 8000, data }));
  expect(samples[0]).toBeCloseTo(0, 5);
  expect(samples[1]).toBeCloseTo(127 / 128, 3);
  expect(samples[2]).toBeCloseTo(-1, 5);
});

test("decodes 32-bit IEEE float", () => {
  const f = new Float32Array([0, 1, -1, 0.25]);
  const { samples } = decodeWav(buildWav({ format: 3, bitsPerSample: 32, channels: 1, sampleRate: 16000, data: new Uint8Array(f.buffer) }));
  expect(samples[0]).toBeCloseTo(0, 6);
  expect(samples[1]).toBeCloseTo(1, 6);
  expect(samples[2]).toBeCloseTo(-1, 6);
  expect(samples[3]).toBeCloseTo(0.25, 6);
});

test("decodes 24-bit PCM with sign extension", () => {
  const data = new Uint8Array([0x00, 0x00, 0x40]); // 0x400000 = +0.5 of 2^23
  const { samples } = decodeWav(buildWav({ format: 1, bitsPerSample: 24, channels: 1, sampleRate: 16000, data }));
  expect(samples[0]).toBeCloseTo(0.5, 5);
});

test("rejects non-RIFF input", () => {
  expect(() => decodeWav(new ArrayBuffer(8))).toThrow(/RIFF/);
});

test("rejects a WAVE file with no data chunk", () => {
  const buf = buildWav({ format: 1, bitsPerSample: 16, channels: 1, sampleRate: 16000, data: new Uint8Array(0) });
  // Corrupt the "data" tag into "junk" so the parser finds no data chunk.
  new DataView(buf).setUint8(36, "j".charCodeAt(0));
  new DataView(buf).setUint8(37, "u".charCodeAt(0));
  new DataView(buf).setUint8(38, "n".charCodeAt(0));
  new DataView(buf).setUint8(39, "k".charCodeAt(0));
  expect(() => decodeWav(buf)).toThrow(/data chunk/);
});

test("rejects metadata that could amplify a bounded WAV into a huge allocation", () => {
  const oneBit = buildWav({
    format: 1,
    bitsPerSample: 1,
    channels: 1,
    sampleRate: 16000,
    data: new Uint8Array([0]),
  });
  expect(() => decodeWav(oneBit)).toThrow(/PCM bit depth/);

  const oneHertz = buildWav({
    format: 1,
    bitsPerSample: 16,
    channels: 1,
    sampleRate: 1,
    data: pcm16([0]),
  });
  expect(() => decodeWav(oneHertz)).toThrow(/sample rate/);

  const tooManyChannels = buildWav({
    format: 1,
    bitsPerSample: 8,
    channels: 256,
    sampleRate: 16000,
    data: new Uint8Array(256),
  });
  expect(() => decodeWav(tooManyChannels)).toThrow(/channel count/);
});

test("rejects inconsistent frame metadata and non-finite float samples", () => {
  const badAlignment = buildWav({
    format: 1,
    bitsPerSample: 16,
    channels: 1,
    sampleRate: 16000,
    data: pcm16([0]),
  });
  new DataView(badAlignment).setUint16(32, 1, true);
  expect(() => inspectWavMetadata(badAlignment)).toThrow(/block alignment/);

  const badByteRate = buildWav({
    format: 1,
    bitsPerSample: 16,
    channels: 1,
    sampleRate: 16000,
    data: pcm16([0]),
  });
  new DataView(badByteRate).setUint32(28, 1, true);
  expect(() => inspectWavMetadata(badByteRate)).toThrow(/byte rate/);

  const floats = new Float32Array([Number.NaN]);
  const nonFinite = buildWav({
    format: 3,
    bitsPerSample: 32,
    channels: 1,
    sampleRate: 16000,
    data: new Uint8Array(floats.buffer),
  });
  expect(() => decodeWav(nonFinite)).toThrow(/sample is not finite/);

  expect(() => inspectWavMetadata(nonFinite, { requireFiniteFloatSamples: true }))
    .toThrow(/sample is not finite/);
  const infinity = new Float32Array([Number.POSITIVE_INFINITY]);
  expect(() => inspectWavMetadata(buildWav({
    format: 3,
    bitsPerSample: 32,
    channels: 1,
    sampleRate: 16000,
    data: new Uint8Array(infinity.buffer),
  }), { requireFiniteFloatSamples: true })).toThrow(/sample is not finite/);
});

test("wire inspection can require fmt before data", () => {
  const dataFirst = buildDataBeforeFmt();
  expect(inspectWavMetadata(dataFirst).fmtOffset).toBeGreaterThan(
    inspectWavMetadata(dataFirst).dataOffset,
  );
  expect(() => inspectWavMetadata(dataFirst, { requireFmtBeforeData: true }))
    .toThrow(/fmt chunk must precede/);
});

test("rejects duplicate fmt and data chunks instead of hiding later audio", () => {
  const canonical = buildWav({
    format: 1,
    bitsPerSample: 16,
    channels: 1,
    sampleRate: 16000,
    data: pcm16([1]),
  });
  const duplicateData = appendChunk(canonical, "data", pcm16([2, 3, 4]));
  expect(() => inspectWavMetadata(duplicateData)).toThrow(/duplicate data/);
  expect(() => decodeWav(duplicateData)).toThrow(/duplicate data/);

  const fmtBody = new Uint8Array(canonical, 20, 16);
  const duplicateFmt = appendChunk(canonical, "fmt ", fmtBody);
  expect(() => inspectWavMetadata(duplicateFmt)).toThrow(/duplicate fmt/);
});

test("shared synthesized-output admission validates structure and transport caps", () => {
  const valid = buildWav({
    format: 1,
    bitsPerSample: 16,
    channels: 1,
    sampleRate: 16000,
    data: pcm16([1]),
  });
  expect(admitSynthesizedWav(valid)?.frameCount).toBe(1);
  expect(() => admitSynthesizedWav(valid, { maxBytes: valid.byteLength - 1 }))
    .toThrow(/byte limit/);
  expect(() => admitSynthesizedWav(new ArrayBuffer(8))).toThrow(/RIFF/);
  expect(admitSynthesizedWav(new ArrayBuffer(0), { allowEmpty: true })).toBeNull();
});

test("synthesized-output admission revalidates a mutable buffer on every use", () => {
  const wav = buildWav({
    format: 1,
    bitsPerSample: 16,
    channels: 1,
    sampleRate: 16000,
    data: pcm16([1]),
  });
  expect(admitSynthesizedWav(wav)?.frameCount).toBe(1);

  new Uint8Array(wav)[0] = 0;
  expect(() => admitSynthesizedWav(wav)).toThrow(/RIFF\/WAVE/);
});

test("synthesized-output snapshots own fixed bytes before validation and retention", () => {
  const providerBuffer = buildWav({
    format: 1,
    bitsPerSample: 16,
    channels: 1,
    sampleRate: 16000,
    data: pcm16([7]),
  });
  const snapshot = snapshotSynthesizedWav(providerBuffer);
  expect(snapshot.audio).not.toBe(providerBuffer);
  expect(snapshot.metadata?.frameCount).toBe(1);

  new Uint8Array(providerBuffer)[0] = 0;
  expect(new Uint8Array(snapshot.audio)[0]).toBe("R".charCodeAt(0));
  expect(admitSynthesizedWav(snapshot.audio)?.frameCount).toBe(1);
});

interface ResizableBuffer extends ArrayBuffer {
  readonly resizable: boolean;
  resize(byteLength: number): void;
}

const supportsResizableArrayBuffer = typeof (
  ArrayBuffer.prototype as unknown as { resize?: unknown }
).resize === "function";

test.skipIf(!supportsResizableArrayBuffer)(
  "synthesized-output snapshots turn resizable provider storage into a fixed buffer",
  () => {
    const valid = buildWav({
      format: 1,
      bitsPerSample: 16,
      channels: 1,
      sampleRate: 16000,
      data: pcm16([9]),
    });
    const ResizableArrayBuffer = ArrayBuffer as unknown as {
      new(byteLength: number, options: { maxByteLength: number }): ResizableBuffer;
    };
    const providerBuffer = new ResizableArrayBuffer(valid.byteLength, {
      maxByteLength: valid.byteLength + 64,
    });
    new Uint8Array(providerBuffer).set(new Uint8Array(valid));

    const snapshot = snapshotSynthesizedWav(providerBuffer);
    expect(snapshot.audio.resizable).toBe(false);
    providerBuffer.resize(0);
    expect(snapshot.audio.byteLength).toBe(valid.byteLength);
    expect(admitSynthesizedWav(snapshot.audio)?.frameCount).toBe(1);
  },
);

test("RIFF parsing is bounded by the declared size", () => {
  const canonical = buildWav({
    format: 1,
    bitsPerSample: 16,
    channels: 1,
    sampleRate: 16000,
    data: pcm16([0]),
  });
  const withTrailingBytes = new Uint8Array(canonical.byteLength + 16);
  withTrailingBytes.set(new Uint8Array(canonical));
  withTrailingBytes.fill(0xff, canonical.byteLength);
  expect(inspectWavMetadata(withTrailingBytes).declaredRiffLength).toBe(canonical.byteLength);
  expect(() => inspectWavMetadata(withTrailingBytes, { requireExactRiffLength: true }))
    .toThrow(/does not match/);

  const tooShort = canonical.slice(0);
  new DataView(tooShort).setUint32(4, 0, true);
  expect(() => inspectWavMetadata(tooShort)).toThrow(/shorter than.*header/);

  const impossible = canonical.slice(0);
  new DataView(impossible).setUint32(4, 0xffff_ffff, true);
  expect(() => inspectWavMetadata(impossible)).toThrow(/extends beyond/);

  const hidesData = canonical.slice(0);
  new DataView(hidesData).setUint32(4, 28, true); // declared RIFF ends after fmt
  expect(() => inspectWavMetadata(hidesData)).toThrow(/no data chunk/);
});

test("odd-sized chunks require an in-RIFF pad byte", () => {
  const padded = buildWav({
    format: 1,
    bitsPerSample: 8,
    channels: 1,
    sampleRate: 8000,
    data: new Uint8Array([128]),
  });
  expect(inspectWavMetadata(padded).frameCount).toBe(1);
  const missingPad = padded.slice(0, padded.byteLength - 1);
  expect(() => inspectWavMetadata(missingPad)).toThrow(/extends beyond|padding/);
});

test("rejects audio beyond the decoded duration budget before sample allocation", () => {
  const sampleRate = 8_000;
  const overLimitFrames = Math.floor((sampleRate * MAX_DECODED_WAV_DURATION_MS) / 1_000) + 1;
  const overlong = buildWav({
    format: 1,
    bitsPerSample: 8,
    channels: 1,
    sampleRate,
    data: new Uint8Array(overLimitFrames),
  });
  expect(() => decodeWav(overlong)).toThrow(/duration.*exceeds/);
});

test("rejects truncated chunks and fractional data frames", () => {
  const truncated = buildWav({
    format: 1,
    bitsPerSample: 16,
    channels: 1,
    sampleRate: 16000,
    data: pcm16([0]),
  });
  new DataView(truncated).setUint32(40, 1000, true);
  expect(() => inspectWavMetadata(truncated)).toThrow(/chunk extends/);

  const fractional = buildWav({
    format: 1,
    bitsPerSample: 16,
    channels: 1,
    sampleRate: 16000,
    data: new Uint8Array([0]),
  });
  expect(() => inspectWavMetadata(fractional)).toThrow(/frame-aligned/);
});
