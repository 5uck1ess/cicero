import { copyFile, lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { log } from "../../logger";
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
 * Bounds (untrusted input discipline): oversized utterances are not retained,
 * the directory is pruned to a fixed file budget, a tap failure never fails or
 * delays the transcription result beyond the local file copy, and the target
 * directory must not be a symlink.
 */
const MAX_RETAINED_FILES = 2000; // wav+json pairs => ~1000 utterances
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const PRUNE_EVERY = 25;

export function wrapSTTWithTap(provider: STTProvider, dir: string): STTProvider {
  const tap = new SttTap(resolve(dir), provider.name);
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
  private ready: Promise<boolean> | null = null;
  private counter = 0;
  private warned = false;

  constructor(
    private readonly dir: string,
    private readonly engine: string,
  ) {}

  /** Copy the utterance + write its sidecar; never throws into the STT path. */
  async record(audioFile: string, transcript: string, elapsedMs: number): Promise<void> {
    try {
      if (!(await this.ensureDir())) return;
      const source = await lstat(audioFile);
      if (!source.isFile() || source.size > MAX_AUDIO_BYTES) return;
      const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${(this.counter++ % 1000).toString().padStart(3, "0")}`;
      await copyFile(audioFile, join(this.dir, `${stamp}.wav`));
      await writeFile(
        join(this.dir, `${stamp}.json`),
        JSON.stringify({ engine: this.engine, transcript, stt_ms: elapsedMs, audio_bytes: source.size, at: new Date().toISOString() }),
      );
      if (this.counter % PRUNE_EVERY === 0) await this.prune();
    } catch (error: unknown) {
      this.warnOnce(`stt tap: capture failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  private async ensureDir(): Promise<boolean> {
    this.ready ??= (async () => {
      try {
        await mkdir(this.dir, { recursive: true });
        const target = await lstat(this.dir);
        if (target.isSymbolicLink() || !target.isDirectory()) {
          this.warnOnce(`stt tap: ${this.dir} is not a plain directory — tap disabled`);
          return false;
        }
        log("info", `stt tap: recording utterances to ${this.dir} (engine '${this.engine}')`);
        return true;
      } catch (error: unknown) {
        this.warnOnce(`stt tap: cannot create ${this.dir} (${error instanceof Error ? error.message : String(error)})`);
        return false;
      }
    })();
    return this.ready;
  }

  private async prune(): Promise<void> {
    const entries = (await readdir(this.dir)).filter((f) => /\.(wav|json)$/.test(f)).sort();
    const excess = entries.length - MAX_RETAINED_FILES;
    for (const name of entries.slice(0, Math.max(0, excess))) {
      await unlink(join(this.dir, name)).catch(() => {});
    }
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    log("warn", message);
  }
}
