/** Bounded, transcript-free web conversation latency records. */
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ciceroHome } from "./platform/paths";
import { PRIVATE_FILE_MODE, ensurePrivateDirectorySync, ensurePrivateFileIfExistsSync } from "./platform/secure-storage";
import type { ClientMetric } from "./web-voice/protocol";

export type LatencySurface = "web_voice" | "web_text";
export interface LatencyRecord {
  sessionId: string; turnId: string; surface: LatencySurface; at: number;
  inputBytes?: number; inputChars?: number;
  serverMarksMs?: Record<string, number>;
  speechEndToReplyMs?: number; speechEndToFillerMs?: number;
  sttMs?: number; brainFirstTokenMs?: number; ttsFirstAudioMs?: number;
  sttFirstPartialMs?: number; sttSource?: "streaming" | "batch_fallback";
  cancellationSettlementMs?: number; interrupted: boolean; parked: boolean;
  bargeInCount?: number;
}
const MAX_MS = 300_000;
const validMs = (n: number | undefined): number | undefined => n !== undefined && Number.isFinite(n) && n >= 0 && n <= MAX_MS ? Math.round(n) : undefined;

export class LatencyTurn {
  private sttFirstPartialMs: number | undefined;
  private sttSource: "streaming" | "batch_fallback" | undefined;
  private marks = new Map<string, number>();
  private clientMarks = new Map<"speech_end" | "first_audio_played" | "first_filler_played", number>();
  private abortAt: number | undefined;
  private settledAt: number | undefined;
  private wasInterrupted = false;
  private bargeCount = 0;
  constructor(readonly sessionId: string, readonly turnId: string, readonly surface: LatencySurface, readonly at: number, private readonly clock: () => number = () => performance.now(), private readonly inputLength = 0) {}
  mark(name: string, offsetMs: number): void {
    if (name === "stt_batch_fallback") this.sttSource = "batch_fallback";
    if (this.marks.size < 16 && !this.marks.has(name)) {
      const ms = validMs(offsetMs);
      if (ms !== undefined) this.marks.set(name, ms);
    }
  }
  setStreamingStt(source: "streaming" | "batch_fallback", firstPartialMs?: number): void {
    this.sttSource = source;
    this.sttFirstPartialMs = validMs(firstPartialMs);
  }
  client(metric: ClientMetric): void {
    if (metric.sessionId !== this.sessionId || metric.turnId !== this.turnId) return;
    if (metric.event === "barge_in") { this.bargeCount = Math.min(16, this.bargeCount + 1); this.wasInterrupted = true; return; }
    if (metric.event !== "speech_end" && !this.clientMarks.has("speech_end")) return;
    if (metric.event === "audio_started") return; // resolved by sequence in the transport
    if (!this.clientMarks.has(metric.event)) this.clientMarks.set(metric.event, metric.sinceSpeechEndMs);
  }
  started(kind: "reply" | "filler", sinceSpeechEndMs: number): void {
    if (!this.clientMarks.has("speech_end")) return;
    const ms = validMs(sinceSpeechEndMs);
    if (ms === undefined) return;
    const event = kind === "reply" ? "first_audio_played" : "first_filler_played";
    if (!this.clientMarks.has(event)) this.clientMarks.set(event, ms);
  }
  abort(): void { this.abortAt ??= this.clock(); this.wasInterrupted = true; }
  interrupt(): void { this.wasInterrupted = true; }
  settle(): void { this.settledAt ??= this.clock(); }
  finish(): LatencyRecord {
    this.settle();
    const stt = this.marks.get("stt");
    const brainStart = this.marks.get("brain_start");
    const token = this.marks.get("brain_first_token");
    const sentence = this.marks.get("first_sentence");
    const audio = this.marks.get("first_audio");
    const serverMarksMs: Record<string, number> = {};
    for (const name of ["stt", "brain_start", "brain_first_token", "first_sentence", "first_audio", "filler_queued", "filler_audio", "parked"]) {
      const at = this.marks.get(name);
      if (at !== undefined) serverMarksMs[name] = at;
    }
    return {
      sessionId: this.sessionId, turnId: this.turnId, surface: this.surface, at: this.at,
      ...(this.surface === "web_voice" ? { inputBytes: this.inputLength } : { inputChars: this.inputLength }),
      serverMarksMs,
      ...(this.clientMarks.has("first_audio_played") ? { speechEndToReplyMs: this.clientMarks.get("first_audio_played") } : {}),
      ...(this.clientMarks.has("first_filler_played") ? { speechEndToFillerMs: this.clientMarks.get("first_filler_played") } : {}),
      ...(stt !== undefined ? { sttMs: stt } : {}),
      ...(this.sttFirstPartialMs !== undefined ? { sttFirstPartialMs: this.sttFirstPartialMs } : {}),
      ...(this.sttSource ? { sttSource: this.sttSource } : {}),
      ...(token !== undefined && brainStart !== undefined ? { brainFirstTokenMs: validMs(token - brainStart) } : {}),
      ...(audio !== undefined && sentence !== undefined ? { ttsFirstAudioMs: validMs(audio - sentence) } : {}),
      ...(this.abortAt !== undefined ? { cancellationSettlementMs: validMs(this.settledAt! - this.abortAt) } : {}),
      interrupted: this.wasInterrupted, parked: this.marks.has("parked"),
      ...(this.bargeCount ? { bargeInCount: this.bargeCount } : {}),
    };
  }
}

