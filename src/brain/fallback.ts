import type { BackgroundTurnOptions, Brain, BrainTurnOptions, PendingConfirmation } from "../types";
import { log } from "../logger";
import { BrainTurnContext } from "./turn-context";
import { allBrainsSupport, bindBrainCapability, sendUnattended } from "./capabilities";
import { collectPendingConfirmations, hasPendingConfirmations, relayBoundConfirmation, resolveBoundConfirmation } from "./approval";

/**
 * Plan-billing insurance for a lane: an ordered ladder of brains (e.g.
 * Anthropic plan → Codex plan → local/free). Every turn starts at tier 0, so
 * a recovered primary takes the very next turn — no sticky degradation. A
 * tier is skipped only when it fails BEFORE producing any output; once a
 * tier has streamed text, its errors surface (re-running the turn on another
 * brain would speak a duplicate half-answer).
 *
 * Tier switches are announced out loud ("On the backup line.") — a QA
 * employee must never get silently dumber.
 */
export class FallbackBrain implements Brain {
  private started = new Set<number>();
  /** Tier that served the previous turn (-1 = none yet) — gates the spoken notice. */
  private lastServed = -1;
  private turnContext = new BrainTurnContext();
  /** Tier currently handling a turn, or the last tier that handled one. */
  private currentTier = 0;

  constructor(private tiers: Brain[], private laneName: string) {
    if (tiers.length === 0) throw new Error("FallbackBrain needs at least one brain");
  }

  private async ensureStarted(i: number): Promise<Brain> {
    const brain = this.tiers[i]!;
    if (!this.started.has(i)) {
      await brain.start();
      this.started.add(i);
    }
    return brain;
  }

  /** Spoken once when a turn lands on a lower tier than the previous turn used. */
  private notice(i: number): string {
    if (i === this.lastServed || i === 0) return "";
    return "On the backup line. ";
  }

  async start(): Promise<void> {
    await this.ensureStarted(0); // fallback tiers spawn lazily, on first failure
  }

  async stop(): Promise<void> {
    for (const i of this.started) {
      await this.tiers[i]!.stop().catch(() => { /* already down */ });
    }
    this.started.clear();
    this.currentTier = 0;
  }

