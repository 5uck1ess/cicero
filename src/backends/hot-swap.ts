import type { STTProvider, STTTranscriptionResult } from "./stt/provider";
import type { TTSOptions, TTSProvider } from "./tts/provider";

export type SwappableProvider = STTProvider | TTSProvider;

export interface ProviderLease<T extends SwappableProvider> {
  readonly provider: T;
  release(): void;
}

export interface GenerationPin<T> {
  /** Provider bound to one generation for the span of a single turn. */
  readonly provider: T;
  /** Release the pin so a retired generation can finish draining. Idempotent. */
  release(): void;
}

/** A provider whose current generation can be pinned for one turn's duration. */
export interface PinnableProvider<T> {
  pinGeneration(): GenerationPin<T>;
}

function isPinnable<T>(value: unknown): value is PinnableProvider<T> {
  return typeof (value as { pinGeneration?: unknown } | null)?.pinGeneration === "function";
}

/**
 * Pin a provider's current generation for the length of one turn. A swappable
 * provider hands back a lease so every synthesis/transcription in that turn stays
 * on the generation it started with, even when a swap cuts over mid-turn; new
 * turns pick up the replacement. A plain (non-swappable) provider has no
 * generations, so this is a no-op pin over the provider itself.
 */
export function pinGeneration<T extends object>(provider: T): GenerationPin<T> {
  if (isPinnable<T>(provider)) return provider.pinGeneration();
  return { provider, release: () => {} };
}

interface Generation<T extends SwappableProvider> {
  provider: T;
  leases: number;
  retired: boolean;
  stopped: boolean;
  drain: Promise<void>;
  resolveDrain: () => void;
  cleanup?: Promise<void>;
}

export interface ProviderSlotOptions {
  cleanupTimeoutMs?: number;
}

const DEFAULT_CLEANUP_TIMEOUT_MS = 15_000;

async function within<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Owns one live provider generation. Acquired generations remain valid until
 * their caller releases them; a swap only changes which generation new callers
 * acquire. Retired generations stop after their final lease drains.
 */
export class ProviderSlot<T extends SwappableProvider> {
  private current: Generation<T>;
  private readonly retired = new Set<Generation<T>>();
  private readonly quarantined = new Set<T>();
  private swapRunning = false;
  private closed = false;
  private readonly cleanupTimeoutMs: number;

  constructor(provider: T, options: ProviderSlotOptions = {}) {
    this.current = this.generation(provider);
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  }

  get providerName(): string { return this.current.provider.name; }
  get swapping(): boolean { return this.swapRunning; }
  /** Lifecycle warmups are deliberately non-draining background work at daemon startup. */
  currentProvider(): T { return this.current.provider; }

  acquire(): ProviderLease<T> {
    if (this.closed) throw new Error("provider slot is shutting down");
    const generation = this.current;
    generation.leases += 1;
    let released = false;
    return {
      provider: generation.provider,
      release: () => {
        if (released) return;
        released = true;
        generation.leases -= 1;
        if (generation.retired && generation.leases === 0) generation.resolveDrain();
      },
    };
  }

  async use<R>(operation: (provider: T) => Promise<R>): Promise<R> {
    const lease = this.acquire();
    try {
      return await operation(lease.provider);
    } finally {
      lease.release();
    }
  }

