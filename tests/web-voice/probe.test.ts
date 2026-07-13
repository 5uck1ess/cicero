import { test, expect } from "bun:test";
import { PROBE_MAGIC, isProbeFrame, decodeProbeFrame, encodeProbeFrame } from "../../src/web-voice/probe";

function frame(samples: number[], sampleRate = 16000): Uint8Array {
  return new Uint8Array(encodeProbeFrame(new Float32Array(samples), sampleRate));
}

test("probe frames round-trip samples and sample rate", () => {
  const original = [0, 0.5, -0.5, 1, -1, 0.123];
  const decoded = decodeProbeFrame(frame(original, 24000));
  expect(decoded).not.toBeNull();
  expect(decoded!.sampleRate).toBe(24000);
  expect(decoded!.samples.length).toBe(original.length);
  for (let i = 0; i < original.length; i++) {
    expect(Math.abs(decoded!.samples[i]! - original[i]!)).toBeLessThan(1 / 32000);
  }
});

test("a WAV is not a probe — RIFF magic falls through to the turn path", () => {
  const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 1, 2, 3, 4]); // "RIFF"
  expect(isProbeFrame(wav)).toBe(false);
  expect(decodeProbeFrame(wav)).toBeNull();
});

test("malformed probes decode to null instead of throwing", () => {
  expect(decodeProbeFrame(new Uint8Array([0x50, 0x52]))).toBeNull(); // truncated magic
  expect(decodeProbeFrame(frame([]))).toBeNull(); // no samples
  const silly = new Uint8Array(encodeProbeFrame(new Float32Array([0.1]), 4000)); // absurd rate
  expect(decodeProbeFrame(silly)).toBeNull();
});

test("encoder clamps out-of-range samples", () => {
  const decoded = decodeProbeFrame(frame([2.5, -2.5]));
  expect(decoded!.samples[0]).toBeLessThanOrEqual(1);
  expect(decoded!.samples[1]).toBeGreaterThanOrEqual(-1);
});

test("magic constant matches the wire bytes", () => {
  const f = frame([0.1]);
  expect(String.fromCharCode(f[0]!, f[1]!, f[2]!, f[3]!)).toBe(PROBE_MAGIC);
});

test("v2 probe frames round-trip the utterance duration", () => {
  const buf = new Uint8Array(encodeProbeFrame(new Float32Array([0.25, -0.25]), 16000, 3210));
  expect(isProbeFrame(buf)).toBe(true);
  const decoded = decodeProbeFrame(buf);
  expect(decoded).not.toBeNull();
  expect(decoded!.sampleRate).toBe(16000);
  expect(decoded!.utterMs).toBe(3210);
  expect(decoded!.samples.length).toBe(2);
});

test("legacy PROB frames still decode, with no utterance duration", () => {
  const buf = new Uint8Array(encodeProbeFrame(new Float32Array([0.5]), 24000));
  expect(buf[3]).toBe(0x42); // "PROB", not "PRB2"
  const decoded = decodeProbeFrame(buf);
  expect(decoded).not.toBeNull();
  expect(decoded!.utterMs).toBeUndefined();
  expect(decoded!.sampleRate).toBe(24000);
});

test("a v2 header with no PCM is rejected", () => {
  const buf = new Uint8Array(encodeProbeFrame(new Float32Array([0.5]), 16000, 100)).slice(0, 12);
  expect(decodeProbeFrame(buf)).toBeNull();
});
