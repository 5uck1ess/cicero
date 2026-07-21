import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { log } from "../../logger";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../../platform/secure-storage";
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
 * Hot path vs. background (the turn must never wait on the tap dir):
 * - The source WAV is read in the hot path because the caller may reclaim that
 *   temp file the instant transcription returns; the read is local, bounded by
 *   maxAudioBytes, and fast. Everything that touches the operator-supplied tap
 *   directory — which may live on a slow or wedged mount (NFS) — happens in a
 *   background write. The hot path waits on that write only up to a deadline,
 *   then proceeds; a genuinely stalled dir can never wedge the turn.
 * - At most one background write is in flight (a single slot): if a write is
 *   still draining when the next utterance arrives, that utterance is dropped
 *   with a one-shot warning rather than queued without bound. So a hung mount
 *   strands at most one write (one buffer), not one per turn.
 *
 * Bounds and privacy (untrusted input + private storage discipline):
 * - Captures are voice recordings, so files are created 0600 via an exclusive
 *   open + fd chmod; a pre-existing file or symlink at a destination is never
 *   followed or overwritten.
 * - The tap directory is created 0700 when the tap creates it, but a
 *   pre-existing operator directory is NEVER re-permissioned: CICERO_STT_TAP
 *   may point at a shared location (e.g. /tmp) and silently chmodding it to
 *   0700 would be a destabilizing side effect. A loose pre-existing dir is
 *   warned about (captures still land 0600) rather than tightened; a symlinked
 *   dir is refused.
 * - The source is stat'd and read through one file descriptor, and only the
 *   validated size is read, so a source swapped or grown after the size check
 *   cannot substitute or exceed the checked bytes (no lstat→open TOCTOU gap).
 * - The provider-supplied transcript is length-bounded before serialization;
 *   oversized audio is skipped entirely.
 * - A stem collision (shared dir, clock rollback, concurrent writers) retries
 *   under a fresh name instead of silently dropping the capture; both names are
 *   reserved before either is filled. Cleanup unlinks (on a failed fill, and in
 *   prune) are best-effort, so a crash mid-fill or a failed unlink can transiently
 *   leave an empty or half pair — reclaimed on a later prune, never mistaken for
 *   a real capture (both files carry the tap's naming pattern).
 * - At most one capture is read or written at a time (a synchronous in-flight
 *   slot); a second utterance arriving mid-capture is dropped, so overlapping
 *   turns can't each buffer a full clip.
 * - Pruning keeps a fixed utterance budget, runs on the first capture of each
 *   process (so restarts that each write few clips still bound total growth)
 *   and every N thereafter, and only ever touches files matching the tap's own
 *   naming pattern.
 * - A capture failure warns once and never fails the transcription; it adds only
 *   a bounded delay (a local source read, then at most the write deadline before
 *   the tap-dir write is backgrounded), and is retried on the next utterance
 *   rather than latched for the daemon's life.
 */
const MAX_RETAINED_UTTERANCES = 1000; // wav+json pairs
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 8192; // a spoken utterance is tiny; this only bounds a hostile provider
const PRUNE_EVERY = 25;
const MAX_STEM_ATTEMPTS = 64; // retry ceiling for filename collisions
const WRITE_DEADLINE_MS = 2000; // longest the turn will wait on the tap-dir write before proceeding

/** Matches only files this tap wrote: an ISO-ish stamp plus a 3-digit counter. */
const TAP_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2}T[0-9-]+Z-\d{3})\.(wav|json)$/;

/** One utterance, fully read from the source and ready to persist off the hot path. */
interface Capture {
  bytes: Buffer;
  now: Date;
  sidecar: object;
}

