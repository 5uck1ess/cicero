/**
 * Session resume: a daemon restart starts a FRESH agent session, which would
 * otherwise forget the conversation mid-thread. The chat history file already
 * holds the recent turns, so we fold a compact recap into the warmup ping the
 * daemon sends at boot — the new session starts knowing what was being
 * discussed, at zero extra latency and with any ACP harness.
 */

export interface ResumeTurn {
  t: number;
  user: string;
  reply: string;
  /** Lane that spoke the reply (undefined = the front desk itself). */
  lane?: string;
}

export interface RosterLane {
  aliases?: string[];
}

/**
 * A one-paragraph office roster folded into the warmup ping, so the front-desk
 * model can answer "who can I talk to?" and correct a misremembered name. The
 * switchboard's transfer matching is anchored to whole single-line utterances,
 * so quoting the phrases inside this multi-line note cannot trigger a pin.
 */
function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function buildRosterNote(lanes: Record<string, RosterLane> | undefined, thinkTriggers?: string[]): string | null {
  const names = Object.entries(lanes ?? {});
  if (names.length === 0) return null;
  // The FIRST alias is the colleague's working name — the one the user says
  // and the one to use when reciting the roster; the lane id is plumbing.
  const staff = names
    .map(([name, l]) => {
      const [called, ...rest] = l.aliases ?? [];
      if (!called) return name;
      const also = rest.length ? `; also answers to: ${rest.join(", ")}` : "";
      return `${titleCase(called)} (the ${name} lane${also})`;
    })
    .join("; ");
  const think = thinkTriggers?.length ? ` Opening with "${thinkTriggers[0]} …" escalates that one turn to the deep-reasoning lane.` : "";
  return (
    `Office roster: the user can be transferred to these colleagues by saying "let me talk to <name>": ${staff}. ` +
    `Saying "back to Cicero" returns to you. Only one colleague can be on the line at a time — there is no conference mode. For GROUP requests there are two magic phrases: "roll call" (everyone checks in briefly, each in their own voice) and "status from everyone" (each colleague reports what it is working on). When the user wants everyone, a group call, or the whole team's status, give them one of those two exact phrases — NEVER ask them to name specific colleagues, and NEVER invent or act out a colleague's status or reply: if you have not heard from them, you do not know what they are doing.${think} ` +
    `Transfers happen automatically when the user says such a phrase as its own short sentence — never claim to transfer anyone yourself, never speak on a colleague's behalf, and never pretend a colleague is on the line. If the user wanted a transfer that did not happen, tell them the exact phrase to say. If they ask who is available or misremember a name, recite the roster using each colleague's working name (the name before the parenthesis) and what they do — never the lane id or a surname from the alias list. When a request clearly belongs to a colleague's specialty and no transfer happened, offer it: "That sounds like one for <name> — say 'talk to <name>' and I'll connect you."`
  );
}

const MAX_FIELD = 240;   // per-side cap — recaps need gist, not transcripts
const MAX_TOTAL = 4000;  // primer budget; oldest turns drop first

function clip(s: string): string {
  const t = s.trim();
  return t.length > MAX_FIELD ? t.slice(0, MAX_FIELD - 1) + "…" : t;
}

/**
 * Build the warmup message that both primes the provider cache and restores
 * conversational context. Returns null when there's nothing to resume.
 */
export function buildResumePrimer(items: ResumeTurn[]): string | null {
  const lines: string[] = [];
  let total = 0;
  // Newest turns matter most — walk backwards and keep what fits the budget.
  let hadColleague = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it.user && !it.reply) continue;
    // Replies spoken by a transferred-to colleague must NOT be labeled "You:" —
    // the model resumes believing it said them and picks up that colleague's
    // personality (the front desk once came back as a colleague's persona).
    const speaker = it.lane ? `Colleague "${it.lane}" (user was transferred)` : "You";
    if (it.lane) hadColleague = true;
    const chunk = [it.user ? `User: ${clip(it.user)}` : "", it.reply ? `${speaker}: ${clip(it.reply)}` : ""]
      .filter(Boolean)
      .join("\n");
    if (total + chunk.length > MAX_TOTAL) break;
    lines.unshift(chunk);
    total += chunk.length;
  }
  if (lines.length === 0) return null;
  const colleagueNote = hadColleague
    ? ' Lines marked as a colleague\'s were spoken by that colleague, NOT by you — never adopt their personality or continue their conversation; you are the front desk. The restart ended any transfer: the user is talking to YOU now.'
    : "";
  return [
    "Context restore after a restart — the tail of your recent conversation with the user:",
    "",
    lines.join("\n"),
    "",
    `That is where the conversation left off. When the user returns, carry on from there as if there was no interruption — this recap IS what you were just talking about.${colleagueNote} Acknowledge the restore by replying, to this message only, with exactly: ok`,
  ].join("\n");
}
