import type { Speaker } from "../types";
import { AudioReleaseUnconfirmedError } from "./owned-audio-player";
import { terminateDirectChild, type DirectChildProcess } from "../process/direct-child";

export interface SystemTtsSpec {
  /** Command to spawn (no shell). */
  cmd: string[];
  /** If set, write this to the process stdin instead of passing text as an arg. */
  stdinText?: string;
}

export interface SpawnedSystemTts {
  process: DirectChildProcess;
  /** Present only for the PowerShell stdin transport. */
  writeInput?: (text: string) => void | Promise<void>;
}

export type SpawnSystemTts = (spec: SystemTtsSpec) => SpawnedSystemTts;

function raceWithStop<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const observed = Promise.resolve(work);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const finish = (callback: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => fail(signal.reason);

    signal.addEventListener("abort", onAbort, { once: true });
    observed.then((value) => finish(resolve, value), fail);
    if (signal.aborted) onAbort();
  });
}

function spawnSystemTts(spec: SystemTtsSpec): SpawnedSystemTts {
  if (spec.stdinText !== undefined) {
    const process = Bun.spawn(spec.cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    return {
      process,
      writeInput(text) {
        process.stdin.write(text);
        return Promise.resolve(process.stdin.end()).then(() => {});
      },
    };
  }
  return {
    process: Bun.spawn(spec.cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
  };
}

/**
 * Build the OS "system voice" command used as the TTS fallback when no model
 * server is available: `say` on macOS, PowerShell System.Speech on Windows,
 * spd-say on Linux/other.
 */
export function buildSystemTts(
  text: string,
  platform: NodeJS.Platform = process.platform,
): SystemTtsSpec {
  switch (platform) {
    case "darwin":
      return { cmd: ["say", "-r", "200", "--", text] };
    case "win32":
      // Read text from stdin so it can't break PowerShell quoting or inject.
      return {
        cmd: [
          "powershell", "-NoProfile", "-Command",
          "Add-Type -AssemblyName System.Speech;" +
            "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;" +
            "$s.Rate=2;$s.Speak([Console]::In.ReadToEnd())",
        ],
        stdinText: text,
      };
    default:
      // Linux/other: spd-say (speech-dispatcher); -w waits for completion.
      return { cmd: ["spd-say", "-w", "--", text] };
  }
}

/** Cross-platform fallback speaker that drives the OS system voice. */
export class SystemSpeaker implements Speaker {
  private readonly active = new Set<DirectChildProcess>();
  private readonly stopRequested = new WeakSet<DirectChildProcess>();
  private readonly terminations = new Map<DirectChildProcess, Promise<void>>();
  private stopped = false;
  private stopTask: Promise<void> | null = null;
  private releaseFailure: AudioReleaseUnconfirmedError | null = null;
  private readonly stopController = new AbortController();

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly spawn: SpawnSystemTts = spawnSystemTts,
  ) {}

  async speak(text: string): Promise<void> {
    if (this.stopped) return;
    if (this.releaseFailure) throw this.releaseFailure;
    const spec = buildSystemTts(text, this.platform);
    let spawned: SpawnedSystemTts;
    try {
      spawned = this.spawn(spec);
    } catch (error: unknown) {
      throw new Error(
        `could not start system TTS '${spec.cmd[0]}': ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const child = spawned.process;
    this.active.add(child);

    let exitObserved = false;
    try {
      if (spec.stdinText !== undefined) {
        try {
          if (!spawned.writeInput) {
            throw new Error("system TTS stdin transport did not provide an input writer");
          }
          await raceWithStop(
            Promise.resolve(spawned.writeInput(spec.stdinText)),
            this.stopController.signal,
          );
        } catch (error: unknown) {
          this.stopRequested.add(child);
          try {
            await this.terminate(child);
            exitObserved = true;
          } catch (cleanupError: unknown) {
            throw this.rememberReleaseFailure("system TTS input failed and child release is unconfirmed", cleanupError);
          }
          if (this.stopped) return;
          throw new Error(
            `could not write system TTS input: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }

      let exitCode: number;
      try {
        exitCode = await raceWithStop(child.exited, this.stopController.signal);
        exitObserved = true;
      } catch (error: unknown) {
        // A rejected wait/exit promise does not prove that the native speaker
        // process released the audio device. Signal this exact child now; a
        // later global stop may never arrive, and merely latching the failure
        // would leave an unobserved system voice running indefinitely.
        this.stopRequested.add(child);
        try {
          await this.terminate(child);
          exitObserved = true;
        } catch (cleanupError: unknown) {
          throw this.rememberReleaseFailure(
            "system TTS exit observation failed and child release is unconfirmed",
            new AggregateError([error, cleanupError], "system TTS exit and cleanup failed"),
          );
        }
        if (this.stopped) return;
        throw new Error(
          `system TTS exit observation failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (exitCode !== 0 && !this.stopRequested.has(child)) {
        throw new Error(`system TTS '${spec.cmd[0]}' exited with ${exitCode}`);
      }
    } finally {
      if (exitObserved) this.active.delete(child);
    }
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (!this.stopController.signal.aborted) {
      this.stopController.abort(new Error("system TTS stopping"));
    }
    if (this.stopTask) return this.stopTask;

    const children = [...this.active];
    if (children.length === 0) {
      this.releaseFailure = null;
      return Promise.resolve();
    }
    for (const child of children) this.stopRequested.add(child);

    const task = this.stopOwnedChildren(children);
    const tracked = task.finally(() => {
      if (this.stopTask === tracked) this.stopTask = null;
    });
    this.stopTask = tracked;
    return tracked;
  }

  async health(): Promise<boolean> {
    return true;
  }

  private async stopOwnedChildren(children: DirectChildProcess[]): Promise<void> {
    const outcomes = await Promise.allSettled(children.map((child) => this.terminate(child)));
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : []
    );
    if (failures.length > 0) {
      throw this.rememberReleaseFailure(
        "one or more system TTS children did not confirm release",
        new AggregateError(failures, "system TTS shutdown failed"),
      );
    }
    if (this.active.size === 0) this.releaseFailure = null;
  }

  private terminate(child: DirectChildProcess): Promise<void> {
    const existing = this.terminations.get(child);
    if (existing) return existing;
    const task = terminateDirectChild(child).then(() => {
      this.active.delete(child);
    });
    const tracked = task.finally(() => {
      if (this.terminations.get(child) === tracked) this.terminations.delete(child);
    });
    this.terminations.set(child, tracked);
    return tracked;
  }

  private rememberReleaseFailure(message: string, cause: unknown): AudioReleaseUnconfirmedError {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const failure = new AudioReleaseUnconfirmedError(`${message}: ${detail}`, { cause });
    this.releaseFailure = failure;
    return failure;
  }
}