interface TapLimits {
  maxRetainedUtterances?: number;
  maxAudioBytes?: number;
  maxTranscriptChars?: number;
  pruneEvery?: number;
  /** Longest the transcribe path will wait on a background tap write (ms). */
  writeDeadlineMs?: number;
  /**
   * Test seam: awaited inside the background write, after the directory is
   * ensured but before any capture file is created. Tests use it to hold a
   * write open and exercise the stall path (deadline release + single-slot
   * drop). Unset in production.
   */
  writeGate?: () => Promise<void>;
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

/**
 * Ensure the tap directory exists and is safe to write private captures into,
 * WITHOUT ever re-permissioning a directory the tap did not create. Returns the
 * (octal) mode of a pre-existing directory that is group/other-accessible so
 * the caller can warn; a directory the tap creates is made 0700. A symlink is
 * refused rather than followed (captures and prunes happen beneath this path).
 */
async function ensureTapDirectory(dir: string): Promise<{ looseMode?: number }> {
  // Async (not *Sync): this runs inside the background persist, whose deadline
  // race only arms once persist() yields. A synchronous mkdir on a wedged mount
  // would block the event loop BEFORE the race is set up and freeze the turn.
  const firstCreated = await mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`refusing unsafe stt tap directory '${dir}'`);
  }
  const created = firstCreated !== undefined; // recursive mkdir returns undefined when the leaf existed
  if (!created && process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    return { looseMode: info.mode & 0o777 };
  }
  return {};
}

