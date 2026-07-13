import { log } from "../../logger";
import { SerializedLifecycle } from "../serialized-lifecycle";
import type { STTProvider, STTTranscriptionResult } from "./provider";

const LOG_DETAIL_LIMIT = 120;
const LOG_NAME_LIMIT = 64;

interface HealthObservation {
  healthy: boolean;
  reason: string;
}

type LifecycleMethod = "start" | "stop" | "warmup";
type TranscriptionObservation = STTTranscriptionResult | { kind: "ambiguous-empty" };
type FallbackStatus = "available" | "unavailable" | "unknown";

/**
 * Keep a hot secondary recognizer behind the configured primary. A structured
 * provider result distinguishes operational failure from an honestly empty
 * transcription. A confirmed empty result remains silence: sending it through
 * a second recognizer can promote a fallback hallucination into a user turn.
 *
 * Legacy/custom providers without `transcribeResult()` remain compatible: a
 * null result is treated as ambiguous silence, while a thrown error is a
 * diagnosed failure. The primary is attempted on every turn, so a later
 * successful primary response automatically closes a degradation episode.
 */
export class FallbackSTTProvider implements STTProvider {
  readonly name: string;
  private readonly primaryLogName: string;
  private readonly fallbackLogName: string;
  private degraded = false;
  private fallbackUnavailable = false;
  private observationCounter = 0;
  private primaryObservation = 0;
  private fallbackObservation = 0;
  private started = false;
  private cleanupFailure: Error | null = null;
  private readonly lifecycle = new SerializedLifecycle();

  constructor(
    private readonly primary: STTProvider,
    private readonly fallback: STTProvider,
  ) {
    this.name = `${primary.name}→${fallback.name}`;
    this.primaryLogName = logName(primary.name);
    this.fallbackLogName = logName(fallback.name);
  }

  async transcribe(audioFile: string): Promise<string | null> {
    const observation = this.nextObservation();
    try {
      const primary = await readTranscription(this.primary, audioFile);
      if (primary.kind === "transcript") {
        this.holdFallbackState(observation);
        this.markRecovered(observation);
        return primary.text;
      }
      if (primary.kind === "empty") {
        this.holdFallbackState(observation);
        this.markRecovered(observation);
        return null;
      }
      if (primary.kind === "ambiguous-empty") {
        this.holdFallbackState(observation);
        this.holdPrimaryState(observation);
        return null;
      }

      const secondary = await readTranscription(this.fallback, audioFile);
      if (secondary.kind === "failure") {
        this.markFallbackUnavailable(secondary.reason, observation, true);
        this.markDegraded(
          `${primary.reason}; ${this.fallbackLogName} failed: ${secondary.reason}`,
          observation,
          "unavailable",
        );
        return null;
      }

      if (secondary.kind === "ambiguous-empty") {
        this.holdFallbackState(observation);
        this.markDegraded(primary.reason, observation, "unknown");
        return null;
      }
      this.markFallbackAvailable(observation);
      this.markDegraded(primary.reason, observation, "available");
      return secondary.kind === "transcript" ? secondary.text : null;
    } catch (error: unknown) {
      this.markDegraded(detail(error), observation, "unknown");
      return null;
    }
  }

  async health(): Promise<boolean> {
    const observation = this.nextObservation();
    try {
      const [primary, fallback] = await Promise.all([
        inspectHealth(this.primary),
        inspectHealth(this.fallback),
      ]);

      if (fallback.healthy) {
        this.markFallbackAvailable(observation);
      } else {
        this.markFallbackUnavailable(fallback.reason, observation, !primary.healthy);
      }

      if (primary.healthy) {
        this.markRecovered(observation);
      } else {
        this.markDegraded(
          primary.reason,
          observation,
          fallback.healthy ? "available" : "unavailable",
        );
      }
      return primary.healthy || fallback.healthy;
    } catch (error: unknown) {
      this.markDegraded(`health check failed: ${detail(error)}`, observation, "unknown");
      return false;
    }
  }

  requiredHealth(): Promise<boolean> {
    return this.primary.health();
  }

