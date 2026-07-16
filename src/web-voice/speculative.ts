import { unlink } from "node:fs/promises";
import { log } from "../logger";
import type { STTProvider } from "../backends/stt/provider";
import type { Brain } from "../types";
import { beginOwnedTone, settleTone, type ToneOptions } from "./tone";
import { captureOperationalContext } from "./turn";
import { writeSecureTempAudio } from "../platform/secure-temp-audio";

/**
 * Speculative turns: when a mid-pause probe comes back "complete" with high
 * confidence, the turn is about to end — the client will confirm and ship the
 * final WAV within a couple hundred milliseconds, and that WAV will contain
 * the same speech the probe tail already carried. So instead of idling, the
 * server transcribes the tail NOW and starts the brain on it, buffering
 * tokens. When the final WAV lands, {@link streamWebTurn} checks that nothing
 * new was said (duration gate — no second STT pass needed) and adopts the
 * in-flight turn, typically saving the whole final-WAV transcription plus the
 * probe-to-WAV round trip off time-to-first-audio.
 *
 * Safety rails, in order of severity:
 * - Never speculate while a spoken confirmation gate is pending — a mis-heard
 *   "yes" must not resolve a destructive-op gate that the real utterance
 *   wouldn't have.
 * - Never start the brain on local fast-path utterances (voice controls,
 *   "repeat that", "details", "continue") — those are answered above the
 *   brain, and a speculative agent turn for them would be pure pollution.
 * - Only adopt when the probe tail covered the WHOLE utterance and the final
 *   WAV is at most {@link ADOPT_SLACK_MS} longer (the confirm round trip is
 *   pure silence). Anything else aborts: the brain turn is cancelled through
 *   the same path a barge-in uses.
 * - A speculation nobody claims (client died mid-confirm) self-aborts after
 *   {@link CLAIM_TIMEOUT_MS}.
 */

/** Final WAV may exceed the probed utterance by this much and still adopt —
 * verdict RTT + finalize overhead is ~150-400ms of trailing silence; real
 * resumed speech adds ≥ the 700ms hangover plus the speech itself. */
const ADOPT_SLACK_MS = 600;
/** Probe tail must cover the utterance to within this (frame granularity). */
const COVERAGE_SLACK_MS = 250;
/** Unclaimed speculations self-abort after this. */
const CLAIM_TIMEOUT_MS = 5000;
export const MAX_SPECULATIVE_TOKEN_ITEMS = 2_048;
export const MAX_SPECULATIVE_TOKEN_BYTES = 256 * 1024;

export interface SpeculatorDeps {
  stt: Pick<STTProvider, "transcribe">;
  brain: Pick<Brain, "sendStream" | "hasPendingConfirmation">;
  /** Utterances the reply pipeline answers WITHOUT a brain turn. */
  isLocalFastPath: (transcript: string) => boolean;
  /** Only speculate at or above this end-of-turn probability. */
  minProbability: number;
  /** Optional input-side tone tag, classified from the probe tail — see {@link ToneOptions}. */
  tone?: ToneOptions;
  /** Override the unclaimed-speculation timeout (tests only). */
  claimTimeoutMs?: number;
  /** Per-invocation daemon snapshot, captured once when speculation starts the brain. */
  operationalContext?: (signal?: AbortSignal) => Promise<string | null>;
}

/** One in-flight speculative turn, owned by a websocket connection. */
export interface SpeculativeTurn {
  /**
   * Take ownership for adoption. False when the speculation already aborted
   * (timeout, replaced) — the caller then just runs the normal path.
   */
  claim(): boolean;
  /** True when the final utterance's duration says the tail we transcribed was the whole thing. */
  coverageOk(finalMs: number): boolean;
  /** The tail transcript; null when STT failed or heard nothing (never rejects). */
  transcript(): Promise<string | null>;
  /** Buffered brain tokens; null when no brain turn was started (fast-path / empty / failed STT). */
  tokens(): AsyncIterable<string> | null;
  /** Cancel everything; waits for an in-flight brain turn to settle. */
  abort(): Promise<void>;
  /**
   * Resolves once this turn becomes permanently unclaimable and every owned
   * provider continuation has drained. Optional for third-party speculators;
   * the built-in implementation exposes it so transports can release admission
   * after an unclaimed timeout without waiting for the socket to close.
   */
  readonly closed?: Promise<void>;
}

