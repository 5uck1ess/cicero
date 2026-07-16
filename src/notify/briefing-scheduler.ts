import { lstat, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PrivateJsonTooLargeError, readPrivateJson, writePrivateJson } from "../platform/private-json";
import { ensurePrivateDirectorySync, ensurePrivateFileIfExistsSync } from "../platform/secure-storage";
import { log } from "../logger";
import { dayOf, hmOf, inQuietHours, parseHm, type QuietHoursConfig } from "./briefing";

export type BriefingTrigger = "scheduled" | "catch-up";
export type BriefingPhase = "claimed" | "delivered" | "partial" | "failed" | "missed";
export type BriefingCompletedPhase = Exclude<BriefingPhase, "claimed">;
export type BriefingDeliveryGate = () => void;

export interface BriefingRunStatus {
  day: string;
  scheduledAt: string;
  trigger: BriefingTrigger;
  claimedAt: number;
  completedAt?: number;
  phase: BriefingPhase;
  channels?: { telegram?: string; voice?: string; callback?: string };
  deferredCount?: number;
  contentSummary?: string;
  errorKind?: string;
}

export interface BriefingRunResult {
  phase: BriefingCompletedPhase;
  channels?: BriefingRunStatus["channels"];
  deferredCount?: number;
  contentSummary?: string;
  errorKind?: string;
}

export interface BriefingSchedulerOptions {
  at: string;
  catchUpMinutes: number;
  timezone?: string;
  quietHours?: QuietHoursConfig;
  now?: () => Date;
  run: (trigger: BriefingTrigger, signal: AbortSignal, beforeDelivery: BriefingDeliveryGate) => Promise<BriefingRunResult>;
  store: BriefingStatusStore;
  tickMs?: number;
}

export interface BriefingScheduleSnapshot {
  running: boolean;
  inFlight: boolean;
  status: BriefingRunStatus | null;
}

export type BriefingOperationalRead =
  | { status: "ok"; value: BriefingRunStatus | null }
  | { status: "unavailable" };

type BriefingStoreRead =
  | { status: "ok"; value: BriefingRunStatus | null }
  | { status: "unavailable"; error?: unknown };

const TICK_MS = 20_000;
const MAX_SUMMARY_CHARS = 500;
const MAX_ERROR_KIND_CHARS = 64;
const MINUTE_MS = 60_000;

export function briefingStatusFilePath(): string {
  return join(homedir(), ".cicero", "briefing-status.json");
}

/** One-record durable daily latch. A claim is never silently retried that day. */
export class BriefingStatusStore {
  private pending: Promise<void> = Promise.resolve();
  private corruptWarningIssued = false;
  // Day (in the configured briefing timezone, matching quarantineCorrupt) on
  // which we last quarantined a corrupt
  // record. Quarantine renames the bad file away, so a later same-day read would
  // see an absent file and wrongly report "not run today"; this latch keeps
  // reporting "unavailable" for the rest of that day. Self-expires at day
  // rollover and clears once a valid record is read.
  private corruptedDay: string | null = null;

  constructor(
    private readonly file: string = briefingStatusFilePath(),
    private readonly timeZone?: string,
  ) {
    ensurePrivateDirectorySync(dirname(file));
    ensurePrivateFileIfExistsSync(file);
  }

  read(): Promise<BriefingRunStatus | null> {
    return this.serialize(async () => this.readUnserialized());
  }

  /** Read for reporting without collapsing corrupt or unreadable state into absence. */
  readOperational(): Promise<BriefingOperationalRead> {
    return this.serialize(async () => {
      const result = await this.readResultUnserialized();
      return result.status === "ok" ? result : { status: "unavailable" };
    });
  }

  claim(status: BriefingRunStatus): Promise<boolean> {
    return this.serialize(async () => {
      const current = await this.readUnserialized();
      if (current?.day === status.day) return false;
      await writePrivateJson(this.file, normalizeStatus(status));
      return true;
    });
  }

