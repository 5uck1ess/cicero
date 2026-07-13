import { describe, expect, test } from "bun:test";
import {
  MAX_PROTOCOL_ID_BYTES,
  decodeTurnAudioFrame,
  encodeTurnAudioFrame,
  inspectTurnAudio,
  isProtocolId,
} from "../../src/web-voice/protocol";

function floatWav(sample: number, dataFirst = false): ArrayBuffer {
  const out = new Uint8Array(48);
  const view = new DataView(out.buffer);
  const tag = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) out[offset + index] = value.charCodeAt(index);
  };
  tag(0, "RIFF"); view.setUint32(4, 40, true); tag(8, "WAVE");
  const fmt = dataFirst ? 24 : 12;
  const data = dataFirst ? 12 : 36;
  tag(fmt, "fmt "); view.setUint32(fmt + 4, 16, true); view.setUint16(fmt + 8, 3, true);
  view.setUint16(fmt + 10, 1, true); view.setUint32(fmt + 12, 16_000, true);
  view.setUint32(fmt + 16, 64_000, true); view.setUint16(fmt + 20, 4, true);
  view.setUint16(fmt + 22, 32, true);
  tag(data, "data"); view.setUint32(data + 4, 4, true); view.setFloat32(data + 8, sample, true);
  return out.buffer;
}

function withHiddenSecondData(input: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(input.byteLength + 12);
  out.set(new Uint8Array(input));
  const view = new DataView(out.buffer);
  const offset = input.byteLength;
  out.set(new TextEncoder().encode("data"), offset);
  view.setUint32(offset + 4, 4, true);
  view.setFloat32(offset + 8, 0.5, true);
  view.setUint32(4, out.byteLength - 8, true);
  return out.buffer;
}

describe("web-voice protocol v2 envelope", () => {
  test("wire WAV admission requires fmt before data and finite float samples", () => {
    expect(inspectTurnAudio(floatWav(0.25))).not.toBeNull();
    expect(inspectTurnAudio(floatWav(0.25, true))).toBeNull();
    expect(inspectTurnAudio(floatWav(Number.NaN))).toBeNull();
    expect(inspectTurnAudio(floatWav(Number.NEGATIVE_INFINITY))).toBeNull();
    expect(inspectTurnAudio(withHiddenSecondData(floatWav(0.25)))).toBeNull();
  });

  test("round-trips identities and copies the payload", () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    const encoded = encodeTurnAudioFrame("session-1", "turn-9", source.buffer);
    source[0] = 99;
    const decoded = decodeTurnAudioFrame(new Uint8Array(encoded));
    expect(decoded?.sessionId).toBe("session-1");
    expect(decoded?.turnId).toBe("turn-9");
    expect([...new Uint8Array(decoded!.payload)]).toEqual([1, 2, 3, 4]);
  });

  test("rejects raw, truncated, malformed, and invalid-id frames", () => {
    expect(decodeTurnAudioFrame(new Uint8Array([1, 2, 3]))).toBeNull();
    const truncated = new Uint8Array([0x43, 0x56, 0x50, 0x32, 20, 0, 20, 0, 1]);
    expect(decodeTurnAudioFrame(truncated)).toBeNull();
    expect(isProtocolId("ok.turn:1")).toBe(true);
    expect(isProtocolId("../escape")).toBe(false);
    expect(isProtocolId("x".repeat(MAX_PROTOCOL_ID_BYTES + 1))).toBe(false);
    expect(() => encodeTurnAudioFrame("bad id", "turn", new ArrayBuffer(0))).toThrow();
  });
});
