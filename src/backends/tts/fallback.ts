import type { TTSProvider, TTSOptions } from "./provider";
import { log } from "../../logger";

/**
 * Wrap a primary TTS provider with a fallback: if the primary fails on a
 * generation (server died mid-turn, model wedged), the sentence is retried on
 * the fallback engine instead of erroring the turn — the voice degrades
 * instead of going silent. Both engines are started and warmed at startup so
 * the fallback is hot when it's needed (a cold server would cost seconds at
 * the worst possible moment).
 */
export class FallbackTTSProvider implements TTSProvider {
  readonly name: string;

  constructor(private primary: TTSProvider, private fallback: TTSProvider) {
    this.name = `${primary.name}→${fallback.name}`;
  }

  async generateAudio(text: string, voice?: string, options?: TTSOptions): Promise<ArrayBuffer> {
    try {
      return await this.primary.generateAudio(text, voice, options);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Unknown-voice throws are the designed cross-engine hand-off (lane
      // voices are fallback-engine presets, not library clones) — log them as
      // routine routing, not failure, so healthy logs don't read as broken.
      if (voice && /no provisioned voice/i.test(msg)) {
        log("info", `tts: voice '${voice}' is a ${this.fallback.name} preset — rendering there`);
      } else {
        log("warn", `tts ${this.primary.name} failed (${msg.substring(0, 120)}) — falling back to ${this.fallback.name}`);
      }
      try {
        return await this.fallback.generateAudio(text, voice, options);
      } catch (fallbackError: unknown) {
        // A lane voice can name a primary-engine clone that the fallback does
        // not provide. Preserve audible output by degrading loudly to the
        // fallback's configured default instead of dropping the sentence.
        if (!voice) throw fallbackError;
        const fallbackMessage = fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
        log(
          "warn",
          `tts ${this.fallback.name} rejected voice '${voice}' (${fallbackMessage.substring(0, 80)}) — retrying in its default voice`,
        );
        return await this.fallback.generateAudio(text, undefined, options);
      }
    }
  }

  async health(): Promise<boolean> {
    if (await this.primary.health()) return true;
    return this.fallback.health();
  }

  requiredHealth(): Promise<boolean> {
    return this.primary.health();
  }

  /** Start both engines; only throw if BOTH fail — one live engine is enough to speak. */
  async start(): Promise<void> {
    const results = await Promise.allSettled([
      this.primary.start?.() ?? Promise.resolve(),
      this.fallback.start?.() ?? Promise.resolve(),
    ]);
    const [p, f] = results;
    if (p.status === "rejected") {
      const msg = p.reason instanceof Error ? p.reason.message : String(p.reason);
      log("warn", `tts primary ${this.primary.name} failed to start (${msg.substring(0, 120)}) — running on fallback ${this.fallback.name}`);
    }
    if (f.status === "rejected") {
      const msg = f.reason instanceof Error ? f.reason.message : String(f.reason);
      log("warn", `tts fallback ${this.fallback.name} failed to start (${msg.substring(0, 120)}) — no fallback available`);
    }
    if (p.status === "rejected" && f.status === "rejected") {
      throw new Error(`both TTS engines failed to start: ${this.primary.name}, ${this.fallback.name}`);
    }
  }

  async stop(): Promise<void> {
    const results = await Promise.allSettled([
      this.primary.stop?.() ?? Promise.resolve(),
      this.fallback.stop?.() ?? Promise.resolve(),
    ]);
    const failures = results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      const provider = index === 0 ? this.primary.name : this.fallback.name;
      const cause = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      return [new Error(`${provider}: ${cause.message}`, { cause })];
    });
    if (failures.length > 0) {
      throw new AggregateError(failures, "one or more TTS engines failed to stop");
    }
  }

  /** Warm both engines; fallback warmup failures are non-fatal (best-effort). */
  async warmup(): Promise<void> {
    const results = await Promise.allSettled([
      this.primary.warmup?.() ?? Promise.resolve(),
      this.fallback.warmup?.() ?? Promise.resolve(),
    ]);
    const [p] = results;
    if (p.status === "rejected") throw p.reason; // primary warmup failure surfaces as before
  }
}
