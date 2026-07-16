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

/** Maximum file content retained by any health-record read. */
export const HEALTH_READ_TAIL_BYTES = 64 * 1024;

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

  /** Entries from the bounded retained tail at or after `sinceMs`, oldest first. */
  async since(sinceMs: number, signal?: AbortSignal): Promise<HealthEntry[]> {
    return (await this.all(signal)).filter((e) => e.t >= sinceMs);
  }

  /** The most recent `n` entries from the bounded retained tail, oldest first. */
  async recent(n: number, signal?: AbortSignal): Promise<HealthEntry[]> {
    return (await this.all(signal)).slice(-n);
  }

  private async all(signal?: AbortSignal): Promise<HealthEntry[]> {
    signal?.throwIfAborted();
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.file, constants.O_RDONLY | noFollow);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`health record path is not a regular file: '${this.file}'`);
      const length = Math.min(info.size, HEALTH_READ_TAIL_BYTES);
      if (length === 0) return [];
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
        // The retained tail is a fragment of a single line longer than the bound
        // (a torn/oversized final entry). The file read fine, so this is not an
        // I/O failure — there are simply no complete entries in the window. Report
        // empty rather than throwing (which would flip health to "unavailable").
        if (firstNewline < 0) return [];
        text = text.slice(firstNewline + 1);
      }
      // Genuine I/O failures (open/stat/read above) propagate so the caller can
      // report the health field as "unavailable" rather than a confident empty.
      // An individual malformed line, however, is expected in an append-only log
      // (a torn final line during a concurrent write, or a legacy-schema entry)
      // and must not poison the whole read — skip it and keep the good entries.
      const out: HealthEntry[] = [];
      for (const line of text.split("\n").filter(Boolean)) {
        try {
          const e = JSON.parse(line) as HealthEntry;
          if (typeof e.t === "number" && typeof e.metric === "string") out.push(e);
        } catch { /* skip corrupt line, keep the rest */ }
      }
      return out;
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
