import type { AudioRecorder, RecordOpts } from "./audio";

/**
 * The exact `rec` argv for a capture. Exported so the effect chain can be
 * asserted without spawning SoX — in particular that dictation's capture carries
 * no silence-based auto-stop.
 */
export function soxRecordArgs(outPath: string, opts: RecordOpts): string[] {
  const sampleRate = opts.sampleRate ?? 16000;
  const silenceDuration = opts.silenceDuration ?? "1.5";
  const silenceThreshold = opts.silenceThreshold ?? "3%";
  const maxDuration = opts.maxDuration ?? 30;
  // Omitting the effect entirely — not just widening its duration — is what lets
  // a dictation hold through a pause of any length. The leading half goes too:
  // it withholds audio until speech starts, which would clip the first word of a
  // capture the operator has already started by hand.
  const silence = opts.stopOnSilence === false
    ? []
    : ["silence", "1", "0.1", silenceThreshold, "1", silenceDuration, silenceThreshold];

  return [
    "rec", "-q",
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

export class SoxAudioRecorder implements AudioRecorder {
  record(outPath: string, opts: RecordOpts): ReturnType<typeof Bun.spawn> {
    return Bun.spawn(soxRecordArgs(outPath, opts), {
      stdout: "pipe",
      stderr: "pipe",
    });
  }
}
