import { copyFile, lstat, readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { log } from "../../logger";
import { ensurePrivateDirectorySync, ensurePrivateFileSync, PRIVATE_FILE_MODE } from "../../platform/secure-storage";
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
 * Bounds and privacy (untrusted input + private storage discipline): captures
 * are voice recordings, so the directory and every file are created private
 * (0700/0600 via the secure-storage helpers, symlinks refused); oversized
 * utterances are not retained; pruning keeps a fixed utterance budget and only
 * ever deletes files matching the tap's own naming pattern, never other files
 * that happen to share the directory; a capture failure warns once, never
 * fails the transcription, and is retried on the next utterance rather than
 * latched for the daemon's lifetime.
 */
const MAX_RETAINED_UTTERANCES = 1000; // wav+json pairs
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const PRUNE_EVERY = 25;

/** Matches only files this tap wrote: an ISO-ish stamp plus a 3-digit counter. */
const TAP_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2}T[0-9-]+Z-\d{3})\.(wav|json)$/;

interface TapLimits {
  maxRetainedUtterances?: number;
  maxAudioBytes?: number;
  pruneEvery?: number;
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
  private counter = 0;
  private warned = false;
  private readonly maxRetained: number;
  private readonly maxAudioBytes: number;
  private readonly pruneEvery: number;

  constructor(
    private readonly dir: string,
    private readonly engine: string,
    limits?: TapLimits,
  ) {
    this.maxRetained = limits?.maxRetainedUtterances ?? MAX_RETAINED_UTTERANCES;
    this.maxAudioBytes = limits?.maxAudioBytes ?? MAX_AUDIO_BYTES;
    this.pruneEvery = limits?.pruneEvery ?? PRUNE_EVERY;
  }

  /** Copy the utterance + write its sidecar; never throws into the STT path. */
  async record(audioFile: string, transcript: string, elapsedMs: number): Promise<void> {
    try {
      // Re-checked every utterance: a transient failure (unmounted disk,
      // permission hiccup) must not latch capture off for the daemon's life.
      ensurePrivateDirectorySync(this.dir);
      if (!this.announced) {
        this.announced = true;
        log("info", `stt tap: recording utterances to ${this.dir} (engine '${this.engine}')`);
      }
      const source = await lstat(audioFile);
      if (!source.isFile() || source.size > this.maxAudioBytes) return;
      const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${(this.counter++ % 1000).toString().padStart(3, "0")}`;
      const wavPath = join(this.dir, `${stamp}.wav`);
      await copyFile(audioFile, wavPath);
      ensurePrivateFileSync(wavPath);
      await writeFile(
        join(this.dir, `${stamp}.json`),
        JSON.stringify({ engine: this.engine, transcript, stt_ms: elapsedMs, audio_bytes: source.size, at: new Date().toISOString() }),
        { mode: PRIVATE_FILE_MODE },
      );
      if (this.counter % this.pruneEvery === 0) await this.prune();
    } catch (error: unknown) {
      this.warnOnce(`stt tap: capture failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /**
   * Keep the newest N utterances. Only files matching the tap's own naming
   * pattern are candidates — a shared directory's other contents are never
   * touched — and an utterance's wav+json pair is always deleted together.
   */
  private async prune(): Promise<void> {
    const stems = new Set<string>();
    const byStem = new Map<string, string[]>();
    for (const name of await readdir(this.dir)) {
      const match = TAP_FILE_PATTERN.exec(name);
      if (!match) continue;
      stems.add(match[1]!);
      const files = byStem.get(match[1]!) ?? [];
      files.push(name);
      byStem.set(match[1]!, files);
    }
    const ordered = [...stems].sort();
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