export interface LatencyScheduler<T> {
  setTimeout(callback: () => void, ms: number): T;
  clearTimeout(handle: T): void;
}
const realScheduler: LatencyScheduler<ReturnType<typeof setTimeout>> = {
  setTimeout(callback, ms) { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; },
  clearTimeout,
};
const MAX_TRACKED_CLIPS = 128;
export const LATENCY_SETTLE_WINDOW_MS = 30_000;

/** One turn owns its clip acks, deadline, and exactly one final record write. */
export class LatencyRecordOwner<T = ReturnType<typeof setTimeout>> {
  private clips = new Map<number, { kind: "reply" | "filler"; acked: boolean }>();
  private overflowed = false;
  private done = false;
  private timer: T | undefined;
  private writeTask: Promise<void> | undefined;
  private pendingSnapshot: (() => LatencyRecord) | undefined;
  finalized = false;
  constructor(
    readonly turn: LatencyTurn,
    private readonly write: (snapshot: () => LatencyRecord) => Promise<void>,
    private readonly scheduler: LatencyScheduler<T> = realScheduler as LatencyScheduler<T>,
    private readonly windowMs = LATENCY_SETTLE_WINDOW_MS,
    private readonly onFinalized?: () => void,
  ) {}
  mark(name: string, offsetMs: number): void { if (!this.finalized) this.turn.mark(name, offsetMs); }
  abort(): void { if (!this.finalized) this.turn.abort(); }
  delivered(sequence: number, kind: "reply" | "filler"): void {
    if (this.finalized || this.writeTask) return;
    if (this.clips.size >= MAX_TRACKED_CLIPS) {
      const acked = [...this.clips].find(([, clip]) => clip.acked)?.[0];
      if (acked !== undefined) this.clips.delete(acked);
      else { this.clips.delete(this.clips.keys().next().value!); this.overflowed = true; }
    }
    this.clips.set(sequence, { kind, acked: false });
  }
  client(metric: ClientMetric): void {
    if (this.finalized || metric.sessionId !== this.turn.sessionId || metric.turnId !== this.turn.turnId) return;
    if (metric.event === "audio_started") {
      const clip = this.clips.get(metric.sequence!);
      if (clip) this.turn.started(clip.kind, metric.sinceSpeechEndMs);
    } else this.turn.client(metric);
  }
  ack(sequence: number, status: "played" | "interrupted"): void {
    if (this.finalized) return;
    const clip = this.clips.get(sequence);
    if (!clip || clip.acked) return;
    clip.acked = true;
    if (status === "interrupted") this.turn.interrupt();
    this.maybeWrite();
  }
  interruptOutstanding(): void {
    if (this.finalized) return;
    for (const clip of this.clips.values()) if (!clip.acked) { clip.acked = true; this.turn.interrupt(); }
    this.overflowed = false;
    this.maybeWrite();
  }
  serverSettled(): void {
    if (this.done || this.finalized) return;
    this.done = true;
    this.turn.settle();
    if (this.clips.size === 0 || (!this.overflowed && [...this.clips.values()].every((clip) => clip.acked))) this.maybeWrite();
    else this.timer = this.scheduler.setTimeout(() => { this.timer = undefined; this.scheduleWrite(); }, this.windowMs);
  }
  /** Shutdown/eviction: close the ack window after server work has settled. */
  forceFinalize(): void {
    if (this.done) { this.scheduleWrite(); this.pendingSnapshot?.(); }
    else this.interruptOutstanding();
  }
  flush(): Promise<void> { return this.writeTask ?? Promise.resolve(); }
  private maybeWrite(): void {
    if (this.done && !this.overflowed && [...this.clips.values()].every((clip) => clip.acked)) this.scheduleWrite();
  }
  private scheduleWrite(): void {
    if (this.writeTask || this.finalized || !this.done) return;
    if (this.timer !== undefined) { this.scheduler.clearTimeout(this.timer); this.timer = undefined; }
    let snapshotValue: LatencyRecord | undefined;
    const snapshot = (): LatencyRecord => {
      if (!snapshotValue) {
        this.finalized = true;
        snapshotValue = this.turn.finish();
        this.onFinalized?.();
      }
      return snapshotValue;
    };
    this.pendingSnapshot = snapshot;
    try {
      this.writeTask = Promise.resolve(this.write(snapshot)).finally(() => { snapshot(); });
    } catch (error) {
      snapshot();
      this.writeTask = Promise.reject(error);
    }
  }
}