  start(): Promise<void> {
    return this.lifecycle.run("start", () => {
      if (this.cleanupFailure) {
        throw new Error(
          `STT fallback restart is blocked because prior cleanup failed: ${detail(this.cleanupFailure)}`,
          { cause: this.cleanupFailure },
        );
      }
      if (this.started) return Promise.resolve();
      return this.doStart();
    });
  }

  private async doStart(): Promise<void> {
    const observation = this.nextObservation();
    try {
      const [primaryStart, fallbackStart] = await Promise.allSettled([
        invokeLifecycle(this.primary, "start"),
        invokeLifecycle(this.fallback, "start"),
      ]);
      const [primaryHealth, fallbackHealth] = await Promise.all([
        inspectHealth(this.primary),
        inspectHealth(this.fallback),
      ]);

      const primaryReason = primaryStart.status === "rejected"
        ? `failed to start: ${detail(primaryStart.reason)}`
        : primaryHealth.reason;
      const fallbackReason = fallbackStart.status === "rejected"
        ? `failed to start: ${detail(fallbackStart.reason)}`
        : fallbackHealth.reason;
      const primaryAvailable = primaryHealth.healthy;
      const fallbackAvailable = fallbackHealth.healthy;

      if (fallbackAvailable) {
        this.markFallbackAvailable(observation);
      } else {
        this.markFallbackUnavailable(fallbackReason, observation, !primaryAvailable);
      }
      if (primaryAvailable) {
        this.markRecovered(observation);
      } else {
        this.markDegraded(
          primaryReason,
          observation,
          fallbackAvailable ? "available" : "unavailable",
        );
      }

      if (!primaryAvailable && !fallbackAvailable) {
        try {
          await this.stopProviders("failed-start rollback");
        } catch (cleanupError: unknown) {
          this.cleanupFailure = asError(cleanupError);
          throw new Error(
            `both STT engines are unavailable and rollback failed: ${detail(this.cleanupFailure)}`,
            { cause: this.cleanupFailure },
          );
        }
        throw new Error(
          `both STT engines are unavailable after start: ${this.primaryLogName} (${detail(primaryReason)}), `
          + `${this.fallbackLogName} (${detail(fallbackReason)})`,
        );
      }
      this.started = true;
    } catch (error: unknown) {
      this.started = false;
      throw error;
    }
  }

  stop(): Promise<void> {
    return this.lifecycle.run("stop", async () => {
      try {
        await this.doStop();
        this.cleanupFailure = null;
      } catch (error: unknown) {
        this.cleanupFailure = asError(error);
        throw this.cleanupFailure;
      }
    });
  }

  private async doStop(): Promise<void> {
    try {
      await this.stopProviders("stop");
    } catch (error: unknown) {
      throw error;
    } finally {
      this.started = false;
    }
  }

  warmup(): Promise<void> {
    return this.lifecycle.run("warmup", () => {
      if (this.cleanupFailure) {
        throw new Error(
          `STT fallback warmup is blocked because prior cleanup failed: ${detail(this.cleanupFailure)}`,
          { cause: this.cleanupFailure },
        );
      }
      return this.doWarmup();
    });
  }

  private async doWarmup(): Promise<void> {
    const observation = this.nextObservation();
    try {
      const [primary, fallback] = await Promise.allSettled([
        invokeLifecycle(this.primary, "warmup"),
        invokeLifecycle(this.fallback, "warmup"),
      ]);
      if (primary.status === "rejected") {
        this.markDegraded(
          `warmup failed: ${detail(primary.reason)}`,
          observation,
          fallback.status === "fulfilled" ? "available" : "unavailable",
        );
      }
      if (fallback.status === "rejected") {
        log("warn", `stt fallback ${this.fallbackLogName} warmup failed: ${detail(fallback.reason)}`);
      }
      if (primary.status === "rejected" && fallback.status === "rejected") {
        throw new Error(`both STT engines failed to warm: ${this.primaryLogName}, ${this.fallbackLogName}`);
      }
    } catch (error: unknown) {
      throw error;
    }
  }

