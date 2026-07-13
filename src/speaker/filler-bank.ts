import type { TTSProvider } from "../backends/tts/provider";
import { FILLER_LINES, classifyFillerBucket, type FillerBucket } from "./thinking-filler";
import { log } from "../logger";
import {
  MAX_DECODED_WAV_DURATION_MS,
  MAX_SYNTHESIZED_WAV_BYTES,
  snapshotSynthesizedWav,
} from "../platform/wav";

export interface PreparedFiller {
  text: string;
  audio: ArrayBuffer;
}

export interface FillerBankLimits {
  maxClips: number;
  maxBytes: number;
  maxFrames: number;
  maxDurationMs: number;
}

/**
 * One front-desk bank plus every lane-voice bank shares this retention budget.
 * The defaults leave ample room for the built-in 20 clips and several lane
 * voices while preventing a provider/configuration mistake from pinning GiBs.
 */
export const DEFAULT_FILLER_BANK_LIMITS: Readonly<FillerBankLimits> = Object.freeze({
  maxClips: 128,
  maxBytes: 16 * 1024 * 1024,
  maxFrames: 96_000 * 3 * 60,
  maxDurationMs: 3 * 60 * 1_000,
});

interface FillerUsage {
  clips: number;
  bytes: number;
  frames: number;
  durationMs: number;
}

interface PreparedBank {
  clips: Map<FillerBucket, PreparedFiller[]>;
  usage: FillerUsage;
}

const EMPTY_USAGE: Readonly<FillerUsage> = Object.freeze({
  clips: 0,
  bytes: 0,
  frames: 0,
  durationMs: 0,
});

/**
 * Pre-renders the thinking-filler phrases to audio ONCE (at startup) so a turn
 * can play an instant "let me think…" with zero synthesis latency to cover the
 * brain's time-to-first-token.
 *
 * The host path TTS-es its filler text on every turn (cheap with kokoro, but not
 * free and re-synthesized each time); the web path had no filler at all. This
 * bank fixes both: synthesize each phrase once, then hand back the cached WAV
 * instantly. Priming is best-effort — a phrase that fails to synthesize is just
 * skipped, and `pick()` returns undefined until at least one phrase is ready, so
 * a turn degrades to "no filler" rather than erroring.
 */
export class FillerBank {
  private prepared = new Map<FillerBucket, PreparedFiller[]>();
  private preparedUsage: FillerUsage = { ...EMPTY_USAGE };
  /** Lane-voice clips (voice name → bucket → clips) so a pinned employee can
   * say "let me check" in THEIR voice instead of getting silence. */
  private perVoice = new Map<string, Map<FillerBucket, PreparedFiller[]>>();
  private perVoiceUsage = new Map<string, FillerUsage>();
  private last?: string;
  private readonly lines: Record<FillerBucket, readonly string[]>;
  private readonly limits: FillerBankLimits;
  /** Replacement accounting must observe one coherent bank snapshot. */
  private priming: Promise<void> = Promise.resolve();

  constructor(
    private readonly tts: Pick<TTSProvider, "generateAudio">,
    lines?: Partial<Record<FillerBucket, readonly string[]>>,
    limits?: Partial<FillerBankLimits>,
  ) {
    // Config overrides merge per bucket, so users can reword one category
    // (e.g. persona-flavored acknowledgments) without redefining the rest.
    this.lines = { ...FILLER_LINES, ...(lines ?? {}) };
    this.limits = { ...DEFAULT_FILLER_BANK_LIMITS, ...(limits ?? {}) };
    assertFillerLimits(this.limits);
  }

  /** Synthesize every phrase once. Returns how many are ready. Safe to await or fire-and-forget. */
  prime(): Promise<number> {
    return this.enqueuePrime(async () => {
      // The candidate atomically replaces the old front-desk bank. Excluding
      // the replaced usage prevents repeated prime() calls from consuming the
      // budget cumulatively, while every per-voice bank remains in the base.
      const base = sumUsages(this.perVoiceUsage.values());
      const candidate = await this.prepareBank(base);
      this.prepared = candidate.clips;
      this.preparedUsage = candidate.usage;
      return candidate.usage.clips;
    });
  }

  /**
   * Synthesize a small subset (the first `perBucket` lines of each bucket) in a
   * specific lane voice. Deliberately smaller than the front desk's bank — 8
   * lanes × full bank would stretch startup and hammer the TTS seat. Serialized
   * by the caller for the same SIGABRT reason the warmup chain exists.
   */
  primeVoice(voice: string, perBucket = 2): Promise<number> {
    return this.enqueuePrime(async () => {
      if (!Number.isSafeInteger(perBucket) || perBucket < 0) {
        throw new RangeError("filler lines per bucket must be a non-negative integer");
      }
      // Replacing a voice deducts only that voice. Front-desk clips and every
      // other voice remain part of the transaction's fixed base usage.
      const otherVoices = [...this.perVoiceUsage.entries()]
        .filter(([name]) => name !== voice)
        .map(([, usage]) => usage);
      const base = addUsage(this.preparedUsage, sumUsages(otherVoices));
      const candidate = await this.prepareBank(base, voice, perBucket);
      if (candidate.usage.clips === 0) {
        // Do not let repeated over-budget/failed voice primes retain an
        // unbounded collection of empty voice keys.
        this.perVoice.delete(voice);
        this.perVoiceUsage.delete(voice);
      } else {
        this.perVoice.set(voice, candidate.clips);
        this.perVoiceUsage.set(voice, candidate.usage);
      }
      return candidate.usage.clips;
    });
  }