/** Register at input admission, before a pending turn can receive client metrics. */
export function admitLatencyOwner<T = ReturnType<typeof setTimeout>>(
  owners: Map<string, LatencyRecordOwner<T>>,
  turn: LatencyTurn,
  write: (snapshot: () => LatencyRecord) => Promise<void>,
  scheduler?: LatencyScheduler<T>,
): LatencyRecordOwner<T> {
  if (owners.size >= 32) {
    const oldestId = owners.keys().next().value!;
    owners.get(oldestId)?.forceFinalize();
    owners.delete(oldestId);
  }
  let owner!: LatencyRecordOwner<T>;
  owner = new LatencyRecordOwner(turn, write, scheduler, undefined,
    () => { if (owners.get(turn.turnId) === owner) owners.delete(turn.turnId); });
  owners.set(turn.turnId, owner);
  return owner;
}

/** A queued turn has no handler that can settle its record later. */
export function dropPendingLatencyOwner<T>(owners: Map<string, LatencyRecordOwner<T>>, turnId: string, owner?: LatencyRecordOwner<T>): void {
  if (!owner) return;
  owner.abort();
  owner.serverSettled();
  owner.forceFinalize();
  if (owners.get(turnId) === owner) owners.delete(turnId);
}

export interface Percentiles { count: number; p50: number; p95: number }
export const METRICS = ["speechEndToReplyMs", "speechEndToFillerMs", "sttMs", "brainFirstTokenMs", "ttsFirstAudioMs", "cancellationSettlementMs"] as const;
export function percentile(values: number[], fraction: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}
export type LatencySummary = Record<LatencySurface, Partial<Record<typeof METRICS[number], Percentiles>>>;
export function summarizeLatency(records: readonly LatencyRecord[]): LatencySummary {
  const out: LatencySummary = { web_voice: {}, web_text: {} };
  for (const surface of ["web_voice", "web_text"] as const) for (const metric of METRICS) {
    const values = records.filter((r) => r.surface === surface).map((r) => r[metric]).filter((n): n is number => n !== undefined && Number.isFinite(n));
    if (values.length) out[surface][metric] = { count: values.length, p50: percentile(values, 0.5)!, p95: percentile(values, 0.95)! };
  }
  return out;
}
const LABELS: Record<typeof METRICS[number], string> = {
  speechEndToReplyMs: "speech_end→reply", speechEndToFillerMs: "speech_end→filler", sttMs: "STT", brainFirstTokenMs: "brain first token", ttsFirstAudioMs: "TTS first audio", cancellationSettlementMs: "cancellation settle",
};
export function formatLatency(summary: LatencySummary): string {
  const lines = ["surface  metric  n  p50 ms  p95 ms"];
  for (const surface of ["web_voice", "web_text"] as const) for (const metric of METRICS) {
    const p = summary[surface][metric];
    if (p) lines.push(`${surface}  ${LABELS[metric]}  ${p.count}  ${p.p50}  ${p.p95}`);
  }
  return lines.join("\n") + "\n";
}