  private async stopProviders(context: string): Promise<void> {
    try {
      const results = await Promise.allSettled([
        invokeLifecycle(this.primary, "stop"),
        invokeLifecycle(this.fallback, "stop"),
      ]);
      const failures: Error[] = [];
      for (const [index, result] of results.entries()) {
        if (result.status !== "rejected") continue;
        const providerName = index === 0 ? this.primaryLogName : this.fallbackLogName;
        const failure = asError(result.reason);
        failures.push(new Error(`${providerName}: ${detail(failure)}`, { cause: failure }));
        log("warn", `stt ${providerName} failed to stop during ${context}: ${detail(failure)}`);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `one or more STT engines failed to stop during ${context}`);
      }
    } catch (error: unknown) {
      throw error;
    }
  }

  private nextObservation(): number {
    this.observationCounter += 1;
    return this.observationCounter;
  }

  /** A newer ambiguous empty result fences stale operations without claiming recovery. */
  private holdPrimaryState(observation: number): void {
    if (observation > this.primaryObservation) this.primaryObservation = observation;
  }

  /** Fence an older secondary completion when the newer turn did not diagnose it. */
  private holdFallbackState(observation: number): void {
    if (observation > this.fallbackObservation) this.fallbackObservation = observation;
  }

  private markDegraded(reason: string, observation: number, fallbackStatus: FallbackStatus): void {
    if (observation < this.primaryObservation) return;
    this.primaryObservation = observation;
    if (this.degraded) return;
    this.degraded = true;
    const routing = fallbackStatus === "available"
      ? `using ${this.fallbackLogName}`
      : fallbackStatus === "unavailable"
        ? `${this.fallbackLogName} is also unavailable`
        : `${this.fallbackLogName} status is unknown`;
    log("warn", `stt ${this.primaryLogName} degraded (${reason.slice(0, LOG_DETAIL_LIMIT)}) — ${routing}`);
  }

  private markRecovered(observation: number): void {
    if (observation < this.primaryObservation) return;
    this.primaryObservation = observation;
    if (!this.degraded) return;
    this.degraded = false;
    log("ok", `stt ${this.primaryLogName} recovered — returning to the primary recognizer`);
  }

  private markFallbackUnavailable(reason: string, observation: number, silent = false): void {
    if (observation < this.fallbackObservation) return;
    this.fallbackObservation = observation;
    if (this.fallbackUnavailable) return;
    this.fallbackUnavailable = true;
    if (!silent) {
      log("warn", `stt fallback ${this.fallbackLogName} unavailable (${reason.slice(0, LOG_DETAIL_LIMIT)})`);
    }
  }

  private markFallbackAvailable(observation: number): void {
    if (observation < this.fallbackObservation) return;
    this.fallbackObservation = observation;
    this.fallbackUnavailable = false;
  }
}

async function readTranscription(
  provider: STTProvider,
  audioFile: string,
): Promise<TranscriptionObservation> {
  try {
    if (provider.transcribeResult) return await provider.transcribeResult(audioFile);
    const transcript = await provider.transcribe(audioFile);
    return transcript === null
      ? { kind: "ambiguous-empty" }
      : { kind: "transcript", text: transcript };
  } catch (error: unknown) {
    return { kind: "failure", reason: detail(error) };
  }
}

async function inspectHealth(provider: STTProvider): Promise<HealthObservation> {
  try {
    const healthy = await provider.health();
    return {
      healthy,
      reason: healthy ? "healthy" : "health check returned false",
    };
  } catch (error: unknown) {
    return { healthy: false, reason: `health check failed: ${detail(error)}` };
  }
}

function invokeLifecycle(provider: STTProvider, method: LifecycleMethod): Promise<void> {
  const operation = provider[method];
  return Promise.resolve()
    .then(() => operation?.call(provider))
    .then(() => undefined);
}

function detail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, LOG_DETAIL_LIMIT);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function logName(name: string): string {
  return name.slice(0, LOG_NAME_LIMIT);
}