class SpeculativeBufferLimitError extends Error {}

/** Bounded token buffer retained until the final WAV adopts or aborts it. */
class TokenBuffer {
  private items: string[] = [];
  private bytes = 0;
  private done = false;
  private err: unknown = null;
  private wake: (() => void) | null = null;

  push(t: string): void {
    if (this.done) return;
    const bytes = Buffer.byteLength(t);
    if (this.items.length >= MAX_SPECULATIVE_TOKEN_ITEMS) {
      throw new SpeculativeBufferLimitError(
        `speculative token buffer exceeds ${MAX_SPECULATIVE_TOKEN_ITEMS} items`,
      );
    }
    if (bytes > MAX_SPECULATIVE_TOKEN_BYTES - this.bytes) {
      throw new SpeculativeBufferLimitError(
        `speculative token buffer exceeds ${MAX_SPECULATIVE_TOKEN_BYTES} bytes`,
      );
    }
    this.items.push(t);
    this.bytes += bytes;
    this.wake?.();
  }
  /** First end() wins — the pump's finally must not clobber an error end. */
  end(err?: unknown) {
    if (this.done) return;
    this.done = true; this.err = err ?? null; this.wake?.();
  }

  async *drain(): AsyncGenerator<string> {
    let i = 0;
    while (true) {
      while (i < this.items.length) yield this.items[i++]!;
      if (this.done) {
        if (this.err) throw this.err instanceof Error ? this.err : new Error(String(this.err));
        return;
      }
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = null;
    }
  }
}

