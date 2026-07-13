import type { TerminalAdapter } from "../types";
import { log } from "../logger";
import type { SpeakAdapter, SpeakService } from "./types";

export interface TerminalScrapeAdapterOptions {
  terminal: TerminalAdapter;
  targetTab: string;
  pollIntervalMs: number;
  quietWindowMs: number;
  promptMarker: RegExp;
  /** After this many consecutive getText failures, health flips to unhealthy. Default 10. */
  unhealthyThreshold?: number;
}

const DEFAULT_UNHEALTHY_THRESHOLD = 10;

export class TerminalScrapeAdapter implements SpeakAdapter {
  readonly name = "terminal-scrape";
  private timer: ReturnType<typeof setInterval> | null = null;
  private service: SpeakService | null = null;
  private lastSnapshot = "";
  private lastChangeAt = 0;
  private pendingResponseStart = -1;
  private consecutiveFailures = 0;
  private lastFailureReason: string | null = null;
  private readonly unhealthyThreshold: number;

  constructor(private opts: TerminalScrapeAdapterOptions) {
    this.unhealthyThreshold = opts.unhealthyThreshold ?? DEFAULT_UNHEALTHY_THRESHOLD;
  }

  async attach(service: SpeakService): Promise<void> {
    this.service = service;
    const initial = await this.tryGetText();
    this.lastSnapshot = initial ?? "";
    this.lastChangeAt = Date.now();
    this.timer = setInterval(() => this.tick().catch(err => {
      log("warn", `terminal-scrape tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }), this.opts.pollIntervalMs);
    log("ok", `Terminal-scrape adapter watching tab "${this.opts.targetTab}"`);
  }

  async detach(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.service = null;
  }

  async health(): Promise<{ ok: boolean; reason?: string }> {
    if (this.timer === null) return { ok: false, reason: "adapter not attached" };
    if (this.consecutiveFailures >= this.unhealthyThreshold) {
      return {
        ok: false,
        reason: `terminal getText failing ${this.consecutiveFailures} ticks in a row: ${this.lastFailureReason ?? "unknown"}`,
      };
    }
    return { ok: true };
  }

  private async tryGetText(): Promise<string | null> {
    try {
      const text = await this.opts.terminal.getText(this.opts.targetTab, "screen");
      if (this.consecutiveFailures > 0) {
        log("ok", `terminal-scrape recovered after ${this.consecutiveFailures} failed reads`);
      }
      this.consecutiveFailures = 0;
      this.lastFailureReason = null;
      return text;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.consecutiveFailures += 1;
      this.lastFailureReason = reason;
      // Log only on transitions: first failure and at the threshold crossing.
      if (this.consecutiveFailures === 1) {
        log("warn", `terminal-scrape getText failed: ${reason}`);
      } else if (this.consecutiveFailures === this.unhealthyThreshold) {
        log("error", `terminal-scrape unhealthy after ${this.unhealthyThreshold} consecutive getText failures: ${reason}`);
      }
      return null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.service) return;
    const now = Date.now();
    const current = await this.tryGetText();
    if (current === null) return; // getText failed — keep snapshot, try again next tick

    if (current !== this.lastSnapshot) {
      if (this.pendingResponseStart === -1) {
        this.pendingResponseStart = this.lastSnapshot.length;
      }
      this.lastSnapshot = current;
      this.lastChangeAt = now;
      return;
    }

    // No change since last tick. Check if we should emit a response.
    if (this.pendingResponseStart === -1) return;
    if (now - this.lastChangeAt < this.opts.quietWindowMs) return;

    const newText = current.substring(this.pendingResponseStart);
    if (!this.opts.promptMarker.test(newText)) return;

    // Strip the trailing prompt from what we speak.
    const responseText = newText.replace(this.opts.promptMarker, "").trim();
    this.pendingResponseStart = -1;

    if (responseText.length > 0) {
      this.service.speak({ text: responseText, agent: "terminal-scrape" }).catch(err => {
        log("warn", `speak failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }
}
