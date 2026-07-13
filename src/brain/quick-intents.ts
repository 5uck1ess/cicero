import type { BackgroundTurnOptions, Brain, BrainTurnOptions, PendingConfirmation } from "../types";
import { log } from "../logger";
import { bindBrainCapability, sendUnattended } from "./capabilities";

/**
 * User-defined lexical fast-paths: utterances that should never cost a brain
 * turn ("what time is it", a standard status greeting, an in-joke). Matching
 * is instant and local — same philosophy as the switchboard's control plane:
 * zero latency, can't hallucinate. Anything that doesn't match falls through
 * to the real brain untouched.
 *
 * Config (config.yaml):
 *   quick_intents:
 *     - phrases: ["what time is it", "time check"]
 *       reply: "It's {time}."
 *     - pattern: "^ping\\b"
 *       reply: ["Pong.", "Pong. All systems up."]
 */

export interface QuickIntent {
  /** Spoken forms matched whole-utterance (normalized: case/punctuation-insensitive). */
  phrases?: string[];
  /** Or a regex tested against the normalized utterance. */
  pattern?: string;
  /** Spoken instantly. Arrays pick one variant at random. {time} and {date} expand at match time. */
  reply: string | string[];
}

/** Same collapsing the switchboard applies, so STT decoration can't defeat a match. */
function normalize(message: string): string {
  return message.trim().toLowerCase().replace(/[.,!?'"]/g, "").replace(/\s+/g, " ");
}

function render(reply: string, now: Date): string {
  return reply
    .replace(/\{time\}/g, now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))
    .replace(/\{date\}/g, now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }));
}

function replies(reply: QuickIntent["reply"]): string[] {
  return (Array.isArray(reply) ? reply : [reply]).filter((r) => r.trim().length > 0);
}

export class QuickIntentsBrain implements Brain {
  private compiled: Array<{ phrases: Set<string>; pattern: RegExp | null; replies: string[] }>;

  constructor(
    private inner: Brain,
    intents: QuickIntent[],
    private now: () => Date = () => new Date(),
    private random: () => number = Math.random,
  ) {
    this.compiled = intents
      .filter((i) => replies(i.reply).length > 0 && (i.phrases?.length || i.pattern))
      .map((i) => {
        let pattern: RegExp | null = null;
        if (i.pattern) {
          try {
            pattern = new RegExp(i.pattern, "i");
          } catch {
            log("warn", `quick_intents: invalid pattern ${JSON.stringify(i.pattern)} — entry disabled`);
          }
        }
        return { phrases: new Set((i.phrases ?? []).map(normalize)), pattern, replies: replies(i.reply) };
      });
  }

  private match(message: string): string | null {
    // While a destructive-op confirmation is waiting for a spoken yes/no,
    // nothing may be swallowed by a canned reply — "cancel that" answered from
    // the bank would leave the gate armed for a later stray "yes".
    if (this.hasAnyPendingConfirmation()) return null;
    const m = normalize(message);
    if (!m) return null;
    for (const i of this.compiled) {
      if (i.phrases.has(m) || i.pattern?.test(m)) {
        log("info", `quick intent: "${m.slice(0, 60)}" answered from the bank`);
        const reply = i.replies[Math.min(i.replies.length - 1, Math.floor(this.random() * i.replies.length))]!;
        return render(reply, this.now());
      }
    }
    return null;
  }

  async send(message: string, options?: BrainTurnOptions): Promise<string> {
    const hit = this.match(message);
    this.hit = hit !== null;
    return hit ?? this.inner.send(message, options);
  }

  async *sendStream(message: string, options?: BrainTurnOptions): AsyncIterable<string> {
    const hit = this.match(message);
    this.hit = hit !== null;
    if (hit !== null) { yield hit; return; }
    if (this.inner.sendStream) yield* this.inner.sendStream(message, options);
    else yield await this.inner.send(message, options);
  }

  get streamProgress(): Brain["streamProgress"] {
    if (!bindBrainCapability(this.inner, "streamProgress")) return undefined;
    return (message: string): AsyncIterable<string> => this.sendProgress(message);
  }
  get sendToTab(): Brain["sendToTab"] { return bindBrainCapability(this.inner, "sendToTab"); }
  get switchTab(): Brain["switchTab"] { return bindBrainCapability(this.inner, "switchTab"); }
  get getTargetTab(): Brain["getTargetTab"] { return bindBrainCapability(this.inner, "getTargetTab"); }
  get activeLane(): Brain["activeLane"] { return bindBrainCapability(this.inner, "activeLane"); }
  get transferTo(): Brain["transferTo"] { return bindBrainCapability(this.inner, "transferTo"); }
  get activeLaneVoice(): Brain["activeLaneVoice"] { return bindBrainCapability(this.inner, "activeLaneVoice"); }
  get setCallMeHandler(): Brain["setCallMeHandler"] { return bindBrainCapability(this.inner, "setCallMeHandler"); }
  /** Background turns are never quick-intent material — straight to the inner brain. */
  sendBackground(message: string, options?: BackgroundTurnOptions): Promise<string> { return sendUnattended(this.inner, message, options); }
  get hasPendingConfirmation(): Brain["hasPendingConfirmation"] {
    if (!this.inner.hasPendingConfirmation && !this.inner.pendingConfirmations) return undefined;
    return (): boolean => this.hasAnyPendingConfirmation();
  }
  get pendingConfirmations(): Brain["pendingConfirmations"] { return bindBrainCapability(this.inner, "pendingConfirmations"); }
  get resolvePendingConfirmation(): Brain["resolvePendingConfirmation"] { return bindBrainCapability(this.inner, "resolvePendingConfirmation"); }
  /** An intent hit is a control-plane answer (never TLDR-gated); misses defer to the inner brain. */
  wasControlTurn(): boolean { return this.hit || (this.inner.wasControlTurn?.() ?? false); }
  private hit = false;

  private hasAnyPendingConfirmation(): boolean {
    return (this.inner.hasPendingConfirmation?.() ?? false) || (this.inner.pendingConfirmations?.().length ?? 0) > 0;
  }

  private async *sendProgress(message: string): AsyncIterable<string> {
    try {
      const hit = this.match(message);
      this.hit = hit !== null;
      if (hit !== null) {
        yield hit;
        return;
      }
      const progress = bindBrainCapability(this.inner, "streamProgress");
      if (progress) {
        yield* progress(message);
      } else if (this.inner.sendStream) {
        yield* this.inner.sendStream(message);
      } else {
        yield await this.inner.send(message);
      }
    } catch (error) {
      throw error;
    }
  }

  start(): Promise<void> { return this.inner.start(); }
  stop(): Promise<void> { return this.inner.stop(); }
  restart(): Promise<void> { return this.inner.restart(); }
  health(): Promise<boolean> { return this.inner.health(); }
  injectContext(context: string): void { this.inner.injectContext(context); }
}
