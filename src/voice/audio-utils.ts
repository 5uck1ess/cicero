import { MAX_DECODED_WAV_BYTES, inspectWavMetadata } from "../platform/wav";
import { chmod, lstat, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  BoundedCommandError,
  runBoundedCommand,
} from "../process/bounded-command";

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  duration_s: number;
}

const FFMPEG_TRIM_TIMEOUT_MS = 120_000;
const MAX_TRIM_SECONDS = 5 * 60;
const MAX_TRIM_SAMPLE_RATE = 96_000;
const MAX_TRIM_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface TrimWavOptions {
  /** Injectable executable/deadline/limit for deterministic command tests. */
  ffmpegBinary?: string;
  timeoutMs?: number;
  outputLimitBytes?: number;
}

function commandErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = error instanceof BoundedCommandError ? error.result.stderr.text.trim() : "";
  return stderr ? `${message}: ${stderr}` : message;
}

/**
 * Inspect a bounded PCM/float WAV using the same complete RIFF walk as web and
 * synthesized-audio admission. Throws on malformed or ambiguous chunk layouts.
 */
export async function inspectWav(path: string): Promise<WavInfo> {
  try {
    const file = Bun.file(path);
    if (file.size > MAX_DECODED_WAV_BYTES) {
      throw new Error(`WAVE input exceeds the ${MAX_DECODED_WAV_BYTES}-byte inspection limit`);
    }
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > MAX_DECODED_WAV_BYTES) {
      throw new Error(`WAVE input exceeds the ${MAX_DECODED_WAV_BYTES}-byte inspection limit`);
    }
    const metadata = inspectWavMetadata(buffer, {
      requireExactRiffLength: true,
      requireFmtBeforeData: true,
      requireFiniteFloatSamples: true,
      allowEmpty: false,
    });
    return {
      sampleRate: metadata.sampleRate,
      channels: metadata.channels,
      bitsPerSample: metadata.bitsPerSample,
      duration_s: metadata.durationMs / 1_000,
    };
  } catch (error: unknown) {
    if (error instanceof Error) throw error;
    throw new Error(`could not inspect WAVE file '${path}': ${String(error)}`);
  }
}

/**
 * Trim/resample a clip to ≤maxSeconds, mono WAV via ffmpeg. Used to produce
 * the reference clip for cloning inference / cloud upload. Resamples to
 * `sampleRate` (default 16kHz, what VibeVoice wants); pass null to keep the
 * source rate — pocket-tts clones sound noticeably duller from a 16k reference.
 */
export async function trimWav(
  input: string,
  output: string,
  maxSeconds = 30,
  sampleRate: number | null = 16000,
  options: TrimWavOptions = {},
): Promise<void> {
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > MAX_TRIM_SECONDS) {
    throw new RangeError(`maxSeconds must be greater than 0 and at most ${MAX_TRIM_SECONDS}`);
  }
  if (sampleRate !== null && (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > MAX_TRIM_SAMPLE_RATE)) {
    throw new RangeError(`sampleRate must be null or an integer from 8000 to ${MAX_TRIM_SAMPLE_RATE}`);
  }
  const outputLimitBytes = options.outputLimitBytes ?? MAX_TRIM_OUTPUT_BYTES;
  if (!Number.isSafeInteger(outputLimitBytes) || outputLimitBytes <= 0) {
    throw new RangeError("outputLimitBytes must be a positive integer");
  }

  // ffmpeg writes into a private random sibling directory. Only a complete,
  // bounded result is renamed over the destination, so failures never expose
  // a partial clone or follow an existing output symlink.
  const pendingDirectory = await mkdtemp(join(dirname(output), `.${basename(output)}.pending-`));
  const pendingOutput = join(pendingDirectory, "trimmed.wav");
  try {
    let result: Awaited<ReturnType<typeof runBoundedCommand>>;
    try {
      result = await runBoundedCommand([
        options.ffmpegBinary ?? "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-i", input,
        "-t", String(maxSeconds),
        ...(sampleRate === null ? [] : ["-ar", String(sampleRate)]),
        "-ac", "1",
        "-c:a", "pcm_s16le",
        "-map_metadata", "-1",
        "-vn",
        "-fs", String(outputLimitBytes),
        pendingOutput,
      ], {
        timeoutMs: options.timeoutMs ?? FFMPEG_TRIM_TIMEOUT_MS,
        stdoutLimitBytes: 0,
        stderrLimitBytes: 16 * 1024,
        totalLimitBytes: 16 * 1024,
        outputLimitBehavior: "error",
        stderrCapture: "tail",
      });
    } catch (error: unknown) {
      throw new Error(`ffmpeg trim failed: ${commandErrorDetail(error)}`, { cause: error });
    }

    if (result.exitCode !== 0) {
      throw new Error(`ffmpeg trim failed (exit ${result.exitCode}): ${result.stderr.text.trim() || "no diagnostics"}`);
    }
    const generated = await lstat(pendingOutput).catch(() => null);
    if (!generated?.isFile() || generated.size === 0) {
      throw new Error("ffmpeg trim failed: no regular output file was produced");
    }
    if (generated.size > outputLimitBytes) {
      throw new Error(`ffmpeg trim failed: output exceeded ${outputLimitBytes} bytes`);
    }
    let info: WavInfo;
    try {
      info = await inspectWav(pendingOutput);
    } catch (error: unknown) {
      throw new Error(`ffmpeg trim failed: output is not a valid PCM WAV: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const durationTolerance = 2 / info.sampleRate;
    if (info.channels !== 1
      || info.bitsPerSample !== 16
      || info.sampleRate < 8_000
      || info.sampleRate > MAX_TRIM_SAMPLE_RATE
      || (sampleRate !== null && info.sampleRate !== sampleRate)
      || !Number.isFinite(info.duration_s)
      || info.duration_s <= 0
      || info.duration_s > maxSeconds + durationTolerance) {
      throw new Error(
        `ffmpeg trim failed: output WAV envelope is invalid `
        + `(${info.sampleRate}Hz, ${info.channels}ch, ${info.bitsPerSample}bit, ${info.duration_s.toFixed(3)}s)`,
      );
    }
    if (process.platform !== "win32") await chmod(pendingOutput, 0o600);
    await rename(pendingOutput, output);
  } finally {
    await rm(pendingDirectory, { recursive: true, force: true }).catch(() => {
      // Preserve the conversion/publish error; the random private directory
      // is safe to retry cleaning on the next maintenance pass.
    });
  }
}
