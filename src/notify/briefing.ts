import type { KanbanTask } from "./kanban-watch";

/** Telegram's maximum plain-text sendMessage payload, measured like String.slice(). */
export const TELEGRAM_TEXT_MAX_CHARS = 4_096;

const BRIEFING_CONTINUATION_HEADER = "☀️ Morning briefing";

/**
 * The chief-of-staff pair: quiet hours park notifications overnight instead of
 * pinging, and the morning briefing delivers them in one digest — "while you
 * were away" plus what's on the board — as a glanceable text and, optionally,
 * a phone call.
 */

export interface QuietHoursConfig {
  from: string; // "HH:MM", box-local time
  to: string;
}

export interface BriefingConfig {
  at: string;      // "HH:MM", box-local time, fires once a day
  call?: boolean;  // also ring the phone and speak it (default: text only)
  catch_up_minutes?: number; // restart catch-up window (default 180, 0 = exact minute only)
}

/** "HH:MM" → minutes past midnight. Throws on garbage so config errors surface at startup. */
export function parseHm(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`bad time "${s}" — expected HH:MM`);
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`bad time "${s}" — expected HH:MM`);
  return h * 60 + min;
}

/**
 * "HH:MM" for `now` in the user's timezone (IANA name, e.g. America/New_York).
 * Without a timezone this is the BOX's clock — on a UTC server, "08:30" means
 * 08:30 UTC, which once rang a user at 4:30am. Set notify.timezone.
 */
export function hmOf(now: Date, timeZone?: string): string {
  if (!timeZone) {
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false })
    .format(now)
    .replace("24:", "00:");
}

