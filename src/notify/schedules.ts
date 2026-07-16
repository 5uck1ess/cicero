import { log } from "../logger";
import { dayOf, hmOf, inQuietHours, parseHm, type QuietHoursConfig } from "./briefing";

/**
 * Scheduled prompts: daily unattended brain turns ("draft today's content
 * ideas", "summarize what changed upstream") whose replies are texted to the
 * operator. The scheduler owns the clock and delivery discipline; WHAT gets
 * asked and WHERE the answer goes are injected, so tests never need a real
 * brain, Telegram, or wall clock.
 *
 * Quiet hours hold delivery, not the work: a schedule that fires inside the
 * quiet window still runs its turn, and the rendered text is released as soon
 * as the window ends.
 */
export interface PromptScheduleDef {
  name?: string;  // header + log label; defaults to "scheduled prompt N"
  at: string;     // HH:MM in notify.timezone
  prompt: string; // sent verbatim as one brain turn
  lane?: string;  // lane switchboards: run on this named lane instead of the front desk
}

/** Absolute deadline for one unattended turn — research turns are slow, but never unbounded. */
export const SCHEDULE_TURN_TIMEOUT_MS = 10 * 60_000;
/** Retained-reply bound: three Telegram messages' worth. The brain's output is untrusted input. */
export const SCHEDULE_MAX_REPLY_CHARS = 12_000;
const TICK_MS = 20_000;
/** Bound on texts held through quiet hours (each already reply-bounded). */
const MAX_HELD = 8;

interface PromptSchedulerOptions {
  schedules: PromptScheduleDef[];
  timezone?: string;
  quietHours?: QuietHoursConfig;
  /** One unattended brain turn. The signal carries the absolute deadline and shutdown. */
  ask: (schedule: PromptScheduleDef, signal: AbortSignal) => Promise<string>;
  /** Deliver one rendered text (caller chunks for the transport). Throw = logged, dropped. */
  deliver: (text: string) => Promise<void>;
  now?: () => Date;
  tickMs?: number;
  turnTimeoutMs?: number;
}

export function scheduleLabel(schedule: PromptScheduleDef, index: number): string {
  return schedule.name?.trim() || `scheduled prompt ${index + 1}`;
}

export class PromptScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Day stamp of the last firing per schedule — one firing per day, even across DST oddities. */
  private readonly lastFired = new Map<number, string>();
  private readonly inFlight = new Set<number>();
  /** Rendered texts held through quiet hours, released oldest-first. */
  private held: string[] = [];
  /** Owns every in-flight turn; stop() aborts them all. */
  private readonly scope = new AbortController();
  private readonly now: () => Date;
  private readonly tickMs: number;
  private readonly turnTimeoutMs: number;

  constructor(private readonly opts: PromptSchedulerOptions) {
    this.now = opts.now ?? (() => new Date());
    this.tickMs = opts.tickMs ?? TICK_MS;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? SCHEDULE_TURN_TIMEOUT_MS;
    for (const s of opts.schedules) parseHm(s.at); // malformed times fail at startup, not at fire time
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.scope.signal.aborted) this.scope.abort(new Error("prompt scheduler stopped"));
    this.held = [];
  }

  /** Cached clock/config view only; never runs a prompt or performs delivery. */
  snapshot(): PromptScheduleSnapshot {
    const now = this.now();
    const day = dayOf(now, this.opts.timezone);
    const minute = parseHm(hmOf(now, this.opts.timezone));
    const candidates = this.opts.schedules.map((schedule, index) => {
      const atMinute = parseHm(schedule.at);
      const firedToday = this.lastFired.get(index) === day;
      const today = !firedToday && atMinute >= minute;
      return {
        index,
        offset: today ? atMinute - minute : (24 * 60 - minute) + atMinute,
        day: today ? "today" as const : "tomorrow" as const,
        schedule,
      };
    }).sort((a, b) => a.offset - b.offset || a.index - b.index);
    const next = candidates[0];
    return {
      asOfMs: now.getTime(),
      heldCount: this.held.length,
      inFlightCount: this.inFlight.size,
      next: next ? {
        name: scheduleLabel(next.schedule, next.index).slice(0, 160),
        at: next.schedule.at,
        day: next.day,
        lane: next.schedule.lane?.slice(0, 128),
      } : null,
    };
  }

  /** One clock tick: release quiet-held texts, then fire any schedule whose minute this is. */
  tick(): void {
    const now = this.now();
    const quiet = this.quietAt(now);
    if (!quiet && this.held.length > 0) {
      const batch = this.held;
      this.held = [];
      for (const text of batch) {
        void this.opts.deliver(text).catch((err: unknown) => {
          this.warn(`quiet-held scheduled text failed to deliver: ${message(err)}`);
        });
      }
    }
    const hm = hmOf(now, this.opts.timezone);
    const day = dayOf(now, this.opts.timezone);
    this.opts.schedules.forEach((s, i) => {
      if (s.at !== hm || this.lastFired.get(i) === day || this.inFlight.has(i)) return;
      this.lastFired.set(i, day); // failures wait for tomorrow's firing, not a tight retry loop
      this.inFlight.add(i);
      void this.run(s, i, day).finally(() => this.inFlight.delete(i));
    });
  }

  private async run(schedule: PromptScheduleDef, index: number, day: string): Promise<void> {
    const label = scheduleLabel(schedule, index);
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error(`scheduled prompt timed out after ${this.turnTimeoutMs}ms`)),
      this.turnTimeoutMs,
    );
    try {
      log("info", `💡 scheduled prompt "${label}" firing${schedule.lane ? ` on lane ${schedule.lane}` : ""}`);
      const signal = AbortSignal.any([this.scope.signal, deadline.signal]);
      let reply = (await this.opts.ask(schedule, signal)).trim();
      if (this.scope.signal.aborted) return;
      if (!reply) {
        this.warn(`scheduled prompt "${label}" produced an empty reply — nothing to send`);
        return;
      }
      if (reply.length > SCHEDULE_MAX_REPLY_CHARS) {
        reply = `${reply.slice(0, SCHEDULE_MAX_REPLY_CHARS)}\n… (truncated)`;
      }
      const text = `💡 ${label} — ${day}\n\n${reply}`;
      if (this.quietAt(this.now())) {
        this.held.push(text);
        if (this.held.length > MAX_HELD) {
          this.held.shift();
          this.warn("quiet-held scheduled texts overflowed — dropped the oldest");
        }
        log("ok", `💡 scheduled prompt "${label}" ready — holding for the end of quiet hours`);
        return;
      }
      await this.opts.deliver(text);
      log("ok", `💡 scheduled prompt "${label}" delivered`);
    } catch (err: unknown) {
      if (this.scope.signal.aborted) return;
      this.warn(`scheduled prompt "${label}" failed: ${message(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private quietAt(now: Date): boolean {
    return this.opts.quietHours ? inQuietHours(now, this.opts.quietHours, this.opts.timezone) : false;
  }

  private warn(text: string): void {
    log("warn", text);
  }
}

export interface PromptScheduleSnapshot {
  asOfMs: number;
  heldCount: number;
  inFlightCount: number;
  next: { name: string; at: string; day: "today" | "tomorrow"; lane?: string } | null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
