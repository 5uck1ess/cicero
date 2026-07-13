import {
  terminateDirectChild,
  type DirectChildProcess,
} from "../process/direct-child";

export type AudioPlayerProcess = DirectChildProcess;
export type SpawnAudioPlayer = (command: string[]) => AudioPlayerProcess;
export type ResolveAudioPlayerCommand = (
  filePath: string,
) => string[] | Promise<string[]>;

/**
 * The player could not prove that an owned native child exited. Starting a
 * fallback voice while the old process may still own the audio device is
 * unsafe, so callers must treat this differently from an ordinary nonzero
 * player exit.
 */
export class AudioReleaseUnconfirmedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AudioReleaseUnconfirmedError";
  }
}

/**
 * Tracks exact native audio children and never relies on process-name kills.
 * A stop invalidates command resolution that began before it, terminates every
 * child that this instance spawned, and confirms reap before it resolves.
 */
export class OwnedAudioPlayer {
  private epoch = 0;
  private readonly active = new Set<AudioPlayerProcess>();
  private readonly stopRequested = new WeakSet<AudioPlayerProcess>();
  private readonly terminations = new Map<AudioPlayerProcess, Promise<void>>();
  private stopTask: Promise<void> | null = null;
  private releaseFailure: AudioReleaseUnconfirmedError | null = null;

  constructor(
    private readonly resolveCommand: ResolveAudioPlayerCommand,
    private readonly spawnPlayer: SpawnAudioPlayer = (command) => Bun.spawn(command, {
      stdout: "ignore",
      stderr: "ignore",
    }),
  ) {}

  async play(filePath: string): Promise<void> {
    const stopping = this.stopTask;
    if (stopping) {
      try {
        await stopping;
      } catch (error: unknown) {
        throw this.releaseError("prior audio-player stop failed", error);
      }
    }
    if (this.releaseFailure) throw this.releaseFailure;

    const epoch = this.epoch;
    let command: string[];
    try {
      command = await this.resolveCommand(filePath);
    } catch (error: unknown) {
      throw new Error(
        `audio player command resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    // stopAll() may have completed while an asynchronous binary resolver was
    // pending. That pre-stop request has lost admission and must not spawn.
    if (epoch !== this.epoch) return;
    if (command.length === 0 || command.some((argument) => typeof argument !== "string")) {
      throw new Error("audio player command resolver returned an invalid command");
    }

    let player: AudioPlayerProcess;
    try {
      player = this.spawnPlayer(command);
    } catch (error: unknown) {
      throw new Error(
        `could not start audio player '${command[0]}': ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    this.active.add(player);

    let exitObserved = false;
    try {
      const exitCode = await player.exited;
      exitObserved = true;
      if (exitCode !== 0 && !this.stopRequested.has(player)) {
        throw new Error(`audio player '${command[0]}' exited with ${exitCode}`);
      }
    } catch (error: unknown) {
      // An intentional stop owns diagnostics and reaping. Suppress its nonzero
      // exit here so TTSSpeaker cannot restart the same text in fallback TTS.
      if (this.stopRequested.has(player)) return;
      if (exitObserved) throw error;
      const failure = this.releaseError(
        `audio player '${command[0]}' exit observation failed`,
        error,
      );
      this.releaseFailure = failure;
      throw failure;
    } finally {
      if (exitObserved) this.active.delete(player);
    }
  }

  stopAll(): Promise<void> {
    this.epoch += 1;
    if (this.stopTask) return this.stopTask;

    const players = [...this.active];
    if (players.length === 0) {
      this.releaseFailure = null;
      return Promise.resolve();
    }
    for (const player of players) this.stopRequested.add(player);

    const task = this.stopOwnedPlayers(players);
    const tracked = task.finally(() => {
      if (this.stopTask === tracked) this.stopTask = null;
    });
    this.stopTask = tracked;
    return tracked;
  }

  private async stopOwnedPlayers(players: AudioPlayerProcess[]): Promise<void> {
    const outcomes = await Promise.allSettled(
      players.map((player) => this.terminate(player)),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : []
    );
    if (failures.length > 0) {
      const aggregate = new AggregateError(failures, "one or more audio players did not stop");
      const failure = this.releaseError("audio-player release is unconfirmed", aggregate);
      this.releaseFailure = failure;
      throw failure;
    }
    if (this.active.size === 0) this.releaseFailure = null;
  }

  private terminate(player: AudioPlayerProcess): Promise<void> {
    const existing = this.terminations.get(player);
    if (existing) return existing;
    const task = terminateDirectChild(player).then(() => {
      this.active.delete(player);
    });
    const tracked = task.finally(() => {
      if (this.terminations.get(player) === tracked) this.terminations.delete(player);
    });
    this.terminations.set(player, tracked);
    return tracked;
  }

  private releaseError(message: string, cause: unknown): AudioReleaseUnconfirmedError {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new AudioReleaseUnconfirmedError(`${message}: ${detail}`, { cause });
  }
}
