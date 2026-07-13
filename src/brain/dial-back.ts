import { classifyCallIntent, dialBackMemo, matchCallMe, type CallIntentClassifier } from "../call-intent";
import type { BackgroundTurnOptions, Brain, BrainTurnOptions } from "../types";
import { bindBrainCapability, sendUnattended } from "./capabilities";

type DialBackHandler = (who?: string, options?: BrainTurnOptions) => Promise<string>;

/**
 * Whole-utterance dial-back control shared by every brain backend.
 *
 * The daemon installs the side-effecting handler after startup. Until then the
 * wrapper is transparent, so doctor/readiness probes and ordinary chat keep the
 * exact underlying behavior.
 */
export class DialBackBrain implements Brain {
  private handler?: DialBackHandler;
  private control = false;

  constructor(
    private readonly inner: Brain,
    private readonly classify?: CallIntentClassifier,
    private readonly roster: readonly string[] = [],
  ) {}

  start(): Promise<void> { return this.inner.start(); }
  stop(): Promise<void> { return this.inner.stop(); }
  restart(): Promise<void> { return this.inner.restart(); }
  health(): Promise<boolean> { return this.inner.health(); }
  injectContext(context: string): void { this.inner.injectContext(context); }

  setCallMeHandler(handler: DialBackHandler): void {
    this.handler = handler;
  }

  send(message: string, options?: BrainTurnOptions): Promise<string> {
    return this.dialBack(message, options).then((reply) =>
      reply ?? this.inner.send(message, options)
    );
  }

  async *sendStream(message: string, options?: BrainTurnOptions): AsyncIterable<string> {
    const reply = await this.dialBack(message, options);
    if (reply !== null) {
      yield reply;
      return;
    }
    if (this.inner.sendStream) yield* this.inner.sendStream(message, options);
    else yield await this.inner.send(message, options);
  }

  get streamProgress(): Brain["streamProgress"] {
    if (!bindBrainCapability(this.inner, "streamProgress")) return undefined;
    return (message: string, options?: BrainTurnOptions): AsyncIterable<string> =>
      this.sendProgress(message, options);
  }

  private async *sendProgress(message: string, options?: BrainTurnOptions): AsyncIterable<string> {
    const reply = await this.dialBack(message, options);
    if (reply !== null) {
      yield reply;
      return;
    }
    yield* bindBrainCapability(this.inner, "streamProgress")!(message, options);
  }

  private async dialBack(message: string, options?: BrainTurnOptions): Promise<string | null> {
    try {
      if (!this.handler) {
        this.control = false;
        return null;
      }
      options?.signal?.throwIfAborted();
      const call = matchCallMe(message) ?? (
        this.classify
          ? await classifyCallIntent(message, this.classify, this.roster, options?.signal)
          : null
      );
      this.control = call !== null;
      if (!call) return null;
      const reply = await this.handler(call.who, options);
      // The ring happened outside the brain's context; without this one-shot
      // memo it denies the call on the very next turn ("did you call me?").
      this.inner.injectContext(dialBackMemo(call.who));
      options?.signal?.throwIfAborted();
      return reply;
    } catch (error: unknown) {
      throw error;
    }
  }

  get sendToTab(): Brain["sendToTab"] { return bindBrainCapability(this.inner, "sendToTab"); }
  get switchTab(): Brain["switchTab"] { return bindBrainCapability(this.inner, "switchTab"); }
  get getTargetTab(): Brain["getTargetTab"] { return bindBrainCapability(this.inner, "getTargetTab"); }
  get activeLane(): Brain["activeLane"] { return bindBrainCapability(this.inner, "activeLane"); }
  get transferTo(): Brain["transferTo"] { return bindBrainCapability(this.inner, "transferTo"); }
  get activeLaneVoice(): Brain["activeLaneVoice"] { return bindBrainCapability(this.inner, "activeLaneVoice"); }
  sendBackground(message: string, options?: BackgroundTurnOptions): Promise<string> {
    return sendUnattended(this.inner, message, options);
  }
  get hasPendingConfirmation(): Brain["hasPendingConfirmation"] { return bindBrainCapability(this.inner, "hasPendingConfirmation"); }
  get pendingConfirmations(): Brain["pendingConfirmations"] { return bindBrainCapability(this.inner, "pendingConfirmations"); }
  get resolvePendingConfirmation(): Brain["resolvePendingConfirmation"] { return bindBrainCapability(this.inner, "resolvePendingConfirmation"); }

  wasControlTurn(): boolean {
    return this.control || (this.inner.wasControlTurn?.() ?? false);
  }
}
