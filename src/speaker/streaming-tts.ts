import { TTSSpeaker } from "./tts-speaker";
import type { TTSProvider } from "../backends/tts/provider";
import { type AudioPlayer, getPlayCommand } from "../platform/audio";
import { unlink } from "node:fs/promises";
import { writeSecureTempAudio } from "../platform/secure-temp-audio";
import type { Speaker } from "../types";
import { log } from "../logger";
import { AecReleaseUnconfirmedError, type AecAudioHub, pcm16kFromWav } from "../platform/aec-hub";
import { AudioReleaseUnconfirmedError } from "../platform/owned-audio-player";
import { terminateDirectChild, type DirectChildProcess } from "../process/direct-child";

interface PreparedSentence {
  text: string;
  audio: Promise<ArrayBuffer | null>;
}

type InterruptiblePlayer = DirectChildProcess;

class AudioPlayerExitError extends Error {}
class AecPlatformFallbackBlockedError extends Error {}

type SpawnPlayer = (command: string[]) => InterruptiblePlayer;

export class StreamingTTSSpeaker extends TTSSpeaker {
  // Monotonic turn id. Each speakStream() claims a fresh epoch; interrupt() (and the
  // next speakStream) bumps it. Every playback loop captures its epoch and stops the
  // moment it goes stale. Unlike a shared `interrupted` boolean, an old turn can
  // NEVER be revived: starting a new turn bumps the epoch forward, so a barge-in's
  // new reply can't accidentally un-interrupt the one it replaced (which is what made
  // the old reply keep playing and overlap the new one — audible "kept talking").
  private epoch = 0;
  private currentPlayer: InterruptiblePlayer | null = null;
  private playing = false;
  private spoken: string[] = [];
  private inFlight: string | null = null;
  // Hub playback rate-control clock (spans the whole reply, not one sentence) so
  // we never buffer more than ~leadMs ahead in the helper — that bounds how long
  // TTS keeps playing after an interrupt, with no hard flush needed.
  private hubClockStart = 0;
  private hubWrittenMs = 0;
  // When set, TTS plays through the AEC hub (so it becomes the echo reference and
  // the mic cancels it) instead of afplay.
  private readonly hub: AecAudioHub | null;
  private readonly spawnPlayer: SpawnPlayer;
  private readonly playerReleases = new Map<InterruptiblePlayer, Promise<void>>();
  /** Exact children whose release has not yet been positively observed. */
  private readonly unreleasedPlayers = new Set<InterruptiblePlayer>();
  private playerReleaseFailure: AudioReleaseUnconfirmedError | null = null;

