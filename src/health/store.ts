import { constants } from "node:fs";
import { appendFile, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDirectorySync,
  ensurePrivateFileIfExistsSync,
} from "../platform/secure-storage";
import { ciceroHome } from "../platform/paths";

/**
 * The health lane's record: one JSONL line per logged metric, append-only,
 * local-only (~/.cicero/health/metrics.jsonl — speech-adjacent private data,
 * nothing leaves the box). Never trimmed: unlike chat history, a year of
 * weigh-ins is a few hundred KB and the whole point is the long trend.
 *
 * Writers: the health lane via `cicero health log` (a separate process — JSONL
 * appends are atomic enough at these sizes), and the /api/health endpoint
 * (the future phone bridge). Readers: `cicero health recent|trend` and the
 * morning briefing's health line.
 */

export interface HealthEntry {
  t: number;        // epoch ms
  metric: string;   // lowercase slug: "weight", "calories", "sleep", anything
  value?: number;   // numeric metrics; absent for pure notes ("food: chicken bowl")
  unit?: string;
  note?: string;
  source: "cli" | "api";
}

/** Bytes retained by a "recent" read — the 60s summary refresh and recent(n). */
export const HEALTH_READ_TAIL_BYTES = 64 * 1024;

/**
 * Absolute cap on bytes a since()-window read may retain. A time-window query
 * grows its read until the window is covered, but never past this — so a
 * pathologically grown log cannot OOM the daemon while still covering any
 * realistic trend window (~4 MiB is tens of thousands of entries).
 */
export const HEALTH_SINCE_MAX_BYTES = 4 * 1024 * 1024;

/** Units assumed when a log omits one — only for metrics where there's one sane answer. */
export const DEFAULT_UNITS: Record<string, string> = {
  weight: "kg",
  calories: "kcal",
};

export function healthFilePath(): string {
  return join(homedir(), ".cicero", "health", "metrics.jsonl");
}

export class HealthStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(private file: string = healthFilePath()) {
    if (file === healthFilePath()) ensurePrivateDirectorySync(ciceroHome());
    ensurePrivateDirectorySync(dirname(file));
    ensurePrivateFileIfExistsSync(file);
  }

  /** Append an entry (serialized through a chain so concurrent writes can't interleave). */
  append(entry: HealthEntry): Promise<void> {
    this.pending = this.pending.then(() =>
      appendFile(this.file, JSON.stringify(entry) + "\n", { mode: PRIVATE_FILE_MODE }),
    );
    return this.pending;
  }

  /**
   * Entries at or after `sinceMs`, oldest first. Reads from the file tail and
   * grows the read until the window is covered (the oldest entry read predates
   * `sinceMs`, or the whole file was read), capped at HEALTH_SINCE_MAX_BYTES so a
   * runaway log can't OOM the daemon. A small window (the 24h summary refresh)
   * costs one bounded read; a wide trend window reads only as far back as needed.
   */
  async since(sinceMs: number, signal?: AbortSignal): Promise<HealthEntry[]> {
    let maxBytes = HEALTH_READ_TAIL_BYTES;
    for (;;) {
      const { entries, reachedStart } = await this.readTail(maxBytes, signal);
      const oldest = entries[0];
      const covered = reachedStart
        || (oldest !== undefined && oldest.t < sinceMs)
        || maxBytes >= HEALTH_SINCE_MAX_BYTES;
      if (covered) return entries.filter((e) => e.t >= sinceMs);
      maxBytes = Math.min(maxBytes * 4, HEALTH_SINCE_MAX_BYTES);
    }
  }

  /** The most recent `n` entries from the bounded retained tail, oldest first. */
  async recent(n: number, signal?: AbortSignal): Promise<HealthEntry[]> {
    return (await this.readTail(HEALTH_READ_TAIL_BYTES, signal)).entries.slice(-n);
  }

  /**
   * Read up to the last `maxBytes` of the record and parse whole lines. When the
   * read did not reach byte 0 the first line is a fragment of an earlier entry
   * and is dropped; `reachedStart` reports whether the whole file was covered, so
   * since() knows when to stop growing. Genuine I/O errors (open/stat/read)
   * propagate so a caller can report "unavailable"; an individual malformed or
   * torn line is skipped — expected in an append-only log.
   */
  private async readTail(maxBytes: number, signal?: AbortSignal): Promise<{ entries: HealthEntry[]; reachedStart: boolean }> {
    signal?.throwIfAborted();
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.file, constants.O_RDONLY | noFollow);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], reachedStart: true };
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`health record path is not a regular file: '${this.file}'`);
      const length = Math.min(info.size, maxBytes);
      const reachedStart = length >= info.size;
      if (length === 0) return { entries: [], reachedStart: true };
      const start = info.size - length;
      const bytes = Buffer.allocUnsafe(length);
      let bytesRead = 0;
      while (bytesRead < length) {
        const read = await handle.read(bytes, bytesRead, length - bytesRead, start + bytesRead);
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      signal?.throwIfAborted();
      let text = bytes.subarray(0, bytesRead).toString("utf8");
      if (start > 0) {
        const firstNewline = text.indexOf("\n");
        // Not at byte 0: the first line is a fragment of an earlier entry — drop
        // it. No newline at all means the tail is a fragment of one oversized
        // line with no complete entry (not an I/O failure), so report none.
        if (firstNewline < 0) return { entries: [], reachedStart };
        text = text.slice(firstNewline + 1);
      }
      // An individual malformed line is expected in an append-only log (a torn
      // final line during a concurrent write, or a legacy-schema entry) and must
      // not poison the whole read — skip it and keep the good entries.
      const out: HealthEntry[] = [];
      for (const line of text.split("\n").filter(Boolean)) {
        try {
          const e = JSON.parse(line) as HealthEntry;
          if (typeof e.t === "number" && typeof e.metric === "string") out.push(e);
        } catch { /* skip corrupt line, keep the rest */ }
      }
      return { entries: out, reachedStart };
    } finally {
      await handle.close();
    }
  }
}

