import { open, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { log } from "../../logger";
import { ensurePrivateDirectorySync, PRIVATE_FILE_MODE } from "../../platform/secure-storage";
import type { STTProvider, STTTranscriptionResult } from "./provider";

/**
 * Opt-in STT audio tap (`CICERO_STT_TAP=<dir>`): tees every transcribed
 * utterance — the exact WAV the provider saw plus a JSON sidecar with the
 * engine name, transcript, and timing — into a local directory.
 *
 * Why: comparing STT backends on synthetic clips misses how they hear *your*
 * voice through *your* mic. The tap turns normal daily use into a benchmark
 * corpus (see bench/stt/README.md) and captures evidence for tail-clipping /
 * misheard-word reports that are unreproducible after the fact.
 *
 * Bounds and privacy (untrusted input + private storage discipline):
 * - Captures are voice recordings, so the directory is 0700 and every file is
 *   created 0600 via an exclusive open + fd chmod; a pre-existing file or
 *   symlink at a destination never gets followed or overwritten.
 * - The WAV is copied from a single file descriptor that is stat'd and read
 *   through the same open handle, so a source swapped after the size/type
 *   check cannot substitute different bytes (no lstat→open TOCTOU gap).
 * - The provider-supplied transcript is length-bounded before serialization;
 *   oversized audio is skipped entirely.
 * - A stem collision (shared dir, clock rollback, concurrent writers) retries
 *   under a fresh name instead of silently dropping the capture; the wav+json
 *   pair is created and pruned atomically, so a partial failure never leaves a
 *   half-pair behind.
 * - Pruning keeps a fixed utterance budget, runs on the first capture of each
 *   process (so restarts that each write few clips still bound total growth)
 *   and every N thereafter, and only ever touches files matching the tap's own
 *   naming pattern.
 * - A capture failure warns once, never fails or delays the transcription, and
 *   is retried on the next utterance rather than latched for the daemon's life.
 */
const MAX_RETAINED_UTTERANCES = 1000; // wav+json pairs
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 8192; // a spoken utterance is tiny; this only bounds a hostile provider
const PRUNE_EVERY = 25;
const MAX_STEM_ATTEMPTS = 64; // retry ceiling for filename collisions

/** Matches only files this tap wrote: an ISO-ish stamp plus a 3-digit counter. */
const TAP_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2}T[0-9-]+Z-\d{3})\.(wav|json)$/;

interface TapLimits {
  maxRetainedUtterances?: number;
  maxAudioBytes?: number;
  maxTranscriptChars?: number;
  pruneEvery?: number;
  /** Injectable clock (tests pin it to target exact destination filenames). */
  clock?: () => Date;
}

export function wrapSTTWithTap(provider: STTProvider, dir: string, limits?: TapLimits): STTProvider {
  const tap = new SttTap(resolve(dir), provider.name, limits);
  const wrapped: STTProvider = {
    name: provider.name,
    transcribe: async (audioFile: string) => {
      const started = Date.now();
      const text = await provider.transcribe(audioFile);
      await tap.record(audioFile, text ?? "", Date.now() - started);
      return text;
    },
    health: () => provider.health(),
  };
  if (provider.transcribeResult) {
    wrapped.transcribeResult = async (audioFile: string): Promise<STTTranscriptionResult> => {
      const started = Date.now();
      const result = await provider.transcribeResult!(audioFile);
      const text = result.kind === "transcript" ? result.text : `<${result.kind}>`;
      await tap.record(audioFile, text, Date.now() - started);
      return result;
    };
  }
  if (provider.requiredHealth) wrapped.requiredHealth = () => provider.requiredHealth!();
  if (provider.start) wrapped.start = () => provider.start!();
  if (provider.stop) wrapped.stop = () => provider.stop!();
  if (provider.warmup) wrapped.warmup = () => provider.warmup!();
  return wrapped;
}

class SttTap {
  private announced = false;
  private captured = 0; // successful captures this process — drives prune cadence
  private counter = 0; // stem disambiguator within a millisecond
  private warned = false;
  private readonly maxRetained: number;
  private readonly maxAudioBytes: number;
  private readonly maxTranscriptChars: number;
  private readonly pruneEvery: number;
  private readonly clock: () => Date;

  constructor(
    private readonly dir: string,
    private readonly engine: string,
    limits?: TapLimits,
  ) {
    this.maxRetained = limits?.maxRetainedUtterances ?? MAX_RETAINED_UTTERANCES;
    this.maxAudioBytes = limits?.maxAudioBytes ?? MAX_AUDIO_BYTES;
    this.maxTranscriptChars = limits?.maxTranscriptChars ?? MAX_TRANSCRIPT_CHARS;
    this.pruneEvery = limits?.pruneEvery ?? PRUNE_EVERY;
    this.clock = limits?.clock ?? (() => new Date());
  }