  async send(message: string, options?: BrainTurnOptions): Promise<string> {
    const confirmation = relayBoundConfirmation(this, message);
    if (confirmation !== null) return confirmation;
    let lastErr: unknown;
    const previousTier = this.currentTier;
    const context = this.turnContext.takePending();
    for (let i = 0; i < this.tiers.length; i++) {
      try {
        this.currentTier = i;
        const brain = await this.ensureStarted(i);
        if (context) brain.injectContext(context);
        const reply = await brain.send(message, options);
        const prefix = this.notice(i);
        this.lastServed = i;
        return prefix + reply;
      } catch (err: unknown) {
        this.currentTier = previousTier;
        if (options?.signal?.aborted) throw err;
        lastErr = err;
        log("error", `lane '${this.laneName}' tier ${i} failed (${err instanceof Error ? err.message : String(err)}) — ${i + 1 < this.tiers.length ? "trying the next tier" : "no tiers left"}`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async *sendStream(message: string, options?: BrainTurnOptions): AsyncIterable<string> {
    yield* this.streamWithFallback(message, options, (brain) =>
      brain.sendStream ? brain.sendStream(message, options) : oneShot(brain.send(message, options))
    );
  }

  /** Narration is safe to advertise only when no fallback tier can drop it. */
  get streamProgress(): Brain["streamProgress"] {
    if (!allBrainsSupport(this.tiers, "streamProgress")) return undefined;
    return (message: string, options?: BrainTurnOptions): AsyncIterable<string> => this.streamWithFallback(message, options, (brain) =>
      bindBrainCapability(brain, "streamProgress")!(message, options)
    );
  }

  get sendToTab(): Brain["sendToTab"] { return bindBrainCapability(this.current(), "sendToTab"); }
  get switchTab(): Brain["switchTab"] { return bindBrainCapability(this.current(), "switchTab"); }
  get getTargetTab(): Brain["getTargetTab"] { return bindBrainCapability(this.current(), "getTargetTab"); }
  get activeLane(): Brain["activeLane"] { return bindBrainCapability(this.current(), "activeLane"); }
  get transferTo(): Brain["transferTo"] { return bindBrainCapability(this.current(), "transferTo"); }
  get setCallMeHandler(): Brain["setCallMeHandler"] { return bindBrainCapability(this.current(), "setCallMeHandler"); }
  get activeLaneVoice(): Brain["activeLaneVoice"] { return bindBrainCapability(this.current(), "activeLaneVoice"); }
  get wasControlTurn(): Brain["wasControlTurn"] { return bindBrainCapability(this.current(), "wasControlTurn"); }

  private current(): Brain {
    return this.tiers[this.currentTier] ?? this.tiers[0]!;
  }

  /**
   * Background turns keep the tier ladder but never touch spoken-turn state
   * (tier notice, one-shot context) — a scheduled brief must not silently
   * mark the backup line as "already announced" for the next voice turn.
   */
  async sendBackground(message: string, options?: BackgroundTurnOptions): Promise<string> {
    let lastErr: unknown;
    for (let i = 0; i < this.tiers.length; i++) {
      try {
        const brain = await this.ensureStarted(i);
        return await sendUnattended(brain, message, options);
      } catch (err: unknown) {
        if (options?.signal?.aborted) throw err;
        lastErr = err;
        log("error", `lane '${this.laneName}' tier ${i} failed on a background turn (${err instanceof Error ? err.message : String(err)}) — ${i + 1 < this.tiers.length ? "trying the next tier" : "no tiers left"}`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async *streamWithFallback(
    message: string,
    options: BrainTurnOptions | undefined,
    source: (brain: Brain) => AsyncIterable<string>,
  ): AsyncIterable<string> {
    const confirmation = relayBoundConfirmation(this, message);
    if (confirmation !== null) { yield confirmation; return; }
    let lastErr: unknown;
    const previousTier = this.currentTier;
    const context = this.turnContext.takePending();
    for (let i = 0; i < this.tiers.length; i++) {
      let spoke = false;
      try {
        this.currentTier = i;
        const brain = await this.ensureStarted(i);
        if (context) brain.injectContext(context);
        for await (const chunk of source(brain)) {
          if (!spoke) {
            const prefix = this.notice(i);
            this.lastServed = i;
            if (prefix) yield prefix;
            spoke = true;
          }
          yield chunk;
        }
        if (!spoke) this.lastServed = i; // silent-but-clean turn still counts as served
        return;
      } catch (err: unknown) {
        if (!spoke) this.currentTier = previousTier;
        if (options?.signal?.aborted) throw err;
        if (spoke) throw err; // mid-stream death: don't re-answer on another brain
        lastErr = err;
        log("error", `lane '${this.laneName}' tier ${i} failed (${err instanceof Error ? err.message : String(err)}) — ${i + 1 < this.tiers.length ? "trying the next tier" : "no tiers left"}`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  injectContext(context: string): void {
    this.turnContext.inject(context);
  }

  async restart(): Promise<void> {
    this.turnContext.clear();
    for (const i of this.started) {
      await this.tiers[i]!.restart().catch(() => { /* it can respawn on next use */ });
    }
    this.lastServed = -1;
    this.currentTier = 0;
  }

  async health(): Promise<boolean> {
    for (const i of this.started.size > 0 ? this.started : [0]) {
      if (await this.tiers[i]?.health().catch(() => false)) return true;
    }
    return false;
  }

  get hasPendingConfirmation(): Brain["hasPendingConfirmation"] {
    if (!this.tiers.some((brain) => brain.hasPendingConfirmation || brain.pendingConfirmations)) return undefined;
    return () => hasPendingConfirmations(this.tiers);
  }

  get pendingConfirmations(): Brain["pendingConfirmations"] {
    if (!this.tiers.some((brain) => brain.pendingConfirmations)) return undefined;
    return (): readonly PendingConfirmation[] => collectPendingConfirmations(this.tiers);
  }

  get resolvePendingConfirmation(): Brain["resolvePendingConfirmation"] {
    if (!this.tiers.some((brain) => brain.resolvePendingConfirmation)) return undefined;
    return (approved: boolean, nonce: string): boolean => resolveBoundConfirmation(this.tiers, approved, nonce);
  }
}

async function* oneShot(reply: Promise<string>): AsyncIterable<string> {
  yield await reply;
}