  private enqueuePrime<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.priming.then(operation);
    // Keep later replacements moving after an individual caller observes a
    // failure; this branch handles the queue state without hiding run's error.
    this.priming = run.then(() => undefined, () => undefined);
    return run;
  }

  private async prepareBank(
    base: FillerUsage,
    voice?: string,
    perBucket?: number,
  ): Promise<PreparedBank> {
    const clips = new Map<FillerBucket, PreparedFiller[]>();
    const buckets = Object.keys(this.lines) as FillerBucket[];
    for (const bucket of buckets) clips.set(bucket, []);
    let usage: FillerUsage = { ...EMPTY_USAGE };

    bucketLoop: for (const bucket of buckets) {
      const lines = perBucket === undefined
        ? this.lines[bucket]
        : this.lines[bucket].slice(0, perBucket);
      for (const text of lines) {
        if (base.clips + usage.clips >= this.limits.maxClips) {
          log("info", `filler prime reached the ${this.limits.maxClips}-clip bank limit`);
          break bucketLoop;
        }
        try {
          const audio = await this.tts.generateAudio(text, voice);
          if (audio.byteLength === 0) continue;
          const snapshot = snapshotSynthesizedWav(audio, { maxBytes: this.limits.maxBytes });
          const metadata = snapshot.metadata;
          if (!metadata) continue;
          const next = addUsage(base, usage, {
            clips: 1,
            bytes: snapshot.audio.byteLength,
            frames: metadata.frameCount,
            durationMs: metadata.durationMs,
          });
          const exceeded = exceededLimit(next, this.limits);
          if (exceeded) {
            log("info", `filler prime skipped "${text}": aggregate ${exceeded} limit reached`);
            continue;
          }
          clips.get(bucket)!.push({ text, audio: snapshot.audio });
          usage = addUsage(usage, {
            clips: 1,
            bytes: snapshot.audio.byteLength,
            frames: metadata.frameCount,
            durationMs: metadata.durationMs,
          });
        } catch (err: unknown) {
          const owner = voice ? ` (${voice})` : "";
          log("info", `filler prime skipped${owner} "${text}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return { clips, usage };
  }

  /** True once at least one phrase has been primed. */
  get ready(): boolean {
    return [...this.prepared.values()].some((b) => b.length > 0);
  }

  /**
   * Pick a prepared filler that FITS the utterance — a command hears "On it.",
   * a status ask hears "Let me check.", a question hears "Hmm, good question."
   * Varied so the same line never plays twice in a row. Returns undefined if
   * nothing is primed yet — callers treat that as "no filler this turn".
   *
   * With `voice`, only that lane voice's clips are considered — a filler in the
   * WRONG voice is worse than a beat of silence, so there is no fallback to the
   * front desk's clips.
   */
  pick(transcript?: string, voice?: string): PreparedFiller | undefined {
    const kind = classifyFillerBucket(transcript);
    if (kind === "none") return undefined; // bare ack — silence beats "One moment."
    const source = voice ? this.perVoice.get(voice) : this.prepared;
    if (!source) return undefined;
    const bucket = source.get(kind) ?? [];
    const candidates = bucket.length > 0 ? bucket : [...source.values()].flat();
    if (candidates.length === 0) return undefined;
    const pool = this.last ? candidates.filter((f) => f.text !== this.last) : candidates;
    const choices = pool.length > 0 ? pool : candidates;
    const chosen = choices[Math.floor(Math.random() * choices.length)]!;
    this.last = chosen.text;
    // Callers play/mutate independently; never expose the buffer whose exact
    // byte/frame usage backs the bank-wide accounting invariant.
    return { text: chosen.text, audio: copyFixedBuffer(chosen.audio) };
  }
}

function copyFixedBuffer(input: ArrayBuffer): ArrayBuffer {
  const output = new ArrayBuffer(input.byteLength);
  new Uint8Array(output).set(new Uint8Array(input));
  return output;
}

function addUsage(...parts: FillerUsage[]): FillerUsage {
  return parts.reduce<FillerUsage>((total, part) => ({
    clips: total.clips + part.clips,
    bytes: total.bytes + part.bytes,
    frames: total.frames + part.frames,
    durationMs: total.durationMs + part.durationMs,
  }), { ...EMPTY_USAGE });
}

function sumUsages(parts: Iterable<FillerUsage>): FillerUsage {
  let total: FillerUsage = { ...EMPTY_USAGE };
  for (const part of parts) total = addUsage(total, part);
  return total;
}

function exceededLimit(usage: FillerUsage, limits: FillerBankLimits): string | null {
  if (usage.clips > limits.maxClips) return "clip-count";
  if (usage.bytes > limits.maxBytes) return "encoded-byte";
  if (usage.frames > limits.maxFrames) return "frame-count";
  if (usage.durationMs > limits.maxDurationMs) return "duration";
  return null;
}

function assertFillerLimits(limits: FillerBankLimits): void {
  for (const [name, value] of [
    ["clip", limits.maxClips],
    ["encoded-byte", limits.maxBytes],
    ["frame", limits.maxFrames],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`filler ${name} limit must be a positive integer`);
    }
  }
  if (limits.maxBytes > MAX_SYNTHESIZED_WAV_BYTES) {
    throw new RangeError(`filler encoded-byte limit cannot exceed ${MAX_SYNTHESIZED_WAV_BYTES}`);
  }
  if (!Number.isFinite(limits.maxDurationMs)
    || limits.maxDurationMs <= 0
    || limits.maxDurationMs > MAX_DECODED_WAV_DURATION_MS) {
    throw new RangeError(
      `filler duration limit must be positive and no greater than ${MAX_DECODED_WAV_DURATION_MS}ms`,
    );
  }
}