  /** Copy the utterance + write its sidecar; never throws into the STT path. */
  async record(audioFile: string, transcript: string, elapsedMs: number): Promise<void> {
    let source: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // Re-checked every utterance: a transient failure (unmounted disk,
      // permission hiccup) must not latch capture off for the daemon's life.
      ensurePrivateDirectorySync(this.dir);
      if (!this.announced) {
        this.announced = true;
        log("info", `stt tap: recording utterances to ${this.dir} (engine '${this.engine}')`);
      }

      // Open once, then stat and copy through the same fd so a source replaced
      // after the checks cannot swap in different (or larger) bytes.
      source = await open(audioFile, "r");
      const stat = await source.stat();
      if (!stat.isFile() || stat.size > this.maxAudioBytes) return;

      const now = this.clock();
      const cappedTranscript =
        transcript.length > this.maxTranscriptChars ? transcript.slice(0, this.maxTranscriptChars) : transcript;

      const written = await this.writePair(source, stat.size, now, {
        engine: this.engine,
        transcript: cappedTranscript,
        stt_ms: elapsedMs,
        audio_bytes: stat.size,
        at: now.toISOString(),
      });
      if (!written) return;

      this.captured++;
      if (this.captured === 1 || this.captured % this.pruneEvery === 0) await this.prune();
    } catch (error: unknown) {
      this.warnOnce(`stt tap: capture failed (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      await source?.close().catch(() => {});
    }
  }

  /**
   * Create the wav+json pair atomically. Both names are reserved by exclusive
   * open under one stem before either is filled: a taken .wav OR .json retries
   * a fresh stem, and a name already present (a pre-existing file the tap does
   * not own) is never opened for write, followed, or deleted — only files this
   * call created are cleaned up on failure. Returns false if no free stem was
   * found within the retry budget.
   */
  private async writePair(
    source: Awaited<ReturnType<typeof open>>,
    expectedBytes: number,
    now: Date,
    sidecar: object,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_STEM_ATTEMPTS; attempt++) {
      const stem = this.nextStem(now);
      const wavPath = join(this.dir, `${stem}.wav`);
      const jsonPath = join(this.dir, `${stem}.json`);

      // Reserve the WAV name exclusively; a taken name (file or symlink) retries.
      let wav: Awaited<ReturnType<typeof open>>;
      try {
        wav = await open(wavPath, "wx", PRIVATE_FILE_MODE);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }

      // Reserve the JSON name too. If it is taken, release only the WAV this
      // call just created (never the pre-existing JSON) and retry a fresh stem.
      let json: Awaited<ReturnType<typeof open>>;
      try {
        json = await open(jsonPath, "wx", PRIVATE_FILE_MODE);
      } catch (error: unknown) {
        await wav.close().catch(() => {});
        await unlink(wavPath).catch(() => {});
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }

      // Both names are reserved and owned by this call. Fill them; on any
      // failure remove both (ours) so a half-pair never survives.
      try {
        await wav.chmod(PRIVATE_FILE_MODE); // exact 0600 regardless of umask, via the fd
        await json.chmod(PRIVATE_FILE_MODE);
        // Read at most the validated size from the already-stat'd fd, so a
        // source that grows in place after the size check cannot exceed the cap.
        const buffer = Buffer.allocUnsafe(expectedBytes);
        const { bytesRead } = await source.read(buffer, 0, expectedBytes, 0);
        await wav.writeFile(bytesRead === expectedBytes ? buffer : buffer.subarray(0, bytesRead));
        await json.writeFile(JSON.stringify(sidecar));
        return true;
      } catch (error: unknown) {
        await unlink(wavPath).catch(() => {});
        await unlink(jsonPath).catch(() => {});
        throw error;
      } finally {
        await wav.close().catch(() => {});
        await json.close().catch(() => {});
      }
    }
    this.warnOnce("stt tap: could not allocate a free capture filename — skipping");
    return false;
  }

  private nextStem(now: Date): string {
    return `${now.toISOString().replace(/[:.]/g, "-")}-${(this.counter++ % 1000).toString().padStart(3, "0")}`;
  }

  /**
   * Keep the newest N utterances. Only files matching the tap's own naming
   * pattern are candidates — a shared directory's other contents are never
   * touched — and an utterance's wav+json pair is always removed together.
   */
  private async prune(): Promise<void> {
    const byStem = new Map<string, string[]>();
    for (const name of await readdir(this.dir)) {
      const match = TAP_FILE_PATTERN.exec(name);
      if (!match) continue;
      const files = byStem.get(match[1]!) ?? [];
      files.push(name);
      byStem.set(match[1]!, files);
    }
    const ordered = [...byStem.keys()].sort();
    const excess = ordered.length - this.maxRetained;
    for (const stem of ordered.slice(0, Math.max(0, excess))) {
      for (const name of byStem.get(stem) ?? []) {
        await unlink(join(this.dir, name)).catch(() => {});
      }
    }
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    log("warn", message);
  }
}