/** Encode 16 kHz mono float PCM as a WAV (the STT servers eat files, not frames). */
export function pcmToWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const wr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  wr(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); wr(8, "WAVE");
  wr(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wr(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

export type Speculator = (
  samples: Float32Array,
  sampleRate: number,
  utterMs: number,
  probability: number,
) => SpeculativeTurn | null;

export function makeSpeculator(deps: SpeculatorDeps): Speculator {
  return (samples, sampleRate, utterMs, probability) => {
    if (probability < deps.minProbability) return null;
    if (!deps.brain.sendStream) return null;
    // A pending destructive-op gate: nothing speculative may touch the brain.
    if (deps.brain.hasPendingConfirmation?.()) return null;
    const tailMs = (samples.length / sampleRate) * 1000;
    // Tail truncated by the probe window — we'd transcribe half a sentence.
    if (tailMs < utterMs - COVERAGE_SLACK_MS) return null;

    let aborted = false;
    let claimed = false;
    let buffer: TokenBuffer | null = null;
    let pumpDone: Promise<void> = Promise.resolve();
    let pumpSettled = true;
    const startedAt = performance.now();
    const turnAbort = new AbortController();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortTask: Promise<void> | null = null;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    const closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    // Standalone embedders are not required to observe the lifecycle signal;
    // abort() remains the error-bearing API they explicitly call.
    void closed.catch(() => {});

    const wavBytes = pcmToWav(samples, sampleRate);
    // Tone classifies the probe tail in parallel with its transcription — the
    // brain input waits for the verdict at most the grace window.
    const tonePending = beginOwnedTone(deps.tone, wavBytes, "speculative tone classification");
    const transcriptPromise: Promise<string | null> = (async () => {
      let tmpFile: string | undefined;
      try {
        tmpFile = await writeSecureTempAudio(wavBytes, { prefix: "cicero-spec" });
        const text = (await deps.stt.transcribe(tmpFile))?.trim() ?? "";
        return text || null;
      } catch (err: unknown) {
        log("warn", `speculative: tail STT failed — falling back to the normal path (${err instanceof Error ? err.message : String(err)})`);
        return null;
      } finally {
        if (tmpFile) await unlink(tmpFile).catch(() => { /* best-effort cleanup */ });
      }
    })();

    // Start the brain as soon as the tail transcript is in — unless the turn
    // was aborted first, the utterance is a local fast-path, or STT came up dry.
    const brainStarted: Promise<void> = transcriptPromise.then(async (text) => {
      if (aborted || !text || deps.isLocalFastPath(text)) return;
      const tag = await settleTone(tonePending?.result ?? null, deps.tone?.graceMs);
      if (aborted) return;
      const input = tag ? `${text}\n\n${tag}` : text;
      let systemContext: string | null = null;
      try {
        turnAbort.signal.throwIfAborted();
        systemContext = await captureOperationalContext(deps.operationalContext, turnAbort.signal);
        turnAbort.signal.throwIfAborted();
      } catch (error: unknown) {
        if (turnAbort.signal.aborted || aborted) return;
        log("warn", `speculative: operational snapshot unavailable (${error instanceof Error ? error.message : String(error)})`);
      }
      if (aborted) return;
      const buf = new TokenBuffer();
      buffer = buf;
      pumpSettled = false;
      pumpDone = (async () => {
        let it: AsyncIterator<string> | null = null;
        try {
          it = deps.brain.sendStream!(input, {
            signal: turnAbort.signal,
            systemContext: systemContext ?? undefined,
          })[Symbol.asyncIterator]();
          while (!aborted) {
            const next = it.next();
            let result: IteratorResult<string> | null = null;
            while (result === null) {
              result = await Promise.race([next, Bun.sleep(200).then(() => null)]);
              if (result === null && aborted) {
                void next.catch(() => {});
                return;
              }
            }
            if (result.done) return;
            try {
              buf.push(result.value);
            } catch (error) {
              buf.end(error);
              log("warn", `speculative: ${error instanceof Error ? error.message : String(error)} — falling back to the final turn`);
              void doAbort("buffer limit").catch((abortError: unknown) => {
                log("warn", `speculative buffer cleanup failed: ${abortError instanceof Error ? abortError.message : String(abortError)}`);
              });
              return;
            }
          }
        } catch (err: unknown) {
          buf.end(err);
        } finally {
          // Abort does not own the brain until the source's finalizer has
          // completed. A non-cooperative embedder is surfaced to the server's
          // bounded shutdown deadline instead of becoming a late continuation.
          if (it) {
            try {
              await it.return?.(undefined);
            } catch (error: unknown) {
              log("warn", `speculative brain finalization failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          buf.end();
          pumpSettled = true;
        }
      })();
    });

    const doAbort = (why: string): Promise<void> => {
      if (!aborted) {
        aborted = true;
        turnAbort.abort(new Error(`speculative turn aborted: ${why}`));
        if (buffer && !pumpSettled) log("info", `speculative: aborted (${why}) — cancelling the agent turn`);
      }
      if (timeout !== undefined) clearTimeout(timeout);
      if (!abortTask) {
        abortTask = (async () => {
          let firstError: unknown;
          try { await brainStarted; } catch (error) { firstError = error; }
          try { await tonePending?.drain; } catch (error) { firstError ??= error; }
          // brainStarted may install the real pump after abort() was requested.
          try { await pumpDone; } catch (error) { firstError ??= error; }
          if (firstError !== undefined) {
            throw firstError instanceof Error
              ? firstError
              : new Error("speculative abort drain failed", { cause: firstError });
          }
        })().finally(() => {
          // Once permanently unclaimable, do not retain the bounded token
          // buffer through an otherwise-idle WebSocket connection.
          buffer = null;
        });
        void abortTask.then(resolveClosed, rejectClosed);
      }
      return abortTask;
    };

    timeout = setTimeout(() => {
      void doAbort("unclaimed").catch((error: unknown) => {
        log("warn", `speculative timeout cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, deps.claimTimeoutMs ?? CLAIM_TIMEOUT_MS);

    return {
      claim() {
        if (aborted) return false;
        claimed = true;
        clearTimeout(timeout);
        log("info", `speculative: claimed ${Math.round(performance.now() - startedAt)}ms after the probe`);
        return true;
      },
      coverageOk(finalMs: number) {
        return finalMs - utterMs <= ADOPT_SLACK_MS;
      },
      async transcript() {
        const text = await transcriptPromise;
        await brainStarted; // tokens() is meaningful once this settles
        return aborted ? null : text;
      },
      tokens() {
        if (aborted || !buffer) return null;
        const buf = buffer;
        return (async function* () {
          let completed = false;
          try {
            yield* buf.drain();
            completed = true;
          } finally {
            // Adopted consumer stopped early (barge-in): tear the pump — and
            // with it the agent turn — down, exactly like a live stream would.
            if (!completed) {
              await doAbort("consumer stopped");
            }
          }
        })();
      },
      abort: () => doAbort(claimed ? "post-claim" : "superseded"),
      closed,
    };
  };
}