  constructor(
    provider: TTSProvider,
    audioPlayer: AudioPlayer,
    fallback: Speaker,
    hub: AecAudioHub | null = null,
    spawnPlayer: SpawnPlayer = (command) => Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }),
  ) {
    super(provider, audioPlayer, fallback);
    this.hub = hub;
    this.spawnPlayer = spawnPlayer;
  }

  async speakStream(sentences: AsyncIterable<string>): Promise<void> {
    if (this.stopped) return;
    await this.retryUnconfirmedOutputRelease();
    const epoch = ++this.epoch; // claim the speaker; supersedes any prior turn
    const stale = () => this.epoch !== epoch;
    // A generic fallback is not interruptible through Speaker, so a replacement
    // turn must wait for its exact output ownership to finish instead of
    // starting a raw player on top of a still-speaking system child.
    await this.waitForFallbackOutput();
    if (this.stopped || stale()) return;
    const iterator = sentences[Symbol.asyncIterator]();
    this.playing = true;
    this.spoken = [];
    this.inFlight = null;
    this.hubClockStart = 0; // lazily set on the first chunk actually played
    this.hubWrittenMs = 0;

    let sourceFinished = false;
    let sourceReadAhead: Promise<string | null> | null = null;

    try {
      const first = await this.readNextSentence(iterator);
      let current = first ? this.prepareSentence(first) : null;
      if (!current) sourceFinished = true;

      while (current && !stale()) {
        // Pull exactly one sentence ahead while the current one synthesizes.
        // This read is deliberately not awaited before playback.
        const nextText = this.readNextSentence(iterator);
        sourceReadAhead = nextText;
        // Observe early source failures now; awaiting nextPrepared below still
        // propagates them after the current sentence has finished playing.
        void nextText.catch(() => {});

        const audio = await current.audio;
        if (stale()) break;

        // Once the current render is complete, synthesize the look-ahead as soon
        // as its text arrives. This overlaps it with current playback without
        // issuing concurrent renders to providers that require serialization.
        const nextPrepared = nextText.then((text): PreparedSentence | null =>
          text && !stale() ? this.prepareSentence(text) : null
        );
        void nextPrepared.catch(() => {});

        this.inFlight = current.text;
        await this.playOrFallback(audio, current.text, epoch);
        if (stale()) break;
        this.spoken.push(current.text);
        this.inFlight = null;

        const prepared = await nextPrepared;
        sourceReadAhead = null;
        // An interrupt can land after playback's stale check but while the
        // look-ahead is still pending. nextPrepared deliberately returns null
        // for that stale turn; it does NOT mean the iterator ended naturally.
        // Preserve sourceFinished=false so finally still closes the source.
        if (stale()) break;
        current = prepared;
        if (!current) sourceFinished = true;
      }
    } catch (err: unknown) {
      if (err instanceof AudioReleaseUnconfirmedError) {
        this.outputReleaseFailure = err;
        log("error", `Streaming TTS output release is unconfirmed: ${err.message}`);
        throw err;
      }
      if (!stale()) {
        const msg = err instanceof Error ? err.message : String(err);
        log("warn", `Streaming TTS error: ${msg}`);
      }
    } finally {
      if (!sourceFinished) {
        const pendingRead = sourceReadAhead;
        const closeIterator = async () => {
          // Async generators serialize next()/return(): a generic iterator cannot
          // have return() overtake an in-flight next(). Keep audio interruption
          // immediate, then close after that read settles. Producers backed by
          // external work must also use their caller-owned AbortSignal to cancel
          // the underlying brain/process without waiting for iterator cleanup.
          // TODO: require speakStream callers to abort BrainTurnOptions.signal
          // alongside interrupt() once the cancellation stack is the base API.
          if (pendingRead) await pendingRead.catch(() => null);
          try { await iterator.return?.(); } catch { /* best-effort source cleanup */ }
        };
        if (pendingRead) void closeIterator();
        else await closeIterator();
      }
      // Only the current owner tears down shared state — a superseded turn must not
      // clobber the playing flag / player handle that the new turn now owns.
      if (!stale()) {
        this.playing = false;
        this.currentPlayer = null;
      }
    }
  }

  /**
   * Snapshot of what has been spoken vs. the sentence that was playing when
   * interrupted. `pending` holds the in-flight sentence (if any); future
   * unspoken sentences are not known because the source is a live stream.
   */
  getSnapshot(): { spoken: string[]; pending: string[] } {
    return { spoken: [...this.spoken], pending: this.inFlight ? [this.inFlight] : [] };
  }

  interrupt(): void {
    // Bump the epoch so the in-flight turn's loops go stale and exit — and stay
    // stale forever, so a follow-up turn can't accidentally revive this one.
    this.epoch++;
    const player = this.currentPlayer;
    this.currentPlayer = null;
    if (player) {
      // Begin exact-child termination synchronously, but keep interrupt() as the
      // immediate barge-in API. Replacement playback waits on this tracked
      // release below, so it cannot race the old process for the audio device.
      void this.stopInterruptiblePlayer(player).catch((error: unknown) => {
        log("error", `streaming audio-player release is unconfirmed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    // No hard flush of the hub: SIGUSR1-flushing the live Voice-Processing graph
    // killed the echo-cancelled mic. Instead playViaHub keeps the helper buffered
    // only ~250 ms ahead, so once we stop feeding it (epoch bumped) the queue
    // drains within a chunk or two and the duplex engine — and the mic — stay up.
    this.playing = false;
  }

  async stop(): Promise<void> {
    // Revoke the stream synchronously so a killed platform player cannot take
    // the normal playback-error path and restart the sentence in fallback TTS.
    this.epoch += 1;
    const player = this.currentPlayer;
    this.currentPlayer = null;
    this.playing = false;

    if (player) void this.stopInterruptiblePlayer(player).catch(() => {
      // waitForPlayerRelease below owns the shutdown diagnostic.
    });
    const outcomes = await Promise.allSettled([super.stop(), this.waitForPlayerRelease()]);
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "one or more streaming speaker outputs did not stop");
    }
  }

  isPlaying(): boolean {
    return this.playing;
  }

  private stopInterruptiblePlayer(player: InterruptiblePlayer): Promise<void> {
    const existing = this.playerReleases.get(player);
    if (existing) return existing;

    this.unreleasedPlayers.add(player);
    const task = terminateDirectChild(player).then(
      () => {
        this.unreleasedPlayers.delete(player);
        if (this.unreleasedPlayers.size === 0) this.playerReleaseFailure = null;
      },
      (error: unknown) => {
        const failure = new AudioReleaseUnconfirmedError(
          `streaming audio player ${player.pid} did not confirm release: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
        this.playerReleaseFailure = failure;
        throw failure;
      },
    );
    const tracked = task.finally(() => {
      if (this.playerReleases.get(player) === tracked) this.playerReleases.delete(player);
    });
    this.playerReleases.set(player, tracked);
    return tracked;
  }

  private async waitForPlayerRelease(): Promise<void> {
    // A previous TERM/KILL observation may have timed out just before the
    // process actually exited. Preserve the exact child and retry its reap on
    // the next playback/stop instead of turning one transient timeout into a
    // permanent speaker quarantine with no recovery path.
    const retryable = [...this.unreleasedPlayers].filter((player) => !this.playerReleases.has(player));
    if (retryable.length > 0) {
      this.playerReleaseFailure = null;
      for (const player of retryable) {
        void this.stopInterruptiblePlayer(player).catch(() => {
          // The aggregate wait below owns the diagnostic.
        });
      }
    }
    await Promise.all([...this.playerReleases.values()]);
    if (this.playerReleaseFailure) throw this.playerReleaseFailure;
  }

  private async generateAudioSafe(text: string): Promise<ArrayBuffer | null> {
    try {
      return await this.generateAudio(text);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log("warn", `TTS generation failed for "${text.substring(0, 30)}...": ${msg}`);
      return null; // signal the play site to use the fallback voice instead of going silent
    }
  }

  /** Read the next non-empty sentence without making playback wait for it. */
  private async readNextSentence(iterator: AsyncIterator<string>): Promise<string | null> {
    while (true) {
      const { value, done } = await iterator.next();
      if (done) return null;
      const text = value.trim();
      if (text) return text;
    }
  }

  private prepareSentence(text: string): PreparedSentence {
    return { text, audio: this.generateAudioSafe(text) };
  }

  /**
   * Play generated audio, or — when generation failed (null) — speak the
   * sentence with the fallback voice so the response is never silently dropped.
   * The fallback isn't interruptible, but it only runs on the error path.
   */
  private async playOrFallback(audio: ArrayBuffer | null, text: string, epoch: number): Promise<void> {
    if (audio === null) {
      await this.speakFallback(text, epoch);
      return;
    }
    try {
      await this.playAudioInterruptible(audio, epoch);
    } catch (err: unknown) {
      // A killed player is the expected barge-in path. Never restart speech in
      // the fallback voice after this turn has lost ownership.
      if (this.epoch !== epoch) return;
      // A second local player is unsafe while a failed AEC helper may still own
      // the output device. Preserve the failure so the stream stops without
      // starting either the platform player or the fallback speaker.
      if (err instanceof AecReleaseUnconfirmedError || err instanceof AudioReleaseUnconfirmedError) throw err;
      log("warn", `TTS playback failed for "${text.substring(0, 30)}...": ${err instanceof Error ? err.message : String(err)}`);
      await this.speakFallback(text, epoch);
    }
  }

  private async speakFallback(text: string, epoch: number): Promise<void> {
    // Generation failures and post-write playback failures both arrive here.
    // A platform fallback cannot share ownership with a live AEC helper (and its
    // audio would bypass the helper's echo reference). If the helper died, its
    // stopped flag precedes reap, so wait for exact release before fallback.
    if (this.hub?.isRunning()) {
      throw new AecPlatformFallbackBlockedError("platform fallback is blocked while the AEC helper is active");
    }
    if (this.hub) await this.hub.waitForRelease();
    await this.waitForPlayerRelease();
    if (this.epoch !== epoch) return;
    if (this.hub?.isRunning()) {
      throw new AecPlatformFallbackBlockedError("platform fallback is blocked because the AEC helper became active");
    }
    log("warn", `Using fallback voice for: "${text.substring(0, 30)}..."`);
    try {
      await this.speakFallbackOutput(text);
    } catch (err: unknown) {
      if (err instanceof AudioReleaseUnconfirmedError) throw err;
      log("warn", `Fallback speak failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Uses getPlayCommand + raw Bun.spawn instead of AudioPlayer.play() because
  // we need the process handle for interrupt/kill support (barge-in detection).
  // AudioPlayer.play() returns a Promise with no killable handle.
  private async playAudioInterruptible(audioData: ArrayBuffer, epoch: number): Promise<void> {
    if (audioData.byteLength === 0) return;
    await this.waitForFallbackOutput();
    if (this.epoch !== epoch) return;
    // A configured helper can fail or time out on activation. Its `running`
    // flag clears before direct-child reap completes, so platform playback is
    // safe only after the hub's explicit release barrier resolves.
    if (this.hub?.isRunning()) return this.playViaHub(audioData, epoch);
    if (this.hub) {
      await this.hub.waitForRelease();
      if (this.epoch !== epoch) return;
      if (this.hub.isRunning()) return this.playViaHub(audioData, epoch);
    }
    await this.waitForPlayerRelease();
    if (this.epoch !== epoch) return;
    let tmpFile: string | undefined;
    try {
      tmpFile = await writeSecureTempAudio(audioData, { prefix: "cicero-stream" });
      if (this.epoch !== epoch) return;
      const cmd = getPlayCommand(tmpFile);
      const player = this.spawnPlayer(cmd);
      this.currentPlayer = player;
      const exitCode = await player.exited;
      if (exitCode !== 0 && this.epoch === epoch) {
        throw new AudioPlayerExitError(`${cmd[0]} exited with ${exitCode}`);
      }
    } catch (err: unknown) {
      if (err instanceof AudioPlayerExitError || err instanceof AudioReleaseUnconfirmedError) throw err;
      throw new Error(`audio player failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    } finally {
      if (this.epoch === epoch) this.currentPlayer = null; // don't clobber a newer turn's player
      if (tmpFile) await unlink(tmpFile).catch(() => { /* best-effort cleanup */ });
    }
  }

  /**
   * Play through the AEC hub: decode+resample to 16 kHz mono and feed it in ~100 ms
   * chunks, paced near real-time. Priming a couple of chunks keeps playback smooth;
   * pacing the rest keeps the helper's queue shallow so an interrupt (epoch bump)
   * stops the voice within a chunk. The audio is also the echo reference, so the
   * mic cancels it.
   */
  private async playViaHub(audioData: ArrayBuffer, epoch: number): Promise<void> {
    const pcm = pcm16kFromWav(audioData);
    const bytesPerChunk = 3200; // 100 ms @ 16 kHz mono s16le
    const chunkMs = 100;
    const leadMs = 250; // never buffer more than this far ahead of real-time
    // Start the clock on the first chunk that actually plays (not at speakStream
    // start), so LLM/TTS generation latency before first-audio doesn't make the
    // first sentence dump into the queue unpaced.
    if (this.hubClockStart === 0) this.hubClockStart = Date.now();
    for (let off = 0; off < pcm.length; off += bytesPerChunk) {
      if (this.epoch !== epoch) break;
      await this.hub!.play(pcm.subarray(off, Math.min(off + bytesPerChunk, pcm.length)));
      // A replacement turn can claim the speaker while this write is waiting on
      // hub backpressure. The old turn must not mutate the replacement's shared
      // pacing clock after it loses ownership.
      if (this.epoch !== epoch) break;
      this.hubWrittenMs += chunkMs;
      // Rate-limit against a clock that spans the whole reply: sleep only when
      // we've gotten more than leadMs ahead of where playback actually is. This
      // bounds the helper's queue (fast interrupt) while the leadMs head-start
      // absorbs generation jitter so playback doesn't underrun.
      const ahead = this.hubWrittenMs - (Date.now() - this.hubClockStart);
      if (ahead > leadMs) await Bun.sleep(ahead - leadMs);
    }
  }
}
