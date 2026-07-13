import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

  /** All entries at or after `sinceMs`, oldest first. */
  async since(sinceMs: number): Promise<HealthEntry[]> {
    return (await this.all()).filter((e) => e.t >= sinceMs);
  }

  /** The most recent `n` entries, oldest first. */
  async recent(n: number): Promise<HealthEntry[]> {
    return (await this.all()).slice(-n);
  }

  private async all(): Promise<HealthEntry[]> {
    try {
      if (!existsSync(this.file)) return [];
      const out: HealthEntry[] = [];
      for (const line of (await readFile(this.file, "utf8")).split("\n").filter(Boolean)) {
        try {
          const e = JSON.parse(line) as HealthEntry;
          if (typeof e.t === "number" && typeof e.metric === "string") out.push(e);
        } catch { /* skip corrupt line */ }
      }
      return out;
    } catch {
      return [];
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