export interface RingLimits { segmentCount: number; rowsPerSegment: number; bytesPerSegment: number }
const DEFAULT_LIMITS: RingLimits = { segmentCount: 4, rowsPerSegment: 256, bytesPerSegment: 128 * 1024 };
export class LatencyStore {
  private pending: Promise<void> = Promise.resolve();
  private limits: RingLimits;
  constructor(private readonly dir = join(ciceroHome(), "latency"), limits: Partial<RingLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (dir === join(ciceroHome(), "latency")) ensurePrivateDirectorySync(ciceroHome());
    ensurePrivateDirectorySync(dir);
  }
  private path(index: number): string { return join(this.dir, `turns.${index}.jsonl`); }
  async append(record: LatencyRecord): Promise<void> {
    return this.appendLazy(() => record);
  }
  /** Snapshot only when this write reaches the head of the serialized ring. */
  async appendLazy(snapshot: () => LatencyRecord): Promise<void> {
    const task = this.pending.catch(() => {}).then(() => this.write(snapshot));
    this.pending = task;
    return task;
  }
  private async readSegment(index: number): Promise<string> {
    const path = this.path(index);
    if (!ensurePrivateFileIfExistsSync(path)) return "";
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    let file: Awaited<ReturnType<typeof open>>;
    try { file = await open(path, constants.O_RDONLY | noFollow); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; // rotated after the lstat
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > this.limits.bytesPerSegment) throw new Error("unsafe latency segment size");
      const buf = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buf.length) {
        const got = await file.read(buf, offset, buf.length - offset, offset);
        if (!got.bytesRead) break;
        offset += got.bytesRead;
      }
      return buf.subarray(0, offset).toString("utf8");
    } finally { await file.close(); }
  }
  private async write(snapshot: () => LatencyRecord): Promise<void> {
    const head = await this.readSegment(0);
    const line = JSON.stringify(snapshot()) + "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > this.limits.bytesPerSegment) throw new Error("latency record exceeds segment limit");
    if (Buffer.byteLength(head) + bytes > this.limits.bytesPerSegment || (head.match(/\n/g)?.length ?? 0) >= this.limits.rowsPerSegment) {
      for (let i = this.limits.segmentCount - 1; i >= 1; i--) {
        const previous = this.path(i - 1), next = this.path(i);
        ensurePrivateFileIfExistsSync(previous);
        if (ensurePrivateFileIfExistsSync(next)) await unlink(next);
        try { await rename(previous, next); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    const path = this.path(0);
    ensurePrivateFileIfExistsSync(path);
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow, PRIVATE_FILE_MODE);
    try { await file.writeFile(line); } finally { await file.close(); }
  }
  async read(last = 100): Promise<LatencyRecord[]> {
    await this.pending;
    const limit = Number.isSafeInteger(last) ? Math.max(1, Math.min(last, this.limits.segmentCount * this.limits.rowsPerSegment)) : 100;
    const rows: LatencyRecord[] = [];
    for (let i = this.limits.segmentCount - 1; i >= 0; i--) {
      const lines = (await this.readSegment(i)).split("\n");
      for (const line of lines) {
        if (!line || line.length > 2048) continue;
        try {
          const row = JSON.parse(line) as LatencyRecord;
          if (typeof row.sessionId === "string" && typeof row.turnId === "string" && (row.surface === "web_voice" || row.surface === "web_text") && Number.isFinite(row.at)) rows.push(row);
        } catch { /* torn line */ }
      }
    }
    const latest = new Map<string, LatencyRecord>();
    for (const row of rows) latest.set(`${row.sessionId}\0${row.turnId}`, row);
    return [...latest.values()].slice(-limit);
  }
}