  complete(status: BriefingRunStatus): Promise<void> {
    return this.serialize(async () => {
      const current = await this.readUnserialized();
      if (current?.day !== status.day) throw new Error("briefing claim no longer owns today's status");
      await writePrivateJson(this.file, normalizeStatus(status));
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => {}).then(operation);
    this.pending = result.then(() => {}, () => {});
    return result;
  }

  private async readUnserialized(): Promise<BriefingRunStatus | null> {
    const result = await this.readResultUnserialized();
    if (result.status === "ok") return result.value;
    if (result.error !== undefined) throw result.error;
    return null;
  }

  private async readResultUnserialized(): Promise<BriefingStoreRead> {
    let value: unknown | undefined;
    try {
      value = await readPrivateJson(this.file);
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError) && !(error instanceof PrivateJsonTooLargeError)) {
        return { status: "unavailable", error };
      }
      await this.quarantineCorrupt();
      return { status: "unavailable" };
    }
    if (value === undefined) {
      // Absent file: genuinely not-run, UNLESS we quarantined a corrupt record
      // earlier today — including in a previous process — then we truly don't
      // know, so keep reporting unavailable.
      const today = dayOf(new Date(), this.timeZone);
      if (this.corruptedDay === today) return { status: "unavailable" };
      try {
        if (await this.hasCorruptArtifact(today)) return { status: "unavailable" };
      } catch (error: unknown) {
        return { status: "unavailable", error };
      }
      return { status: "ok", value: null };
    }
    try {
      if (!isStatus(value)) throw new TypeError("invalid briefing status");
      const normalized = normalizeStatus(value);
      this.corruptWarningIssued = false;
      this.corruptedDay = null;
      return { status: "ok", value: normalized };
    } catch {
      await this.quarantineCorrupt();
      return { status: "unavailable" };
    }
  }

  private async hasCorruptArtifact(day: string): Promise<boolean> {
    for (let counter = 0; counter < 100; counter++) {
      const suffix = counter === 0 ? day : `${day}-${counter}`;
      try {
        await lstat(`${this.file}.corrupt-${suffix}`);
        return true;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return false;
  }

  private async quarantineCorrupt(): Promise<void> {
    const day = dayOf(new Date(), this.timeZone);
    this.corruptedDay = day;
    let quarantined = false;
    for (let counter = 0; counter < 100; counter++) {
      const suffix = counter === 0 ? day : `${day}-${counter}`;
      const candidate = `${this.file}.corrupt-${suffix}`;
      try {
        await lstat(candidate);
        continue;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      try {
        await rename(this.file, candidate);
        quarantined = true;
        break;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      }
    }
    if (!quarantined) {
      try { await unlink(this.file); } catch { /* best-effort corrupt-file removal */ }
    }
    if (!this.corruptWarningIssued) {
      this.corruptWarningIssued = true;
      log("warn", "morning briefing status file was corrupt and was quarantined");
    }
  }
}

export class BriefingScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly scope = new AbortController();
  private readonly now: () => Date;
  private tickPromise: Promise<void> | null = null;
  private runPromise: Promise<void> | null = null;
  private lastStatus: BriefingRunStatus | null = null;

  constructor(private readonly opts: BriefingSchedulerOptions) {
    parseHm(opts.at);
    if (!Number.isInteger(opts.catchUpMinutes) || opts.catchUpMinutes < 0 || opts.catchUpMinutes > 720) {
      throw new Error("briefing catchUpMinutes must be an integer from 0 to 720");
    }
    if (opts.timezone) hmOf(this.nowDate(opts.now), opts.timezone);
    if (opts.quietHours) {
      parseHm(opts.quietHours.from);
      parseHm(opts.quietHours.to);
    }
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer || this.scope.signal.aborted) return;
    const tick = () => {
      void this.tick().catch(() => {
        if (!this.scope.signal.aborted) log("warn", "morning briefing scheduler tick failed");
      });
    };
    tick();
    this.timer = setInterval(tick, this.opts.tickMs ?? TICK_MS);
  }

  tick(): Promise<void> {
    if (this.scope.signal.aborted) return Promise.resolve();
    if (this.tickPromise) return this.tickPromise;
    const ticking = this.tickOnce().finally(() => {
      if (this.tickPromise === ticking) this.tickPromise = null;
    });
    this.tickPromise = ticking;
    return ticking;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.scope.signal.aborted) this.scope.abort(new Error("briefing scheduler stopped"));
    await Promise.allSettled([this.tickPromise, this.runPromise].filter((p): p is Promise<void> => p !== null));
  }

  snapshot(): BriefingScheduleSnapshot {
    return { running: this.timer !== undefined, inFlight: this.runPromise !== null, status: this.lastStatus };
  }

  private async tickOnce(): Promise<void> {
    const now = this.now();
    const window = briefingWindow(now, this.opts.at, this.opts.catchUpMinutes, this.opts.timezone);
    if (window.elapsedMs < 0 || !window.sameLocalDay) return;

    const current = await this.opts.store.read();
    this.lastStatus = current;
    if (this.scope.signal.aborted || current?.day === window.day) return;

    if (window.pastCutoff) {
      const missed = this.baseStatus(window.day, "catch-up", now, "missed");
      missed.completedAt = now.getTime();
      if (await this.opts.store.claim(missed)) this.lastStatus = missed;
      return;
    }
    // Degenerate schedules inside quiet hours may never persist "missed"; that
    // informational gap is accepted because delivery stays blocked and morning times are the supported configuration.
    if (this.opts.quietHours && inQuietHours(now, this.opts.quietHours, this.opts.timezone)) return;

    const trigger: BriefingTrigger = window.scheduledMinute ? "scheduled" : "catch-up";
    const claimed = this.baseStatus(window.day, trigger, now, "claimed");
    if (!await this.opts.store.claim(claimed)) {
      this.lastStatus = await this.opts.store.read();
      return;
    }
    this.lastStatus = claimed;
    if (this.scope.signal.aborted) return;

    const running = this.runClaim(claimed, trigger).finally(() => {
      if (this.runPromise === running) this.runPromise = null;
    });
    this.runPromise = running;
    await running;
  }

  private async runClaim(claimed: BriefingRunStatus, trigger: BriefingTrigger): Promise<void> {
    const deliveryWindow = new AbortController();
    const signal = AbortSignal.any([this.scope.signal, deliveryWindow.signal]);
    const beforeDelivery = (): void => {
      signal.throwIfAborted();
      const now = this.now();
      const window = briefingWindow(now, this.opts.at, this.opts.catchUpMinutes, this.opts.timezone);
      const closed = window.day !== claimed.day
        || !window.eligible
        || Boolean(this.opts.quietHours && inQuietHours(now, this.opts.quietHours, this.opts.timezone));
      if (closed) deliveryWindow.abort(new Error("briefing delivery window closed"));
      signal.throwIfAborted();
    };
    let result: BriefingRunResult;
    try {
      // The window is checked immediately before delivery begins; TTS may finish just past a boundary.
      // That accepted slip is immaterial for realistic morning windows, where synthesis takes only seconds.
      beforeDelivery();
      result = await this.opts.run(trigger, signal, beforeDelivery);
    } catch {
      if (this.scope.signal.aborted) return;
      result = deliveryWindow.signal.aborted
        ? { phase: "missed", errorKind: "delivery-window-closed" }
        : { phase: "failed", errorKind: "run-failed" };
    }
    // A stop during complete() may persist today's accurate status a moment late. The store's day
    // guard confines it to today's claim and prevents resend, so we accept that instead of a second write lock.
    if (this.scope.signal.aborted) return;
    const completed: BriefingRunStatus = normalizeStatus({
      ...claimed,
      ...result,
      day: claimed.day,
      scheduledAt: claimed.scheduledAt,
      trigger: claimed.trigger,
      claimedAt: claimed.claimedAt,
      completedAt: this.now().getTime(),
    });
    await this.opts.store.complete(completed);
    this.lastStatus = completed;
  }

  private baseStatus(day: string, trigger: BriefingTrigger, now: Date, phase: BriefingPhase): BriefingRunStatus {
    return { day, scheduledAt: this.opts.at, trigger, claimedAt: now.getTime(), phase };
  }

  private nowDate(now: (() => Date) | undefined): Date {
    return now ? now() : new Date();
  }
}

