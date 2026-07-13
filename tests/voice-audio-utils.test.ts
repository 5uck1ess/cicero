import { test, expect, describe } from "bun:test";
import { inspectWav, trimWav } from "../src/voice/audio-utils";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hasFfmpeg = Bun.which("ffmpeg") !== null;

function fakeFfmpeg(directory: string, body: string): string {
  const path = join(directory, "fake-ffmpeg");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

/** Build a canonical 16-bit PCM WAV header + silence body. */
function synthWav(samples: number, sampleRate: number, channels: number): Buffer {
  const dataSize = samples * channels * 2;
  const fileSize = dataSize + 36;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(fileSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function withSecondDataChunk(input: Buffer): Buffer {
  const extra = Buffer.alloc(10);
  extra.write("data", 0);
  extra.writeUInt32LE(2, 4);
  extra.writeInt16LE(1, 8);
  const out = Buffer.concat([input, extra]);
  out.writeUInt32LE(out.byteLength - 8, 4);
  return out;
}

describe("inspectWav", () => {
  test("reads sample rate and duration from WAV header", async () => {
    const path = join(tmpdir(), `cicero-test-${Date.now()}.wav`);
    writeFileSync(path, synthWav(16000, 16000, 1));
    try {
      const info = await inspectWav(path);
      expect(info.sampleRate).toBe(16000);
      expect(info.duration_s).toBeCloseTo(1.0, 1);
      expect(info.channels).toBe(1);
      expect(info.bitsPerSample).toBe(16);
    } finally {
      unlinkSync(path);
    }
  });

  test("computes duration for stereo 44.1kHz", async () => {
    const path = join(tmpdir(), `cicero-test-${Date.now()}-stereo.wav`);
    writeFileSync(path, synthWav(44100 * 2, 44100, 2)); // 2 seconds
    try {
      const info = await inspectWav(path);
      expect(info.sampleRate).toBe(44100);
      expect(info.channels).toBe(2);
      expect(info.duration_s).toBeCloseTo(2.0, 1);
    } finally {
      unlinkSync(path);
    }
  });

  test("rejects non-RIFF files", async () => {
    const path = join(tmpdir(), `cicero-test-${Date.now()}.notwav`);
    writeFileSync(path, Buffer.from("this is not a wav file at all really"));
    try {
      await expect(inspectWav(path)).rejects.toThrow(/RIFF|WAVE/);
    } finally {
      unlinkSync(path);
    }
  });

  test("rejects a hidden second data chunk used to bypass reference duration checks", async () => {
    const path = join(tmpdir(), `cicero-test-${Date.now()}-duplicate-data.wav`);
    writeFileSync(path, withSecondDataChunk(synthWav(1, 16000, 1)));
    try {
      await expect(inspectWav(path)).rejects.toThrow(/duplicate data/);
    } finally {
      unlinkSync(path);
    }
  });
});

describe("trimWav", () => {
  test.skipIf(!hasFfmpeg)("downsamples to 16kHz mono and caps duration", async () => {
    const src = join(tmpdir(), `cicero-trim-src-${Date.now()}.wav`);
    const out = join(tmpdir(), `cicero-trim-out-${Date.now()}.wav`);
    writeFileSync(src, synthWav(44100 * 5, 44100, 2)); // 5s stereo 44.1kHz
    try {
      await trimWav(src, out, 2);
      const info = await inspectWav(out);
      expect(info.sampleRate).toBe(16000);
      expect(info.channels).toBe(1);
      expect(info.duration_s).toBeLessThanOrEqual(2.5);
    } finally {
      unlinkSync(src);
      unlinkSync(out);
    }
  });

  test.skipIf(process.platform === "win32")("publishes from a private random sibling and replaces a symlink, not its target", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cicero-trim-atomic-"));
    const src = join(directory, "source.wav");
    const target = join(directory, "target.wav");
    const out = join(directory, "output.wav");
    writeFileSync(src, synthWav(10, 16000, 1));
    writeFileSync(target, "preserve target");
    symlinkSync(target, out);
    const ffmpeg = fakeFfmpeg(
      directory,
      'input=""; previous=""; for arg in "$@"; do if [ "$previous" = "-i" ]; then input="$arg"; fi; previous="$arg"; last="$arg"; done; cp "$input" "$last"',
    );

    try {
      await trimWav(src, out, 2, 16000, { ffmpegBinary: ffmpeg, timeoutMs: 1_000 });

      expect(lstatSync(out).isSymbolicLink()).toBe(false);
      expect(readFileSync(out)).toEqual(readFileSync(src));
      expect(readFileSync(target, "utf8")).toBe("preserve target");
      expect(statSync(out).mode & 0o777).toBe(0o600);
      expect(readdirSync(directory).some((name) => name.startsWith(".output.wav.pending-"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("keeps the prior output and cleans partial work when ffmpeg fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cicero-trim-failure-"));
    const src = join(directory, "source.wav");
    const out = join(directory, "output.wav");
    writeFileSync(src, synthWav(10, 16000, 1));
    writeFileSync(out, "previous complete clip");
    const ffmpeg = fakeFfmpeg(
      directory,
      'for last do :; done; printf "partial" > "$last"; printf "fixture diagnostic" >&2; exit 7',
    );

    try {
      await expect(trimWav(src, out, 2, 16000, { ffmpegBinary: ffmpeg, timeoutMs: 1_000 }))
        .rejects.toThrow("fixture diagnostic");
      expect(readFileSync(out, "utf8")).toBe("previous complete clip");
      expect(readdirSync(directory).some((name) => name.startsWith(".output.wav.pending-"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("rejects a successful converter that publishes a malformed WAV", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cicero-trim-malformed-"));
    const src = join(directory, "source.wav");
    const out = join(directory, "output.wav");
    writeFileSync(src, synthWav(10, 16000, 1));
    writeFileSync(out, "previous complete clip");
    const ffmpeg = fakeFfmpeg(directory, 'for last do :; done; printf "not a wav" > "$last"');

    try {
      await expect(trimWav(src, out, 2, 16000, { ffmpegBinary: ffmpeg, timeoutMs: 1_000 }))
        .rejects.toThrow("not a valid PCM WAV");
      expect(readFileSync(out, "utf8")).toBe("previous complete clip");
      expect(readdirSync(directory).some((name) => name.startsWith(".output.wav.pending-"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("terminates a hung ffmpeg at its wall deadline without publishing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cicero-trim-timeout-"));
    const src = join(directory, "source.wav");
    const out = join(directory, "output.wav");
    writeFileSync(src, synthWav(10, 16000, 1));
    writeFileSync(out, "previous complete clip");
    const ffmpeg = fakeFfmpeg(directory, "trap '' TERM; while :; do :; done");

    try {
      await expect(trimWav(src, out, 2, 16000, { ffmpegBinary: ffmpeg, timeoutMs: 20 }))
        .rejects.toThrow("20ms wall deadline");
      expect(readFileSync(out, "utf8")).toBe("previous complete clip");
      expect(readdirSync(directory).some((name) => name.startsWith(".output.wav.pending-"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
