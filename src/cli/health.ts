import { HealthStore, DEFAULT_UNITS, formatValue, trendReport, type HealthEntry } from "../health/store";

/**
 * `cicero health` — the health lane's hands. The health profile's agent runs
 * these over its shell tool, so the output is written to be read (and read
 * ALOUD) by an LLM: plain lines, no tables, no markdown.
 *
 *   cicero health log weight 82.4            → logged: weight 82.4 kg
 *   cicero health log calories 650 chicken bowl
 *   cicero health log sleep 6.5 h restless
 *   cicero health log mood rough day, no gym  (no number = a pure note)
 *   cicero health recent [n]
 *   cicero health trend weight --days 30
 */

/** Units a log line may name explicitly, so "82.4 kg" isn't noted as "kg". */
const KNOWN_UNITS = new Set([
  "kg", "lb", "lbs", "kcal", "cal", "h", "hr", "hrs", "hours", "min", "mins",
  "km", "mi", "bpm", "mg", "ml", "l", "steps", "%",
]);

/** Parse `log` args: [value] [unit] [note…] — a non-numeric first word means it's all note. */
export function parseLogWords(metric: string, words: string[]): Pick<HealthEntry, "value" | "unit" | "note"> {
  const out: Pick<HealthEntry, "value" | "unit" | "note"> = {};
  let rest = words;
  if (rest.length && /^-?\d+(\.\d+)?$/.test(rest[0]!)) {
    out.value = Number(rest[0]);
    rest = rest.slice(1);
    if (rest.length && KNOWN_UNITS.has(rest[0]!.toLowerCase())) {
      out.unit = rest[0]!.toLowerCase();
      rest = rest.slice(1);
    } else {
      const dflt = DEFAULT_UNITS[metric];
      if (dflt) out.unit = dflt;
    }
  }
  if (rest.length) out.note = rest.join(" ");
  return out;
}

export async function healthLog(metric: string, words: string[], store = new HealthStore()): Promise<string> {
  const slug = metric.trim().toLowerCase();
  if (!slug) return "usage: cicero health log <metric> [value] [unit] [note…]";
  const parsed = parseLogWords(slug, words);
  if (parsed.value === undefined && !parsed.note) {
    return `nothing to log — give ${slug} a value or a note`;
  }
  const entry: HealthEntry = { t: Date.now(), metric: slug, source: "cli", ...parsed };
  await store.append(entry);
  return `logged: ${slug} ${formatValue(entry)}`;
}

export async function healthRecent(n: number, store = new HealthStore()): Promise<string> {
  const entries = await store.recent(n);
  if (entries.length === 0) return "no health entries yet";
  return entries
    .map((e) => `${new Date(e.t).toLocaleString("en-CA", { hour12: false }).slice(0, 16)}  ${e.metric}  ${formatValue(e)}`)
    .join("\n");
}

export async function healthTrend(metric: string, days: number, store = new HealthStore()): Promise<string> {
  const entries = await store.since(Date.now() - days * 24 * 60 * 60 * 1000);
  return trendReport(entries, metric.trim().toLowerCase(), days);
}
