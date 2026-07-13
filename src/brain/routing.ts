import type { BackgroundTurnOptions, Brain, BrainTurnOptions, PendingConfirmation } from "../types";
import { log } from "../logger";
import { BrainTurnContext } from "./turn-context";
import { allBrainsSupport, bindBrainCapability, sendUnattended } from "./capabilities";
import { collectPendingConfirmations, hasPendingConfirmations, relayBoundConfirmation, resolveBoundConfirmation } from "./approval";

/**
 * Two-lane brain router (Phase 5 opening move): everyday turns go to the fast
 * primary; utterances carrying an escalation trigger ("think hard about…") go
 * to a heavier escalation brain. Routing is per-utterance and purely lexical —
 * the two lanes are separate agents with separate conversations, so escalation
 * suits one-shot deep questions, not mid-thread follow-ups.
 */

export const DEFAULT_TRIGGERS = ["think hard", "think deeply", "think carefully", "think it through"];

export class RoutingBrain implements Brain {
  /** False until the escalation lane starts cleanly — a dead lane never routes. */
  private escalationUp = false;
  private turnContext = new BrainTurnContext();
  /** Most recently selected lane; stateful capabilities belong to this brain. */
  private current: Brain;

  constructor(
    private primary: Brain,
    private escalation: Brain,
    private triggers: string[] = DEFAULT_TRIGGERS,
  ) {
    this.current = primary;
  }

  private pick(message: string): Brain {
    // A spoken escalation is a short single-line utterance that LEADS with the
    // trigger ("think hard about…"). Multi-line payloads (context-restore
    // primers, injected recaps) can quote a trigger without meaning it — never
    // route those, and ignore triggers buried deep in a long sentence.
    if (message.includes("\n")) {
      this.current = this.primary;
      return this.current;
    }
    const head = message.slice(0, 80).toLowerCase();
    if (this.escalationUp && this.triggers.some((t) => head.includes(t.toLowerCase()))) {
      log("info", "brain: escalation trigger heard — routing to the think lane");
      this.current = this.escalation;
      return this.current;
    }
    this.current = this.primary;
    return this.current;
  }

  /** The primary must start; the escalation lane is best-effort (falls back to primary-only). */
  async start(): Promise<void> {
    await this.primary.start();
    try {
      await this.escalation.start();
      this.escalationUp = true;
      log("ok", "Think lane up (escalation brain started)");
    } catch (err: unknown) {
      log("warn", `think lane failed to start — continuing without escalation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled([this.primary.stop(), this.escalation.stop()]);
  }

  send(message: string, options?: BrainTurnOptions): Promise<string> {
    const confirmation = relayBoundConfirmation(this, message);
    if (confirmation !== null) return Promise.resolve(confirmation);
    const brain = this.pick(message);
    const context = this.turnContext.takePending();
    if (context) brain.injectContext(context);
    return brain.send(message, options);
  }

  async *sendStream(message: string, options?: BrainTurnOptions): AsyncIterable<string> {
    const confirmation = relayBoundConfirmation(this, message);
    if (confirmation !== null) { yield confirmation; return; }
    const brain = this.pick(message);
    const context = this.turnContext.takePending();
    if (context) brain.injectContext(context);
    if (brain.sendStream) yield* brain.sendStream(message, options);
    else yield await brain.send(message, options);
  }

  /** Progress routing must be valid for every lane a message can select. */
  get streamProgress(): Brain["streamProgress"] {
    if (!allBrainsSupport([this.primary, this.escalation], "streamProgress")) return undefined;
    return (message: string, options?: BrainTurnOptions): AsyncIterable<string> => {
      const confirmation = relayBoundConfirmation(this, message);
      if (confirmation !== null) return oneShot(confirmation);
      const brain = this.pick(message);
      const context = this.turnContext.takePending();
      if (context) brain.injectContext(context);
      const progress = bindBrainCapability(brain, "streamProgress");
      if (!progress) throw new Error("selected routing lane does not support progress narration");
      return progress(message, options);
    };
  }

  get sendToTab(): Brain["sendToTab"] { return bindBrainCapability(this.current, "sendToTab"); }
  get switchTab(): Brain["switchTab"] { return bindBrainCapability(this.current, "switchTab"); }
  get getTargetTab(): Brain["getTargetTab"] { return bindBrainCapability(this.current, "getTargetTab"); }
  get activeLane(): Brain["activeLane"] { return bindBrainCapability(this.current, "activeLane"); }
  get transferTo(): Brain["transferTo"] { return bindBrainCapability(this.current, "transferTo"); }
  get setCallMeHandler(): Brain["setCallMeHandler"] { return bindBrainCapability(this.current, "setCallMeHandler"); }
  get activeLaneVoice(): Brain["activeLaneVoice"] { return bindBrainCapability(this.current, "activeLaneVoice"); }
  get wasControlTurn(): Brain["wasControlTurn"] { return bindBrainCapability(this.current, "wasControlTurn"); }

  /**
   * Background turns route deterministically to the primary — never the think
   * lane — and must not consume one-shot context waiting for the next spoken turn.
   */
  sendBackground(message: string, options?: BackgroundTurnOptions): Promise<string> { return sendUnattended(this.primary, message, options); }

  injectContext(context: string): void {
    this.turnContext.inject(context);
  }

  async restart(): Promise<void> {
    this.turnContext.clear();
    await this.primary.restart();
    if (this.escalationUp) {
      await this.escalation.restart().catch((err: unknown) => {
        this.escalationUp = false;
        if (this.current === this.escalation) this.current = this.primary;
        log("warn", `think lane restart failed — escalation disabled: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  health(): Promise<boolean> {
    return this.primary.health();
  }

  get hasPendingConfirmation(): Brain["hasPendingConfirmation"] {
    const brains = this.confirmationBrains();
    if (!brains.some((brain) => brain.hasPendingConfirmation || brain.pendingConfirmations)) return undefined;
    return (): boolean => hasPendingConfirmations(brains);
  }

  get pendingConfirmations(): Brain["pendingConfirmations"] {
    const brains = this.confirmationBrains();
    if (!brains.some((brain) => brain.pendingConfirmations)) return undefined;
    return (): readonly PendingConfirmation[] => collectPendingConfirmations(brains);
  }

  get resolvePendingConfirmation(): Brain["resolvePendingConfirmation"] {
    const brains = this.confirmationBrains();
    if (!brains.some((brain) => brain.resolvePendingConfirmation)) return undefined;
    return (approved: boolean, nonce: string): boolean => resolveBoundConfirmation(brains, approved, nonce);
  }

  private confirmationBrains(): readonly Brain[] {
    return [this.primary, this.escalation];
  }
}

async function* oneShot(value: string): AsyncIterable<string> {
  yield value;
}