  /**
   * Prepare candidate completely before persistence/cutover. Persistence runs
   * while the old generation is still active; if it throws, candidate cleanup
   * completes and the live generation is unchanged.
   */
  async swap(candidate: T, persist: () => void | Promise<void>): Promise<void> {
    if (this.closed) {
      await this.stopProvider(candidate, "rejected candidate cleanup");
      throw new Error("provider slot is shutting down");
    }
    if (this.swapRunning) {
      await this.stopProvider(candidate, "rejected candidate cleanup");
      throw new Error("another provider swap is already in progress");
    }
    this.swapRunning = true;
    let candidateOwned = true;
    try {
      try {
        await this.cleanupRetired();
        await candidate.start?.();
        await candidate.warmup?.();
        const healthy = candidate.requiredHealth
          ? await candidate.requiredHealth()
          : await candidate.health();
        if (!healthy) throw new Error(`${candidate.name} failed its health check`);
        await persist();
      } catch (error) {
        candidateOwned = false;
        try {
          await this.stopProvider(candidate, "candidate cleanup");
        } catch (cleanupError: unknown) {
          this.quarantined.add(candidate);
          throw new AggregateError([error, cleanupError], `provider swap failed and candidate cleanup was not confirmed`);
        }
        throw new Error(
          `candidate preparation failed; active provider and config retained: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      const previous = this.current;
      this.current = this.generation(candidate);
      candidateOwned = false;
      previous.retired = true;
      this.retired.add(previous);
      if (previous.leases === 0) previous.resolveDrain();
      try {
        await within(
          this.beginGenerationCleanup(previous),
          this.cleanupTimeoutMs,
          `${previous.provider.name} retired generation cleanup`,
        );
      } catch (error) {
        throw new Error(
          `cutover committed, but old provider cleanup was not confirmed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    } finally {
      this.swapRunning = false;
      if (candidateOwned) {
        await this.stopProvider(candidate, "candidate cleanup").catch(() => {});
      }
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    const generations = [this.current, ...this.retired];
    for (const generation of generations) {
      generation.retired = true;
      if (generation.leases === 0) generation.resolveDrain();
    }
    const outcomes = await Promise.allSettled([
      ...generations.map((generation) => within(
        this.beginGenerationCleanup(generation),
        this.cleanupTimeoutMs,
        `${generation.provider.name} generation cleanup`,
      )),
      ...[...this.quarantined].map(async (provider) => {
        await this.stopProvider(provider, "quarantined candidate cleanup");
        this.quarantined.delete(provider);
      }),
    ]);
    const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "one or more provider generations failed to stop");
  }

  private generation(provider: T): Generation<T> {
    let resolveDrain!: () => void;
    const drain = new Promise<void>((resolve) => { resolveDrain = resolve; });
    return { provider, leases: 0, retired: false, stopped: false, drain, resolveDrain };
  }

  private async stopGeneration(generation: Generation<T>): Promise<void> {
    if (generation.stopped) return;
    await this.stopProvider(generation.provider, "provider cleanup");
    generation.stopped = true;
    this.retired.delete(generation);
  }

  private beginGenerationCleanup(generation: Generation<T>): Promise<void> {
    if (generation.cleanup) return generation.cleanup;
    const cleanup = generation.drain.then(() => this.stopGeneration(generation));
    generation.cleanup = cleanup;
    void cleanup.catch(() => {
      if (generation.cleanup === cleanup) generation.cleanup = undefined;
    });
    return cleanup;
  }

  /** Do not accumulate unconfirmed owners across successive cutovers. */
  private async cleanupRetired(): Promise<void> {
    for (const generation of this.retired) {
      await within(
        this.beginGenerationCleanup(generation),
        this.cleanupTimeoutMs,
        `${generation.provider.name} retired generation cleanup`,
      );
    }
    for (const provider of this.quarantined) {
      await this.stopProvider(provider, "quarantined candidate cleanup");
      this.quarantined.delete(provider);
    }
  }

  private async stopProvider(provider: T, label: string): Promise<void> {
    if (!provider.stop) return;
    await within(Promise.resolve().then(() => provider.stop!()), this.cleanupTimeoutMs, `${provider.name} ${label}`);
  }
}

/**
 * Acquire a turn-length lease on a slot's current generation. If the slot is
 * already shutting down there is no generation left to pin; hand back a no-op
 * pin over the last provider so a final in-flight turn can still drain without
 * throwing (that provider may already be stopping — synthesis callers treat a
 * failure as a fallback, not a crash).
 */
function pinCurrentGeneration<T extends SwappableProvider>(slot: ProviderSlot<T>): GenerationPin<T> {
  try {
    const lease = slot.acquire();
    return { provider: lease.provider, release: () => lease.release() };
  } catch {
    return { provider: slot.currentProvider(), release: () => {} };
  }
}

/** Stable facade passed to long-lived listeners and web handlers. */
export class SwappableSTTProvider implements STTProvider, PinnableProvider<STTProvider> {
  readonly name = "hot-swappable-stt";
  constructor(readonly slot: ProviderSlot<STTProvider>) {}
  /** Pin the live generation so a whole turn's STT stays on one provider. */
  pinGeneration(): GenerationPin<STTProvider> {
    return pinCurrentGeneration(this.slot);
  }
  transcribe(audioFile: string): Promise<string | null> {
    return this.slot.use((provider) => provider.transcribe(audioFile));
  }
  transcribeResult(audioFile: string): Promise<STTTranscriptionResult> {
    return this.slot.use(async (provider) => {
      if (provider.transcribeResult) return provider.transcribeResult(audioFile);
      const text = await provider.transcribe(audioFile);
      return text?.trim() ? { kind: "transcript", text } : { kind: "empty" };
    });
  }
  health(): Promise<boolean> { return this.slot.use((provider) => provider.health()); }
  requiredHealth(): Promise<boolean> {
    return this.slot.use((provider) => provider.requiredHealth?.() ?? provider.health());
  }
  start(): Promise<void> { return this.slot.use(async (provider) => { await provider.start?.(); }); }
  async warmup(): Promise<void> { await this.slot.currentProvider().warmup?.(); }
  stop(): Promise<void> { return this.slot.stop(); }
}

/** Stable facade passed to speakers, fillers, notifications, and web turns. */
export class SwappableTTSProvider implements TTSProvider, PinnableProvider<TTSProvider> {
  readonly name = "hot-swappable-tts";
  constructor(readonly slot: ProviderSlot<TTSProvider>) {}
  /** Pin the live generation so a whole turn's synthesis stays on one provider. */
  pinGeneration(): GenerationPin<TTSProvider> {
    return pinCurrentGeneration(this.slot);
  }
  generateAudio(text: string, voice?: string, options?: TTSOptions): Promise<ArrayBuffer> {
    return this.slot.use((provider) => provider.generateAudio(text, voice, options));
  }
  health(): Promise<boolean> { return this.slot.use((provider) => provider.health()); }
  requiredHealth(): Promise<boolean> {
    return this.slot.use((provider) => provider.requiredHealth?.() ?? provider.health());
  }
  start(): Promise<void> { return this.slot.use(async (provider) => { await provider.start?.(); }); }
  async warmup(): Promise<void> { await this.slot.currentProvider().warmup?.(); }
  stop(): Promise<void> { return this.slot.stop(); }
}
