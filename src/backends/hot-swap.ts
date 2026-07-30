import { log } from "../logger";
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
/**
 * Optional capability: abandon a startup that has not resolved yet. A managed
 * provider spawns its child before readiness completes, so without this an owner
 * can only wait the whole launch out — see stopQuarantined. Providers without it
 * are unaffected (nothing to cancel).
 */
interface CancellableStartup { cancelStartup?(): void }

/** True when the provider actually had a startup to cancel. */
function cancelProviderStartup(provider: unknown): boolean {
  const cancellable = provider as CancellableStartup;
  if (typeof cancellable.cancelStartup !== "function") return false;
  cancellable.cancelStartup();
  return true;
}

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

interface PreparingCandidate<T extends SwappableProvider> {
  provider: T;
  /** Cleared by whoever takes responsibility for stopping this provider. */
  owned: boolean;
  /** Set once its owner starts stopping it, so a concurrent stop() can wait. */
  disposal?: Promise<void>;
  /**
   * Resolves once start()/warmup() have settled, however they settled. A managed
   * provider publishes the process it owns only when its startup succeeds, so
   * stopping it before this point is a no-op that leaves the child running the
   * moment start() completes.
   */
  readonly started: Promise<void>;
}

export const DEFAULT_CLEANUP_TIMEOUT_MS = 15_000;

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
  /**
   * Providers whose release is unconfirmed, mapped to the startup barrier that
   * must be awaited before stopping them again (undefined once startup is known
   * to have settled). Carrying the barrier is the point: a candidate quarantined
   * because its start had not finished is still not stoppable on the retry —
   * managed adapters publish the process they own only when startup succeeds —
   * so a retry that skipped straight to stop() reaped nothing and then dropped
   * the entry, leaking the child it was holding on behalf of.
   */
  private readonly quarantined = new Map<T, Promise<void> | undefined>();
  private swapRunning = false;
  private closed = false;
  private readonly cleanupTimeoutMs: number;
  /**
   * Candidates an in-flight swap has already started. Such a provider is alive
   * and owned by this slot, yet appears in none of the sets above — it becomes
   * `current` only at cutover. stop() must be able to see and claim it, or it
   * reports a confirmed release while that child is still running. `owned` is
   * the single ownership token: whoever clears it does the stopping, so the swap
   * and a concurrent stop() can never both stop the same provider.
   */
  private readonly preparing = new Set<PreparingCandidate<T>>();
  /**
   * A cleanup deadline bounds how long this slot waits; it cannot cancel an
   * arbitrary provider's stop(). Keep owning that exact teardown after timeout
   * so a retry joins it instead of running a second stop concurrently against
   * the same child. A late success is remembered because the generation could
   * not mark itself stopped after its bounded wait had already rejected.
   */
  private readonly providerStops = new WeakMap<T, Promise<void>>();
  private readonly releasedProviders = new WeakSet<T>();

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
  async swap(
    candidate: T,
    persist: () => void | Promise<void>,
    options: {
      signal?: AbortSignal;
      onCutover?: () => void;
      /** Final candidate-specific gate immediately before persistence. */
      validatePrepared?: () => void | Promise<void>;
    } = {},
  ): Promise<void> {
    if (this.closed) {
      await this.stopProvider(candidate, "rejected candidate cleanup");
      throw new Error("provider slot is shutting down");
    }
    if (this.swapRunning) {
      await this.stopProvider(candidate, "rejected candidate cleanup");
      throw new Error("another provider swap is already in progress");
    }
    this.swapRunning = true;
    // Register the candidate before the first await, so a stop() landing
    // mid-preparation can claim it rather than snapshotting a set that cannot
    // contain it yet.
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const owning: PreparingCandidate<T> = { provider: candidate, owned: true, started };
    this.preparing.add(owning);
    try {
      try {
        try {
          // stop() can quarantine this candidate while the swap is still
          // draining an older generation. Do not make that cleanup wait on the
          // candidate's own `started` barrier: this stack is what resolves it.
          await this.cleanupRetired(owning);
          // A shutdown that landed during the retired drain owns the candidate
          // now. Refuse before start(), because managed adapters create their
          // startup cancellation scope only inside start() and a pre-start
          // cancel/stop cannot release a process launched afterwards.
          if (this.closed) throw new Error("provider slot is shutting down");
          await candidate.start?.();
          await candidate.warmup?.();
        } finally {
          // Whatever this candidate owns — a spawned server, a client, nothing
          // at all — it owns by now, so a shutdown waiting to reap it can stop
          // waiting. Signalled on the failure path too: a candidate that threw
          // may still have published something before it did.
          markStarted();
        }
        const healthy = candidate.requiredHealth
          ? await candidate.requiredHealth()
          : await candidate.health();
        if (!healthy) throw new Error(`${candidate.name} failed its health check`);
        // A shutdown can land while the candidate was starting. stop() snapshots
        // the generations it owns, so anything installed after it ran would never
        // be reaped. Refuse before persisting so config stays truthful too.
        if (this.closed) throw new Error("provider slot is shutting down");
        // persist() is the commit point, and the same argument applies to the
        // caller going away as to a shutdown: if the request that asked for this
        // swap has been abandoned, committing it writes config and cuts over while
        // the operator is being told the swap failed. Refuse before that, so a
        // reported failure and an unchanged system always agree. After persist the
        // swap is committed and a late abort is deliberately ignored.
        if (options.signal?.aborted) {
          throw new Error("swap request was cancelled before it was committed");
        }
        await options.validatePrepared?.();
        await persist();
      } catch (error) {
        // A shutdown may already have claimed and reaped this candidate; then
        // there is nothing left to clean up and the failure below still stands.
        if (this.claimCandidate(owning)) {
          let cleanupError: unknown;
          // Quarantine INSIDE the disposal promise: a stop() waiting on it must
          // not be able to snapshot `quarantined` before the failed candidate
          // has been put there.
          const disposal = this.stopProvider(candidate, "candidate cleanup").catch((failure: unknown) => {
            this.quarantined.set(candidate, owning.started);
            cleanupError = failure;
          });
          owning.disposal = disposal;
          await disposal;
          if (cleanupError) {
            throw new AggregateError([error, cleanupError], `provider swap failed and candidate cleanup was not confirmed`);
          }
        }
        throw new Error(
          `candidate preparation failed; active provider and config retained: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      // Narrow re-check: persist() awaited, so a shutdown may have started since
      // the gate above. Config is already written (the operator's selection wins
      // on the next start), but this generation must not be installed behind
      // stop()'s back — the finally below releases the prepared candidate.
      if (this.closed) {
        throw new Error("provider slot began shutting down; the persisted selection takes effect on the next start");
      }
      const previous = this.current;
      this.current = this.generation(candidate);
      // Synchronous with the check above: the candidate is a generation now, so
      // ownership passes to the generation sets a stop() already snapshots.
      owning.owned = false;
      // New callers acquire the replacement from this instant, but swap() has
      // not returned — it still drains the retired generation, for up to the
      // cleanup deadline. Anything a caller must invalidate at the cutover has
      // to happen HERE, not after the await, or turns in that window run on the
      // new provider with state derived from the old one. Kept synchronous so
      // no turn can slip between the publish and the notification, and its
      // failure is contained so a hook cannot corrupt the slot.
      if (options.onCutover) {
        try {
          options.onCutover();
        } catch {
          // The cutover itself is committed; a hook's failure is the caller's.
        }
      }
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
      if (this.claimCandidate(owning)) {
        // Quarantine rather than swallow: a candidate whose stop fails here is
        // still running, and dropping the error left it owned by nobody. In
        // quarantine, stop() — including a later retry — will try it again.
        const disposal = this.stopProvider(candidate, "candidate cleanup").catch(() => {
          this.quarantined.set(candidate, owning.started);
        });
        owning.disposal = disposal;
        await disposal;
      }
      // Only now: while the entry is still registered, a concurrent stop() can
      // see that this candidate exists and wait for the disposal above.
      this.preparing.delete(owning);
    }
  }

  /** Take exclusive responsibility for stopping a candidate, if nobody else has. */
  private claimCandidate(entry: PreparingCandidate<T>): boolean {
    if (!entry.owned) return false;
    entry.owned = false;
    return true;
  }

  async stop(): Promise<void> {
    this.closed = true;
    // `closed` is now set, so an in-flight swap can no longer cut over — but it
    // still owns a started candidate that is in none of the sets below until
    // cutover, and a failed disposal only reaches `quarantined` afterwards.
    // Snapshotting straight away reported a confirmed release while that child
    // was still alive; the daemon then cleared its slots and the last handle to
    // it was gone. So claim what the swap has not begun disposing of, and wait
    // out the disposals it has (each already bounded by stopProvider) before the
    // snapshot below. Deliberately NOT a wait on the whole swap — only on the
    // claimed candidate's start, and only for the cleanup deadline.
    const disposals: Promise<unknown>[] = [];
    for (const entry of this.preparing) {
      // Quarantine carries the startup barrier with it, so THIS attempt and every
      // later retry both wait for the start before trying to reap the child.
      if (this.claimCandidate(entry)) this.quarantined.set(entry.provider, entry.started);
      else if (entry.disposal) disposals.push(entry.disposal.catch(() => {}));
    }
    if (disposals.length > 0) await Promise.all(disposals);
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
      ...[...this.quarantined].map(([provider, startup]) => this.stopQuarantined(provider, startup)),
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
  private async cleanupRetired(preparing?: PreparingCandidate<T>): Promise<void> {
    for (const generation of this.retired) {
      await within(
        this.beginGenerationCleanup(generation),
        this.cleanupTimeoutMs,
        `${generation.provider.name} retired generation cleanup`,
      );
    }
    for (const [provider, startup] of this.quarantined) {
      if (preparing && provider === preparing.provider && startup === preparing.started) {
        continue;
      }
      await this.stopQuarantined(provider, startup);
    }
  }

  /**
   * Reap one quarantined provider, waiting out its startup first when that has
   * not settled. Managed adapters publish the process they own only once startup
   * succeeds and their stop() is a no-op before that, so skipping the barrier
   * reaps nothing — and dropping the entry afterwards would leak the child. The
   * entry therefore survives any failure here, including a startup that is still
   * pending, so the next attempt tries again.
   */
  private async stopQuarantined(provider: T, startup: Promise<void> | undefined): Promise<void> {
    if (startup) {
      // Round 8 (Codex): cancel the launch before waiting on it. A managed
      // startup can legitimately run for minutes (a cold model fetch), and this
      // deadline is far shorter — so the wait expired while the launch ran on,
      // and shutdown completed leaving a spawned child with no owner. Nothing
      // else could reap it: the handle lives only in this process's memory, and
      // a swap candidate is never published to config.
      //
      // Cancelling is synchronous and cannot fail, so the barrier below then
      // settles promptly instead of timing out. The stop after it stays the one
      // authoritative teardown.
      const cancellable = cancelProviderStartup(provider);
      try {
        await within(startup, this.cleanupTimeoutMs, `${provider.name} candidate startup`);
        // Settled now, so a later retry has nothing left to wait for.
        this.quarantined.set(provider, undefined);
      } catch (error: unknown) {
        // Round 9 (Codex): the barrier covers warmup as well as start(), and
        // warmup is a synthesis/transcription request on the provider's own
        // independently configured deadline (up to 600s) that cancelStartup does
        // not abort. So a CANCELLABLE provider that still misses this deadline is
        // hung in warmup — which means start() already returned and published its
        // handle, so stop() has something to reap. Doing it is also safe: the
        // latch is set and startManagedServer re-checks it before spawning, so no
        // new child can appear behind this teardown.
        //
        // A provider with nothing to cancel is the round 5 case and keeps that
        // behaviour: its handle appears only when start() returns, so stopping
        // now would reap nothing and strand the child that is about to exist.
        // Report unconfirmed and stay quarantined for a later retry instead.
        if (!cancellable) throw error;
        log("warn", `${provider.name} candidate warmup did not settle (${
          error instanceof Error ? error.message : String(error)
        }) — stopping the candidate anyway rather than leaving its child unowned`);
        await this.stopProvider(provider, "quarantined candidate cleanup");
        this.quarantined.delete(provider);
        return;
      }
    }
    await this.stopProvider(provider, "quarantined candidate cleanup");
    this.quarantined.delete(provider);
  }

  private async stopProvider(provider: T, label: string): Promise<void> {
    if (!provider.stop || this.releasedProviders.has(provider)) return;
    let stopping = this.providerStops.get(provider);
    if (!stopping) {
      stopping = Promise.resolve().then(() => provider.stop!());
      this.providerStops.set(provider, stopping);
      void stopping.then(
        () => {
          this.releasedProviders.add(provider);
          if (this.providerStops.get(provider) === stopping) this.providerStops.delete(provider);
        },
        () => {
          if (this.providerStops.get(provider) === stopping) this.providerStops.delete(provider);
        },
      );
    }
    await within(stopping, this.cleanupTimeoutMs, `${provider.name} ${label}`);
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
  cancelStartup(): void { this.slot.currentProvider().cancelStartup?.(); }
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
  cancelStartup(): void { this.slot.currentProvider().cancelStartup?.(); }
  start(): Promise<void> { return this.slot.use(async (provider) => { await provider.start?.(); }); }
  async warmup(): Promise<void> { await this.slot.currentProvider().warmup?.(); }
  stop(): Promise<void> { return this.slot.stop(); }
}