class SttTap {
  private announced = false;
  private captured = 0; // successful captures this process — drives prune cadence
  private counter = 0; // stem disambiguator within a millisecond
  private warned = false;
  /**
   * True while a capture is being read OR written. A single synchronous slot:
   * reserved at the top of record() before the first await (so overlapping
   * record() calls can't each read a full clip into memory), and released only
   * when the background write settles (so at most one write is ever stranded).
   */
  private inFlight = false;
  private readonly maxRetained: number;
  private readonly maxAudioBytes: number;
  private readonly maxTranscriptChars: number;
  private readonly pruneEvery: number;
  private readonly writeDeadlineMs: number;
  private readonly writeGate?: () => Promise<void>;
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
    this.writeDeadlineMs = limits?.writeDeadlineMs ?? WRITE_DEADLINE_MS;
    this.writeGate = limits?.writeGate;
    this.clock = limits?.clock ?? (() => new Date());
  }

  /**
   * Read the utterance off the source, then persist it in the background.
   * Never throws into the STT path and never blocks it past the write deadline.
   */
  async record(audioFile: string, transcript: string, elapsedMs: number): Promise<void> {
    // Reserve the slot synchronously, before any await: if a prior capture is
    // still reading or (slowly) writing, drop this one without paying to read
    // its audio into memory. Doing this before the first await also makes it
    // safe against overlapping record() calls (barge-in) — the second sees the
    // reservation and drops rather than both buffering a full clip.
    if (this.inFlight) {
      this.warnOnce("stt tap: previous capture still in flight (slow tap directory?) — dropping this utterance");
      return;
    }
    this.inFlight = true;
    let capture: Capture | undefined;
    try {
      capture = await this.readSource(audioFile, transcript, elapsedMs);
    } catch (error: unknown) {
      this.inFlight = false;
      this.warnOnce(`stt tap: capture failed (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    if (!capture) {
      this.inFlight = false;
      return;
    }
    await this.persistBounded(capture); // clears the slot when the background write settles
  }

  /**
   * Read the source WAV through a single fd (open → stat → read), on the hot
   * path because the caller may delete the temp file the moment transcription
   * returns. Only the validated size is read, so a source grown in place after
   * the size check cannot exceed the cap. Returns undefined when the source is
   * not a regular file or is over the size limit.
   */
  private async readSource(audioFile: string, transcript: string, elapsedMs: number): Promise<Capture | undefined> {
    let source: Awaited<ReturnType<typeof open>> | undefined;
    try {
      source = await open(audioFile, "r");
      const stat = await source.stat();
      if (!stat.isFile() || stat.size > this.maxAudioBytes) return undefined;

      const now = this.clock();
      // Read up to the validated size, looping because one read() is not
      // guaranteed to fill the buffer; stop early if the source shrank (EOF).
      const buffer = Buffer.allocUnsafe(stat.size);
      let filled = 0;
      while (filled < stat.size) {
        const { bytesRead } = await source.read(buffer, filled, stat.size - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      const bytes = filled === stat.size ? buffer : buffer.subarray(0, filled);

      const cappedTranscript =
        transcript.length > this.maxTranscriptChars ? transcript.slice(0, this.maxTranscriptChars) : transcript;
      return {
        bytes,
        now,
        sidecar: {
          engine: this.engine,
          transcript: cappedTranscript,
          stt_ms: elapsedMs,
          audio_bytes: bytes.length,
          at: now.toISOString(),
        },
      };
    } finally {
      await source?.close().catch(() => {});
    }
  }

  /**
   * Persist a capture on the single background slot, waiting only up to the
   * write deadline. A stalled tap dir therefore delays the turn by at most that
   * deadline once, then the write is abandoned in the background (single slot)
   * and every later utterance is dropped until it settles — the turn never
   * wedges and at most one write is ever stranded.
   *
   * The deadline does not cancel the underlying fs op (fs/promises has no
   * cancellation), so a permanently wedged mount holds the slot — and one
   * capture buffer — until it settles. This is self-recovering: if the mount
   * comes back the write finishes and the slot frees with no restart. Only a
   * mount that never recovers leaves capture disabled, and then capture is
   * impossible anyway. Fail-closed and bounded to a single stranded write.
   */
  private async persistBounded(capture: Capture): Promise<void> {
    // The slot (inFlight) was reserved by record(); this releases it once the
    // background write settles, whether or not the bounded wait below returns
    // first. A wedged write keeps the slot until it eventually settles.
    const task = this.persist(capture)
      .catch((error: unknown) =>
        this.warnOnce(`stt tap: capture failed (${error instanceof Error ? error.message : String(error)})`),
      )
      .finally(() => {
        this.inFlight = false;
      });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((res) => {
      timer = setTimeout(res, this.writeDeadlineMs);
    });
    try {
      await Promise.race([task, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Ensure the dir, write the pair, and prune. Runs off the hot path. */
  private async persist(capture: Capture): Promise<void> {
    // Re-checked every capture: a transient failure (unmounted disk, permission
    // hiccup) must not latch capture off for the daemon's life.
    const dirState = await ensureTapDirectory(this.dir);
    if (dirState.looseMode !== undefined) {
      this.warnOnce(
        `stt tap: capture directory ${this.dir} is accessible to other users (mode ${dirState.looseMode.toString(8)}); leaving its permissions unchanged — capture files are still written 0600`,
      );
    }
    if (!this.announced) {
      this.announced = true;
      log("info", `stt tap: recording utterances to ${this.dir} (engine '${this.engine}')`);
    }

    if (this.writeGate) await this.writeGate();
    const written = await this.writePair(capture);
    if (!written) return;

    this.captured++;
    if (this.captured === 1 || this.captured % this.pruneEvery === 0) await this.prune();
  }

  /**
   * Create the wav+json pair under one stem. Both names are reserved by
   * exclusive open before either is filled: a taken .wav OR .json retries a
   * fresh stem, and a name already present (a pre-existing file the tap does
   * not own) is never opened for write, followed, or deleted. On a fill failure
   * both files this call created are removed (best-effort), so a lasting
   * half-pair is unusual — but the removal can itself fail or be interrupted, in
   * which case the stray is reclaimed by a later prune. Returns false if no free
   * stem was found within the retry budget.
   */
  private async writePair(capture: Capture): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_STEM_ATTEMPTS; attempt++) {
      const stem = this.nextStem(capture.now);
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
        await wav.writeFile(capture.bytes);
        await json.writeFile(JSON.stringify(capture.sidecar));
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
   * Keep the newest ~N utterances. Only files matching the tap's own naming
   * pattern are candidates — a shared directory's other contents are never
   * touched — and an utterance's wav+json pair is removed together. Best-effort:
   * an unlink that fails is skipped (retried on the next prune), so the retained
   * count is an approximate bound, not a hard one, under filesystem errors.
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