interface BriefingWindow {
  day: string;
  elapsedMs: number;
  eligible: boolean;
  pastCutoff: boolean;
  sameLocalDay: boolean;
  scheduledMinute: boolean;
}

export function briefingWindow(now: Date, at: string, catchUpMinutes: number, timeZone?: string): BriefingWindow {
  const day = dayOf(now, timeZone);
  const scheduled = scheduledInstantForToday(now, at, timeZone);
  const elapsedMs = now.getTime() - scheduled.getTime();
  const sameLocalDay = dayOf(scheduled, timeZone) === day;
  const cutoffMs = catchUpMinutes === 0 ? MINUTE_MS : catchUpMinutes * MINUTE_MS;
  const beforeOrAtCutoff = catchUpMinutes === 0 ? elapsedMs < cutoffMs : elapsedMs <= cutoffMs;
  return {
    day,
    elapsedMs,
    eligible: sameLocalDay && elapsedMs >= 0 && beforeOrAtCutoff,
    pastCutoff: sameLocalDay && (catchUpMinutes === 0 ? elapsedMs >= cutoffMs : elapsedMs > cutoffMs),
    sameLocalDay,
    scheduledMinute: parseHm(hmOf(now, timeZone)) === parseHm(at),
  };
}

function scheduledInstantForToday(now: Date, at: string, timeZone?: string): Date {
  const minute = parseHm(at);
  const hour = Math.floor(minute / 60);
  const minuteOfHour = minute % 60;
  if (!timeZone) return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minuteOfHour);

  const requestedDay = dayOf(now, timeZone);
  const [year, month, date] = requestedDay.split("-").map(Number);
  const wallTimeAsUtc = Date.UTC(year, month - 1, date, hour, minuteOfHour);
  const firstCandidate = wallTimeAsUtc - timeZoneOffsetMs(new Date(wallTimeAsUtc), timeZone);
  const correctedCandidate = wallTimeAsUtc - timeZoneOffsetMs(new Date(firstCandidate), timeZone);
  const correctedInstant = new Date(correctedCandidate);
  const isGap = firstCandidate !== correctedCandidate
    && (dayOf(correctedInstant, timeZone) !== requestedDay || parseHm(hmOf(correctedInstant, timeZone)) !== minute);
  // A nonexistent wall time straddles the DST gap; use its later real candidate so it cannot fire early.
  const epochMs = isGap ? Math.max(firstCandidate, correctedCandidate) : correctedCandidate;
  return new Date(epochMs);
}

