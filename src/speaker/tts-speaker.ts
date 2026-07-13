import type { Speaker } from "../types";
import type { TTSProvider } from "../backends/tts/provider";
import type { AudioPlayer } from "../platform/audio";
import { AudioReleaseUnconfirmedError } from "../platform/owned-audio-player";
import { unlink } from "node:fs/promises";
import { writeSecureTempAudio } from "../platform/secure-temp-audio";
import { log } from "../logger";
import { snapshotSynthesizedWav } from "../platform/wav";

function waitUntilSettledOrStopped(work: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    work.then(finish, finish);
    if (signal.aborted) finish();
  });
}

export class TTSSpeaker implements Speaker {
  private provider: TTSProvider;
  private audioPlayer: AudioPlayer;
  protected fallback: Speaker;
  protected stopped = false;
  /**
   * Cross-output barrier: an uncertain fallback child can still own audio.
   * Lifecycle invariant: a fail-closed release latch must be retried and
   * cleared after confirmed cleanup; it must never become a restart-only wedge.
   */
  protected outputReleaseFailure: AudioReleaseUnconfirmedError | null = null;
  /** Serializes fallback calls and lets other output paths wait for release. */
  private fallbackOutputTail: Promise<void> = Promise.resolve();
  /** Coalesces cleanup retries across concurrent speak/stop entry points. */
  private outputStopTask: Promise<void> | null = null;
  private readonly stopController = new AbortController();

  constructor(provider: TTSProvider, audioPlayer: AudioPlayer, fallback: Speaker) {
    this.provider = provider;
    this.audioPlayer = audioPlayer;
    this.fallback = fallback;
  }

  async speak(text: string): Promise<void> {
    if (this.stopped) return;
    await this.retryUnconfirmedOutputRelease();
    await this.waitForFallbackOutput();
    if (this.stopped) return;
    try {
      const healthy = await this.provider.health();
      if (this.stopped) return;
      if (this.outputReleaseFailure) throw this.outputReleaseFailure;
      if (!healthy) {
        log("warn", `${this.provider.name} unavailable, falling back`);
        return this.speakFallbackOutput(text);
      }

      const sentences = this.splitSentences(text);
      if (sentences.length > 2 && text.length > 300) {
        await this.speakChunked(sentences);
      } else {
        await this.speakSingle(text);
      }
    } catch (err: unknown) {
      if (this.stopped) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof AudioReleaseUnconfirmedError) {
        this.outputReleaseFailure = err;
        log("error", `TTS playback release is unconfirmed; fallback suppressed: ${msg}`);
        throw err;
      }
      log("warn", `TTS failed, using fallback: ${msg}`);
      return this.speakFallbackOutput(text);
    }
  }

  /** Invoke the fallback once and retain fatal ownership uncertainty globally. */
  protected speakFallbackOutput(text: string): Promise<void> {
    const ready = this.fallbackOutputTail;
    const task = ready.then(async () => {
      if (this.stopped) return;
      if (this.outputReleaseFailure) throw this.outputReleaseFailure;
      await this.fallback.speak(text);
    }).catch((error: unknown) => {
      if (error instanceof AudioReleaseUnconfirmedError) {
        this.outputReleaseFailure = error;
      }
      throw error;
    });
    // The queue remains usable after ordinary fallback failure. Fatal release
    // uncertainty is retained separately and checked before any future output.
    this.fallbackOutputTail = task.catch(() => {});
    return task;
  }

  protected async waitForFallbackOutput(): Promise<void> {
    await waitUntilSettledOrStopped(this.fallbackOutputTail, this.stopController.signal);
    if (this.stopped) return;
    await this.retryUnconfirmedOutputRelease();
  }

  private async speakSingle(text: string): Promise<void> {
    const audioData = await this.generateAudio(text);
    if (this.stopped) return;
    log("info", `${this.provider.name}: ${audioData.byteLength} bytes`);
    await this.playAudio(audioData);
  }

  private async speakChunked(sentences: string[]): Promise<void> {
    log("info", `${this.provider.name}: chunked mode (${sentences.length} sentences)`);
    const firstAudio = await this.generateAudio(sentences[0]);
    if (this.stopped) return;
    const remaining = sentences.slice(1).join(" ");
    const [, restAudio] = await Promise.all([
      this.playAudio(firstAudio),
      remaining ? this.generateAudio(remaining) : Promise.resolve(null),
    ]);
    if (restAudio && !this.stopped) {
      await this.playAudio(restAudio);
    }
  }

  protected async generateAudio(text: string): Promise<ArrayBuffer> {
    try {
      const audio = await this.provider.generateAudio(text);
      return snapshotSynthesizedWav(audio, { allowEmpty: true }).audio;
    } catch (error: unknown) {
      if (error instanceof Error) throw error;
      throw new Error(`TTS provider returned invalid audio: ${String(error)}`);
    }
  }

  protected async playAudio(audioData: ArrayBuffer): Promise<void> {
    if (audioData.byteLength === 0) return;
    await this.waitForFallbackOutput();
    if (this.stopped) return;
    let tmpFile: string | undefined;
    try {
      tmpFile = await writeSecureTempAudio(audioData, { prefix: "cicero-tts" });
      await this.audioPlayer.play(tmpFile);
    } finally {
      if (tmpFile) await unlink(tmpFile).catch(() => { /* best-effort cleanup */ });
    }
  }

  private splitSentences(text: string): string[] {
    const parts = text.match(/[^.!?]+[.!?]+\s*/g);
    if (!parts || parts.length === 0) return [text];
    return parts.map(s => s.trim()).filter(s => s.length > 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (!this.stopController.signal.aborted) this.stopController.abort();
    try {
      await this.stopOutputs();
    } catch (error: unknown) {
      throw error instanceof Error
        ? error
        : new Error(`speaker output stop failed: ${String(error)}`);
    }
  }

  async health(): Promise<boolean> {
    return this.provider.health();
  }

  /** Retry the exact output owners before authorizing any new playback. */
  protected async retryUnconfirmedOutputRelease(): Promise<void> {
    if (!this.outputReleaseFailure) return;
    try {
      await this.stopOutputs();
    } catch (error: unknown) {
      throw error instanceof Error
        ? error
        : new Error(`speaker output cleanup retry failed: ${String(error)}`);
    }
  }

  private stopOutputs(): Promise<void> {
    if (this.outputStopTask) return this.outputStopTask;
    const attempt = (async () => {
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => this.audioPlayer.stopAll()),
        Promise.resolve().then(() => this.fallback.stop()),
      ]);
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "one or more speaker outputs did not stop");
      }
      this.outputReleaseFailure = null;
    })();
    const tracked = attempt.finally(() => {
      if (this.outputStopTask === tracked) this.outputStopTask = null;
    });
    this.outputStopTask = tracked;
    return tracked;
  }
}
