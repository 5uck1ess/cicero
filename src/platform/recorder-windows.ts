import type { AudioRecorder, RecordOpts } from "./audio";

export class WindowsAudioRecorder implements AudioRecorder {
  record(outPath: string, opts: RecordOpts): ReturnType<typeof Bun.spawn> {
    const sampleRate = opts.sampleRate ?? 16000;
    const silenceDuration = opts.silenceDuration ?? "1.5";
    const silenceThreshold = opts.silenceThreshold ?? "3%";
    const maxDuration = opts.maxDuration ?? 30;

    return Bun.spawn([
      "sox", "-d", "-q",
      "-r", "48000",
      "-c", "1",
      "-b", "16",
      outPath,
      "highpass", "80",
      "compand", "0.3,1", "6:-70,-60,-20", "-5", "-90", "0.2",
      "rate", "-v", sampleRate.toString(),
      "silence",
      "1", "0.1", silenceThreshold,
      "1", silenceDuration, silenceThreshold,
      "trim", "0", maxDuration.toString(),
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
  }
}
