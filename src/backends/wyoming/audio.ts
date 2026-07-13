// WAV <-> raw PCM helpers for the Wyoming audio events (which carry raw PCM).

export interface PcmFormat {
  rate: number;
  width: number; // bytes per sample (16-bit PCM → 2)
  channels: number;
}

const DEFAULT_FORMAT: PcmFormat = { rate: 16000, width: 2, channels: 1 };

function ascii(bytes: Uint8Array, offset: number, len: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + len));
}

/** Extract raw PCM + format from a canonical WAV buffer (finds the `data` chunk). */
export function pcmFromWav(wav: Uint8Array): { pcm: Uint8Array; format: PcmFormat } {
  if (wav.byteLength < 44 || ascii(wav, 0, 4) !== "RIFF" || ascii(wav, 8, 4) !== "WAVE") {
    return { pcm: wav, format: { ...DEFAULT_FORMAT } };
  }
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const channels = dv.getUint16(22, true);
  const rate = dv.getUint32(24, true);
  const bits = dv.getUint16(34, true);
  const format: PcmFormat = { rate, width: bits / 8, channels };

  let offset = 12;
  while (offset + 8 <= wav.byteLength) {
    const id = ascii(wav, offset, 4);
    const size = dv.getUint32(offset + 4, true);
    if (id === "data") {
      const start = offset + 8;
      return { pcm: wav.slice(start, Math.min(start + size, wav.byteLength)), format };
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  return { pcm: wav.slice(44), format };
}

/** Wrap raw PCM in a canonical 16-bit WAV header. */
export function wavFromPcm(pcm: Uint8Array, format: PcmFormat = DEFAULT_FORMAT): ArrayBuffer {
  const { rate, width, channels } = format;
  const blockAlign = channels * width;
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const dv = new DataView(buf);
  const write = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  write(0, "RIFF");
  dv.setUint32(4, 36 + pcm.byteLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, width * 8, true);
  write(36, "data");
  dv.setUint32(40, pcm.byteLength, true);
  new Uint8Array(buf, 44).set(pcm);
  return buf;
}
