import type { AudioRecorder, RecordOpts } from "./audio";

/**
 * The exact `sox -d` argv for a capture. Same contract as the POSIX recorder,
 * kept explicitly in step with it: dictation opts out of silence-based auto-stop
 * on every platform, not just the one it was developed on.
 */
export function windowsRecordArgs(outPath: string, opts: RecordOpts): string[] {
  const sampleRate = opts.sampleRate ?? 16000;
  const silenceDuration = opts.silenceDuration ?? "1.5";
  const silenceThreshold = opts.silenceThreshold ?? "3%";
  const maxDuration = opts.maxDuration ?? 30;
  const silence = opts.stopOnSilence === false
    ? []
    : ["silence", "1", "0.1", silenceThreshold, "1", silenceDuration, silenceThreshold];

  return [
    "sox", "-d", "-q",
    "-r", "48000",
    "-c", "1",
    "-b", "16",
    outPath,
    "highpass", "80",
    "compand", "0.3,1", "6:-70,-60,-20", "-5", "-90", "0.2",
    "rate", "-v", sampleRate.toString(),
    ...silence,
    "trim", "0", maxDuration.toString(),
  ];
}

export class WindowsAudioRecorder implements AudioRecorder {
  record(outPath: string, opts: RecordOpts): ReturnType<typeof Bun.spawn> {
    return Bun.spawn(windowsRecordArgs(outPath, opts), {
      stdout: "pipe",
      stderr: "pipe",
    });
  }
}