function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const [year, month, date] = dayOf(instant, timeZone).split("-").map(Number);
  const minute = parseHm(hmOf(instant, timeZone));
  const localAsUtc = Date.UTC(year, month - 1, date, Math.floor(minute / 60), minute % 60);
  return localAsUtc - instant.getTime();
}

function normalizeStatus(status: BriefingRunStatus): BriefingRunStatus {
  return {
    ...status,
    contentSummary: status.contentSummary?.slice(0, MAX_SUMMARY_CHARS),
    errorKind: sanitizeErrorKind(status.errorKind),
  };
}

function sanitizeErrorKind(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.slice(0, MAX_ERROR_KIND_CHARS) || "unknown";
}

function isStatus(value: unknown): value is BriefingRunStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Partial<BriefingRunStatus>;
  const channels = status.channels;
  return typeof status.day === "string"
    && typeof status.scheduledAt === "string"
    && (status.trigger === "scheduled" || status.trigger === "catch-up")
    && typeof status.claimedAt === "number"
    && (status.phase === "claimed" || status.phase === "delivered" || status.phase === "partial"
      || status.phase === "failed" || status.phase === "missed")
    && (status.completedAt === undefined || typeof status.completedAt === "number")
    && (status.deferredCount === undefined || typeof status.deferredCount === "number")
    && (status.contentSummary === undefined || typeof status.contentSummary === "string")
    && (status.errorKind === undefined || typeof status.errorKind === "string")
    && (channels === undefined || (channels !== null && typeof channels === "object" && !Array.isArray(channels)
      && Object.values(channels).every((channel) => typeof channel === "string")));
}
