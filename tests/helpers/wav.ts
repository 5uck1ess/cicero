import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WavFixture {
  dir: string;
  path: string;
}

/** Create a canonical silent 16-bit mono WAV without relying on ffmpeg. */
export function writeWavFixture(durationSeconds = 2, sampleRate = 16_000): WavFixture {
  const samples = Math.round(sampleRate * durationSeconds);
  const dataSize = samples * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(dataSize + 36, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);

  const dir = mkdtempSync(join(tmpdir(), "cicero-wav-"));
  const path = join(dir, "sample.wav");
  writeFileSync(path, wav);
  return { dir, path };
}