/** "82.4 kg" / "650 kcal" / bare note — one entry, formatted for the ear and the terminal. */
export function formatValue(e: HealthEntry): string {
  if (e.value === undefined) return e.note ?? "(empty)";
  const v = `${e.value}${e.unit ? ` ${e.unit}` : ""}`;
  return e.note ? `${v} — ${e.note}` : v;
}

/**
 * The morning briefing's health line: a one-sentence recap of the window's
 * entries, or null when there's nothing — silence, not "no data", on the
 * days you didn't log. Values are summarized per metric: last weight,
 * summed calories, a count for everything else.
 */
export function briefLine(entries: HealthEntry[]): string | null {
  if (entries.length === 0) return null;
  const byMetric = new Map<string, HealthEntry[]>();
  for (const e of entries) {
    const list = byMetric.get(e.metric) ?? [];
    list.push(e);
    byMetric.set(e.metric, list);
  }
  const bits: string[] = [];
  for (const [metric, list] of byMetric) {
    const numeric = list.filter((e) => e.value !== undefined);
    if (metric === "calories" && numeric.length) {
      bits.push(`${numeric.reduce((s, e) => s + e.value!, 0)} kcal`);
    } else if (numeric.length) {
      const last = numeric[numeric.length - 1]!;
      bits.push(`${metric} ${last.value}${last.unit ? ` ${last.unit}` : ""}`);
    } else {
      bits.push(`${list.length} ${metric} note${list.length > 1 ? "s" : ""}`);
    }
  }
  return `Health log: ${bits.join(", ")}.`;
}

/**
 * A plain-text trend report for one metric over the window — written for an
 * agent to read and speak from, so it's short lines, no markdown. Numeric
 * metrics get first/last/delta/min/max; calories get per-day totals (the
 * question is "how much per day", not "what was one meal").
 */
export function trendReport(entries: HealthEntry[], metric: string, days: number): string {
  const rows = entries.filter((e) => e.metric === metric);
  if (rows.length === 0) return `No ${metric} entries in the last ${days} day(s).`;
  const numeric = rows.filter((e) => e.value !== undefined);
  const lines: string[] = [`${metric}: ${rows.length} entr${rows.length > 1 ? "ies" : "y"} in the last ${days} day(s).`];

  if (metric === "calories" && numeric.length) {
    const byDay = new Map<string, number>();
    for (const e of numeric) {
      const day = new Date(e.t).toLocaleDateString("en-CA");
      byDay.set(day, (byDay.get(day) ?? 0) + e.value!);
    }
    for (const [day, total] of byDay) lines.push(`${day}: ${total} kcal`);
    const totals = [...byDay.values()];
    lines.push(`average: ${Math.round(totals.reduce((s, v) => s + v, 0) / totals.length)} kcal/day over ${totals.length} logged day(s)`);
  } else if (numeric.length) {
    const values = numeric.map((e) => e.value!);
    const unit = numeric[numeric.length - 1]!.unit ?? "";
    const first = numeric[0]!, last = numeric[numeric.length - 1]!;
    const delta = last.value! - first.value!;
    lines.push(`first: ${first.value}${unit ? ` ${unit}` : ""} (${new Date(first.t).toLocaleDateString("en-CA")})`);
    lines.push(`last: ${last.value}${unit ? ` ${unit}` : ""} (${new Date(last.t).toLocaleDateString("en-CA")})`);
    lines.push(`change: ${delta > 0 ? "+" : ""}${Number(delta.toFixed(2))}${unit ? ` ${unit}` : ""}`);
    lines.push(`min: ${Math.min(...values)} · max: ${Math.max(...values)} · avg: ${Number((values.reduce((s, v) => s + v, 0) / values.length).toFixed(2))}`);
  } else {
    for (const e of rows.slice(-10)) {
      lines.push(`${new Date(e.t).toLocaleDateString("en-CA")}: ${e.note ?? "(no note)"}`);
    }
  }
  return lines.join("\n");
}