/** Day key for once-a-day guards, in the user's timezone. */
export function dayOf(now: Date, timeZone?: string): string {
  if (!timeZone) return now.toDateString();
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Is `now` inside the quiet window? Handles windows that span midnight (23:00→08:00). */
export function inQuietHours(now: Date, q: QuietHoursConfig, timeZone?: string): boolean {
  const from = parseHm(q.from), to = parseHm(q.to);
  if (from === to) return false; // zero-length window = off
  const cur = parseHm(hmOf(now, timeZone));
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

/**
 * The spoken/texted briefing. Deduped overnight news first ("while you were
 * away"), then what needs a human on the board. Reads naturally as speech —
 * the call delivery pipes it through TTS verbatim.
 */
export function composeBriefing(overnight: string[], board: KanbanTask[] | null, healthLine?: string | null): string {
  const parts: string[] = ["Morning briefing."];
  const news = [...new Set(overnight.map((s) => s.trim()).filter(Boolean))];
  if (news.length) {
    parts.push(`While you were away: ${news.join(" ")}`);
  }
  if (board) {
    const blocked = board.filter((t) => t.status === "blocked");
    const review = board.filter((t) => t.status === "review");
    if (blocked.length) parts.push(`Needs your input: ${blocked.map((t) => `"${t.title}"`).join(", ")}.`);
    if (review.length) parts.push(`Waiting on review: ${review.map((t) => `"${t.title}"`).join(", ")}.`);
    if (!blocked.length && !review.length && !news.length) parts.push("All quiet overnight, and the board is clean.");
  } else if (!news.length) {
    parts.push("All quiet overnight.");
  }
  // The health line rides last, and only on days that have data — see briefLine().
  if (healthLine) parts.push(healthLine);
  return parts.join(" ");
}

/** One "━━━ label ━━━" block. Bulleted items by default; health rides bare. */
function briefingSection(label: string, items: string[], bullet = true): string {
  const body = bullet ? items.map((i) => `• ${i}`).join("\n") : items.join("\n");
  return `━━━━━ ${label} ━━━━━\n${body}`;
}

/**
 * The same briefing data as composeBriefing, rendered as a glanceable Telegram
 * digest — an emoji header, `━━━` section dividers, one bullet per item. This is
 * deliberately plain Unicode text, not Telegram Markdown/MarkdownV2; callers
 * must not add parse_mode without escaping user-controlled task titles. The
 * spoken call path keeps using composeBriefing because dividers and bullets
 * read as garbage aloud.
 */
export function composeBriefingDigest(
  overnight: string[],
  board: KanbanTask[] | null,
  healthLine?: string | null,
  date?: string,
): string {
  const header = `☀️ Morning briefing${date ? ` — ${date}` : ""}`;
  const sections: string[] = [];

  const news = [...new Set(overnight.map((s) => s.trim()).filter(Boolean))];
  if (news.length) sections.push(briefingSection("while you were away", news));

  if (board) {
    const blocked = board.filter((t) => t.status === "blocked");
    const review = board.filter((t) => t.status === "review");
    if (blocked.length) sections.push(briefingSection("needs your input", blocked.map((t) => `"${t.title}"`)));
    if (review.length) sections.push(briefingSection("waiting on review", review.map((t) => `"${t.title}"`)));
  }

  if (healthLine) sections.push(briefingSection("health", [healthLine], false));

  if (!sections.length) {
    // Mirror composeBriefing's empty-state wording exactly.
    const quiet = board ? "All quiet overnight, and the board is clean." : "All quiet overnight.";
    return `${header}\n\n${quiet}`;
  }
  return `${header}\n\n${sections.join("\n\n")}`;
}

/**
 * Split a composed digest into Telegram-safe messages. Whole sections are kept
 * together when possible; only an oversized section falls back to line/item
 * boundaries, and only a single over-limit line is hard-split.
 */
export function chunkBriefingDigest(digest: string): string[] {
  if (!digest) return [];
  if (digest.length <= TELEGRAM_TEXT_MAX_CHARS) return [digest];

  // Continuation-header length depends on the final denominator. Starting at
  // two and repacking converges monotonically whenever another digit is needed.
  let total = 2;
  for (;;) {
    const chunks = packBriefingChunks(digest, total);
    if (chunks.length === total) return chunks;
    total = chunks.length;
  }
}

function packBriefingChunks(digest: string, total: number): string[] {
  const blocks = digest.split("\n\n");
  const chunks: string[] = [];
  let content = "";

  const prefix = (index: number): string => index === 0
    ? ""
    : `${BRIEFING_CONTINUATION_HEADER} (${index + 1}/${total})\n\n`;
  const contentLimit = (): number => TELEGRAM_TEXT_MAX_CHARS - prefix(chunks.length).length;
  const flush = (): void => {
    if (!content) return;
    chunks.push(`${prefix(chunks.length)}${content}`);
    content = "";
  };

  const appendHardSplitLine = (line: string, initialSeparator: string): void => {
    let remaining = line;
    let separator = initialSeparator;
    while (remaining.length > 0) {
      const available = contentLimit() - content.length - separator.length;
      if (remaining.length <= available) {
        content += separator + remaining;
        return;
      }
      if (available <= 1) {
        flush();
        separator = "";
        continue;
      }
      // The ellipsis makes the otherwise destructive hard split visible.
      content += separator + remaining.slice(0, available - 1) + "…";
      remaining = remaining.slice(available - 1);
      flush();
      separator = "";
    }
  };

  blocks.forEach((block, blockIndex) => {
    const separator = content ? "\n\n" : "";
    if (content.length + separator.length + block.length <= contentLimit()) {
      content += separator + block;
      return;
    }

    // Prefer a clean section boundary. The first digest header stays attached
    // to at least part of an oversized first section instead of standing alone.
    const currentIsOnlyDigestHeader = blockIndex === 1 && chunks.length === 0;
    if (content && !currentIsOnlyDigestHeader) flush();

    const freshSeparator = content ? "\n\n" : "";
    if (content.length + freshSeparator.length + block.length <= contentLimit()) {
      content += freshSeparator + block;
      return;
    }

    const lines = block.split("\n");
    lines.forEach((line, lineIndex) => {
      const lineSeparator = content
        ? (lineIndex === 0 ? "\n\n" : "\n")
        : "";
      if (content.length + lineSeparator.length + line.length <= contentLimit()) {
        content += lineSeparator + line;
        return;
      }
      const keepDigestHeader = blockIndex === 1 && lineIndex === 0 && chunks.length === 0;
      if (content && !keepDigestHeader) flush();
      appendHardSplitLine(line, keepDigestHeader ? lineSeparator : "");
    });
  });

  flush();
  return chunks;
}

/** Prompt for the call-minutes summarizer — turns a transcript into short notes. */
export function minutesPrompt(turns: Array<{ user: string; reply: string }>): string {
  const transcript = turns
    .map((t) => `User: ${t.user}\nAssistant: ${t.reply}`)
    .join("\n")
    .slice(0, 6000);
  return (
    "These are the turns of a voice call between a user and their assistant's office. " +
    "Write brief call notes: 2-4 short plain-text lines covering what was asked, decided, and done. " +
    "No preamble, no markdown bullets, one line per point. " +
    "If nothing happened worth noting down (a quick check-in, small talk, a simple question and answer), reply with exactly SKIP.\n\n" +
    transcript
  );
}

/**
 * Substance gate: minutes are for real conversations. Requires at least two
 * turns AND a call spanning `minMs` (default 3 minutes) from first turn to
 * last — a quick "status? green, bye" never produces notes.
 */
export function worthMinutes(
  turns: Array<{ user: string; reply: string; t: number }>,
  minMs = 3 * 60 * 1000,
): boolean {
  if (turns.length < 2) return false;
  const span = turns[turns.length - 1].t - turns[0].t;
  return span >= minMs;
}

/** Resolve the configured call-duration gate without treating an explicit zero as absent. */
export function callMinutesThresholdMs(setting: boolean | { min_minutes?: number } | undefined): number {
  const minutes = typeof setting === "object" ? setting.min_minutes ?? 3 : 3;
  return minutes * 60 * 1000;
}
