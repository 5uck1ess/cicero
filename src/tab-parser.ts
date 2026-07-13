import { replaceLiteralPhrase } from "./regex";

/**
 * Tab command parsing utilities — extracted for testability.
 *
 * Parses voice commands like:
 * - "switch to sales tab" → { type: "switch", tabName: "sales" }
 * - "switch to sales and check the pipeline" → { type: "switch_and_do", tabName: "sales", command: "check the pipeline" }
 * - "in PM tools, run my checkin" → { type: "in_tab", tabName: "PM tools", command: "run my checkin" }
 */

export interface TabSwitchResult {
  type: "switch";
  tabName: string;
}

export interface TabSwitchAndDoResult {
  type: "switch_and_do";
  tabName: string;
  command: string;
}

export interface InTabResult {
  type: "in_tab";
  tabName: string;
  command: string;
}

export type TabCommandResult = TabSwitchResult | TabSwitchAndDoResult | InTabResult | null;

/**
 * Clean a raw tab name extracted from speech:
 * - Strip trailing punctuation
 * - Strip trailing "tab" word
 * - Strip "the"
 */
export function cleanTabName(raw: string): string {
  return raw.trim()
    .replace(/[.,!?]+$/, "")           // trailing punctuation
    .replace(/\s*\btab\b\s*$/i, "")    // trailing "tab" word
    .replace(/\bthe\b/g, "")           // "the working" → "working"
    .trim();
}

/**
 * Reject vague/generic tab names that aren't real tab identifiers.
 * These come from voice commands like "switch to a different tab" where
 * the user doesn't specify a real tab name.
 */
export function isVagueTabName(name: string): boolean {
  const vaguePatterns = [
    /^a\s+different$/i,
    /^another$/i,
    /^something$/i,
    /^some\s+other$/i,
    /^different$/i,
    /^other$/i,
    /^new$/i,
    /^that$/i,
    /^this$/i,
    /^next$/i,
    /^previous$/i,
    /^last$/i,
    /^first$/i,
    /^a\s+new$/i,
    /^any$/i,
    /^some$/i,
    /^one$/i,
    /^it$/i,
  ];
  return vaguePatterns.some(p => p.test(name.trim()));
}

/**
 * Expand phonetic aliases in text (STT mishearing corrections).
 */
export function expandAliases(text: string, aliases: Record<string, string[]>): string {
  let result = text;
  for (const [canonical, alts] of Object.entries(aliases)) {
    for (const alt of alts) {
      result = replaceLiteralPhrase(result, alt, canonical);
    }
  }
  return result;
}

// Prefix words that introduce a tab switch command
const switchVerb = /^(?:(?:can you|could you|please)\s+)?(?:switch|swap|go|change|move|jump)(?:\s+(?:over|back))?\s+to/;

/**
 * Parse a voice command to see if it's a tab-directed command.
 * Input should be lowercase, trimmed, with filler words stripped.
 * Aliases should already be expanded.
 */
export function parseTabCommand(expanded: string): TabCommandResult {
  // Pattern: "switch to {tab} and {command}" (must check before plain switch)
  const switchAndDoMatch = expanded.match(
    new RegExp(switchVerb.source + "\\s+(.+?)(?:\\s+tab)?\\s+and\\s+(.+)$")
  );
  if (switchAndDoMatch) {
    const tabName = cleanTabName(switchAndDoMatch[1]);
    const command = switchAndDoMatch[2].trim();
    if (!tabName || isVagueTabName(tabName)) return null;
    return { type: "switch_and_do", tabName, command };
  }

  // Pattern: "switch to {tab}" / "use {tab} tab" / "switch brain to {tab}"
  const switchMatch = expanded.match(
    new RegExp(switchVerb.source + "\\s+(.+?)(?:\\s+tab)?$")
  ) || expanded.match(
    /^(?:switch\s+brain\s+to|use)\s+(.+?)(?:\s+tab)?$/
  );
  if (switchMatch) {
    const tabName = cleanTabName(switchMatch[1]);
    if (!tabName || isVagueTabName(tabName)) return null;
    return { type: "switch", tabName };
  }

  // Pattern: "in {tab}, {command}" / "on {tab} tab, {command}"
  const inTabMatch = expanded.match(
    /^(?:in|on)\s+(.+?)(?:\s+tab)?\s*[,]\s*(.+)$/
  );
  if (inTabMatch) {
    const tabName = cleanTabName(inTabMatch[1]);
    const command = inTabMatch[2].trim();
    if (!tabName || isVagueTabName(tabName)) return null;
    return { type: "in_tab", tabName, command };
  }

  return null;
}
