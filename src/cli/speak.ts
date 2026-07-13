import { RuntimeConfig } from "../config";
import { createTTSProvider } from "../backends/registry";
import type { TTSProvider } from "../backends/tts/provider";
import { snapshotSynthesizedWav } from "../platform/wav";

export type SpeechTerminationSignal = "SIGINT" | "SIGTERM";

export interface SpeechSignalSource {
  on(event: SpeechTerminationSignal, listener: () => void): unknown;
  removeListener(event: SpeechTerminationSignal, listener: () => void): unknown;
}

export class SpeechInterruptedError extends Error {
  readonly signal: SpeechTerminationSignal;
  readonly cleanupError?: Error;

  constructor(signal: SpeechTerminationSignal, cleanupError?: Error) {
    const cleanupDetail = cleanupError ? `; cleanup failed: ${cleanupError.message}` : "";
    super(`speech interrupted by ${signal}${cleanupDetail}`, cleanupError ? { cause: cleanupError } : undefined);
    this.name = "SpeechInterruptedError";
    this.signal = signal;
    this.cleanupError = cleanupError;
  }
}

export interface ConfiguredSpeechOptions {
  voice?: string;
  refAudio?: string;
  refText?: string;
  /** Provider injection for embedded runtimes and deterministic lifecycle tests. */
  providerFactory?: (config: RuntimeConfig) => TTSProvider;
  /** CLI-owned signal source. Omit when an embedding runtime owns termination. */
  signalSource?: SpeechSignalSource;
}

export interface ConfiguredSpeechResult {
  audio: ArrayBuffer;
  providerName: string;
}

type SpeechOperationOutcome =
  | { kind: "rendered"; result: ConfiguredSpeechResult }
  | { kind: "failed"; error: Error };

interface SpeechInterruptionOutcome {
  kind: "interrupted";
  signal: SpeechTerminationSignal;
  cleanupError?: Error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lifecycleError(providerName: string, phase: "render" | "cleanup", error: unknown): Error {
  return new Error(`${providerName} ${phase} failed: ${errorMessage(error)}`, { cause: error });
}

/** Preserve the useful child failures of an AggregateError in CLI output. */
export function describeSpeechError(error: unknown): string {
  const summary = errorMessage(error);
  if (!(error instanceof AggregateError) || error.errors.length === 0) return summary;
  return `${summary}: ${error.errors.map(errorMessage).join("; ")}`;
}

export function speechSignalExitCode(signal: SpeechTerminationSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}

export interface SpeechTerminationTarget {
  readonly pid: number;
  exitCode?: string | number | null;
  kill(pid: number, signal: SpeechTerminationSignal): boolean;
}

/** Re-raise only after provider cleanup, with a conventional exit-code fallback. */
export function preserveSpeechSignalTermination(
  signal: SpeechTerminationSignal,
  target: SpeechTerminationTarget,
): void {
  target.exitCode = speechSignalExitCode(signal);
  target.kill(target.pid, signal);
}

/** Render through the exact provider graph used by the daemon. */
export async function renderConfiguredSpeech(
  config: RuntimeConfig,
  text: string,
  options: ConfiguredSpeechOptions = {},
): Promise<ConfiguredSpeechResult> {
  const effectiveConfig = new RuntimeConfig({
    ...config.raw,
    tts: {
      ...config.ttsBackend,
      ...(options.refAudio !== undefined ? { refAudio: options.refAudio } : {}),
      ...(options.refText !== undefined ? { refText: options.refText } : {}),
    },
  });
  const provider = (options.providerFactory ?? createTTSProvider)(effectiveConfig);
  const interruptionState: { signal: SpeechTerminationSignal | null } = { signal: null };
  let resolveInterruption: (outcome: SpeechInterruptionOutcome) => void = () => {};
  const interruption = new Promise<SpeechInterruptionOutcome>((resolve) => {
    resolveInterruption = resolve;
  });

  // Some providers publish their ManagedProcess only after start() resolves.
  // Queueing the one stop behind that exact startup attempt prevents an early
  // signal from observing no handle and then leaking the handle published later.
  let startup: Promise<void> | null = null;
  const startProvider = (): Promise<void> => {
    startup ??= Promise.resolve().then(async () => {
      await provider.start?.();
    });
    return startup;
  };
  let cleanup: Promise<void> | null = null;
  const stopProviderOnce = (): Promise<void> => {
    cleanup ??= (startup ?? Promise.resolve())
      .catch(() => { /* startup failure still requires best-effort cleanup */ })
      .then(async () => {
        await provider.stop?.();
      });
    return cleanup;
  };

  const handleSignal = (signal: SpeechTerminationSignal): void => {
    if (interruptionState.signal) return;
    interruptionState.signal = signal;
    void stopProviderOnce().then(
      () => resolveInterruption({ kind: "interrupted", signal }),
      (error: unknown) => resolveInterruption({
        kind: "interrupted",
        signal,
        cleanupError: lifecycleError(provider.name, "cleanup", error),
      }),
    );
  };
  const onSigint = (): void => handleSignal("SIGINT");
  const onSigterm = (): void => handleSignal("SIGTERM");
  let sigintInstalled = false;
  let sigtermInstalled = false;

  try {
    if (options.signalSource) {
      // Keep both handlers installed through cleanup: repeated Ctrl-C/TERM is
      // coalesced instead of restoring the default action early and leaking.
      options.signalSource.on("SIGINT", onSigint);
      sigintInstalled = true;
      options.signalSource.on("SIGTERM", onSigterm);
      sigtermInstalled = true;
    }

    const operation = (async (): Promise<SpeechOperationOutcome> => {
      try {
        await startProvider();
        if (interruptionState.signal) {
          return {
            kind: "failed",
            error: new Error(`${provider.name} render cancelled before synthesis`),
          };
        }
        const providerAudio = await provider.generateAudio(text, options.voice, { speed: 1 });
        if (providerAudio.byteLength === 0) throw new Error("empty audio response");
        const audio = snapshotSynthesizedWav(providerAudio).audio;
        return { kind: "rendered", result: { audio, providerName: provider.name } };
      } catch (error: unknown) {
        return { kind: "failed", error: lifecycleError(provider.name, "render", error) };
      }
    })();

    const first = options.signalSource
      ? await Promise.race([operation, interruption])
      : await operation;
    if (first.kind === "interrupted") {
      throw new SpeechInterruptedError(first.signal, first.cleanupError);
    }

    let cleanupError: Error | null = null;
    try {
      await stopProviderOnce();
    } catch (error: unknown) {
      cleanupError = lifecycleError(provider.name, "cleanup", error);
    }

    // A signal may arrive after rendering wins the race but while normal
    // cleanup is in flight. It still owns the final outcome and exit status.
    const interruptedSignal = interruptionState.signal;
    if (interruptedSignal) throw new SpeechInterruptedError(interruptedSignal, cleanupError ?? undefined);

    if (first.kind === "failed" && cleanupError) {
      throw new AggregateError(
        [first.error, cleanupError],
        `${provider.name} render and cleanup failed`,
      );
    }
    if (first.kind === "failed") throw first.error;
    if (cleanupError) throw cleanupError;
    return first.result;
  } finally {
    if (options.signalSource && sigintInstalled) {
      options.signalSource.removeListener("SIGINT", onSigint);
    }
    if (options.signalSource && sigtermInstalled) {
      options.signalSource.removeListener("SIGTERM", onSigterm);
    }
  }
}
