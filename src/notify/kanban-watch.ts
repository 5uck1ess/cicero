import { log } from "../logger";
import { CommandAbortError, runBoundedCommand } from "../process/bounded-command";

const KANBAN_COMMAND_TIMEOUT_MS = 10_000;
const KANBAN_LIST_STDOUT_LIMIT_BYTES = 1024 * 1024;
const KANBAN_LINK_STDOUT_LIMIT_BYTES = 256 * 1024;
const KANBAN_STDERR_LIMIT_BYTES = 64 * 1024;

export interface KanbanCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Kanban → proactive voice: poll the agent's kanban board and announce tasks
 * that finish, block, or land in review through the notify channel — Cicero
 * speaks up ("the coder finished X") instead of waiting to be asked. The
 * board is read via a configured harness CLI (e.g. `hermes kanban list
 * --json`), so Cicero needs no access to the board's storage. There is no
 * built-in board command — the integration is explicit opt-in per harness.
 */

export interface KanbanTask {
  id: string;
  title: string;
  status: string;
  assignee?: string | null;
  /** Unix seconds — present in the board CLI's JSON output. */
  created_at?: number | null;
  /** Unix seconds; missing/null = nobody has picked the task up yet. */
  started_at?: number | null;
}

export interface KanbanWatchConfig {
  enabled?: boolean;
  /** Poll cadence. Default 20s — announcements should feel prompt, not instant. */
  interval_seconds?: number;
  /** Command that prints the board as a JSON array (required to watch a board), e.g. [hermes, kanban, list, --json]. */
  command?: string[];
  /** Command whose `<task_command> <id> --json` prints one task's detail; enables the deliverable-link card on announcements. Absent = no link lookup. */
  task_command?: string[];
}

/** Statuses worth speaking about — the ones where a human might act. */
const ANNOUNCE = new Set(["done", "blocked", "review"]);

export function spokenLine(t: KanbanTask, firstPerson = false): string {
  const title = t.title.length > 80 ? t.title.slice(0, 77) + "…" : t.title;
  if (firstPerson && t.assignee) {
    // The owning employee announces its own news, in its own voice.
    const name = t.assignee.length <= 2 ? t.assignee.toUpperCase() : t.assignee[0]!.toUpperCase() + t.assignee.slice(1);
    if (t.status === "done") return `${name} here — finished: ${title}.`;
    // "blocked" is usually a review-park, not a question for the listener —
    // "need your input" trained the user to think they had to act every time.
    if (t.status === "blocked") return `${name} here — I've parked "${title}"; it needs a review or an answer before I continue. Text "have ${t.assignee} call me" and I'll walk you through it.`;
    return `${name} here — "${title}" is ready for your review.`;
  }
  const who = t.assignee ? `The ${t.assignee}` : "A worker";
  if (t.status === "done") return `${who} finished the task: ${title}.`;
  // Blocked news never rings on its own (the user's call) — instead the text
  // names the dial-back that puts the blocked employee on the line.
  if (t.status === "blocked") {
    const hint = t.assignee ? ` Text "have ${t.assignee} call me" to talk it through.` : "";
    return `The task "${title}" is parked — it needs a review or an answer.${hint}`;
  }
  return `The task "${title}" is ready for review.`;
}

/** A task nobody has picked up: spoken/text nudge. Repeats escalate the wording. */
export function nudgeLine(t: KanbanTask, waitedMinutes: number, nth = 1): string {
  const title = t.title.length > 80 ? t.title.slice(0, 77) + "…" : t.title;
  const waited = waitedMinutes >= 120 ? `${Math.round(waitedMinutes / 60)} hours` : `${Math.round(waitedMinutes)} minutes`;
  if (nth <= 1) return `The task "${title}" has been waiting ${waited} — nobody's picked it up yet.`;
  return `Still nobody on "${title}" — ${waited} now. Reminder ${nth}.`;
}

/** Read the board via the configured harness CLI. Throws on spawn failure or bad JSON. */
export async function listViaCli(
  command: string[],
  options: KanbanCommandOptions = {},
): Promise<KanbanTask[]> {
  const result = await runBoundedCommand(command, {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? KANBAN_COMMAND_TIMEOUT_MS,
    stdoutLimitBytes: KANBAN_LIST_STDOUT_LIMIT_BYTES,
    stderrLimitBytes: KANBAN_STDERR_LIMIT_BYTES,
    totalLimitBytes: KANBAN_LIST_STDOUT_LIMIT_BYTES + KANBAN_STDERR_LIMIT_BYTES,
    outputLimitBehavior: "error",
    stderrCapture: "tail",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} exited ${result.exitCode}: ${result.stderr.text.slice(-160)}`);
  }
  const parsed = JSON.parse(result.stdout.text) as unknown;
  if (!Array.isArray(parsed)) throw new Error("kanban list did not return a JSON array");
  return parsed as KanbanTask[];
}

/**
 * First URL from a finished task's detail — the worker's completion summary
 * usually ends with the deliverable link (typically a PR). Screen-only payload:
 * the notify path strips URLs from TTS and the voice page renders them as a
 * tappable card. Returns null when nothing is linkable or the CLI hiccups —
 * a missing link must never block the announcement itself.
 */
export async function taskLinkViaCli(
  id: string,
  command: string[],
  options: KanbanCommandOptions = {},
): Promise<string | null> {
  const URL_RE = /https?:\/\/[^\s<>"')\]]+/;
  try {
    const result = await runBoundedCommand([...command, id, "--json"], {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? KANBAN_COMMAND_TIMEOUT_MS,
      stdoutLimitBytes: KANBAN_LINK_STDOUT_LIMIT_BYTES,
      stderrLimitBytes: KANBAN_STDERR_LIMIT_BYTES,
      totalLimitBytes: KANBAN_LINK_STDOUT_LIMIT_BYTES + KANBAN_STDERR_LIMIT_BYTES,
      outputLimitBehavior: "error",
      stderrCapture: "tail",
    });
    if (result.exitCode !== 0) return null;
    const d = JSON.parse(result.stdout.text) as { latest_summary?: unknown; comments?: Array<{ body?: unknown }> };
    const texts: unknown[] = [
      d.latest_summary,
      ...(Array.isArray(d.comments) ? [...d.comments].reverse().map((c) => c?.body) : []),
    ];
    // A PR link is the deliverable; failing that, any URL that actually points
    // somewhere. Bare hosts ("see https://github.com") are prose, not links.
    let fallback: string | null = null;
    for (const t of texts) {
      if (typeof t !== "string") continue;
      for (const m of t.matchAll(new RegExp(URL_RE, "g"))) {
        // Sentence punctuation glued to the URL ("…/pull/1;") is not part of it.
        const url = m[0].replace(/[.,;:!?]+$/, "");
        if (/\/pull\/\d+/.test(url)) return url;
        try {
          if (!fallback && new URL(url).pathname.length > 1) fallback = url;
        } catch { /* mangled URL — skip */ }
      }
    }
    return fallback;
  } catch (error) {
    if (error instanceof CommandAbortError || options.signal?.aborted) throw error;
    return null;
  }
}

export class KanbanWatcher {
  /** Last status seen per task id. Empty until the first successful poll seeds it. */
  private known = new Map<string, string>();
  private seeded = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private scheduledPoll: Promise<void> | undefined;
  private activePoll: Promise<void> | undefined;
  private activeController: AbortController | undefined;

  /** Per unstarted task: reminders already sent and when the next is allowed. */
  private nudged = new Map<string, { count: number; nextAt: number }>();

  constructor(private opts: {
    list: (signal: AbortSignal) => Promise<KanbanTask[]>;
    /** Called with the transitioned task — the caller formats and voices it. */
    announce: (task: KanbanTask, signal: AbortSignal) => void | Promise<void>;
    intervalMs: number;
    /** Called for each reminder about a task sitting unstarted past nudgeAfterMs. */
    nudge?: (task: KanbanTask, waitedMinutes: number, nth: number, signal: AbortSignal) => void | Promise<void>;
    nudgeAfterMs?: number;
    /** Clock override for tests. */
    now?: () => number;
  }) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.launchScheduledPoll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.activeController?.abort(new Error("kanban watcher stopped"));
    const poll = this.scheduledPoll ?? this.activePoll;
    if (!poll) return;
    try {
      await poll;
    } catch (error) {
      log("warn", `kanban watch: shutdown poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * One poll. The first successful poll only seeds — pre-existing done tasks
   * are old news, not announcements. After that, a task announces when it
   * TRANSITIONS into an announce-worthy status, including tasks first seen
   * already-terminal (created and finished between polls).
   */
  tick(): Promise<void> {
    if (this.activePoll) return this.activePoll;
    const controller = new AbortController();
    this.activeController = controller;
    const poll = this.runTrackedPoll(controller);
    this.activePoll = poll;
    return poll;
  }

  private async runTrackedPoll(controller: AbortController): Promise<void> {
    try {
      await this.poll(controller.signal);
    } finally {
      if (this.activeController === controller) {
        this.activeController = undefined;
        this.activePoll = undefined;
      }
    }
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let tasks: KanbanTask[];
    try {
      tasks = await this.opts.list(signal);
    } catch (err: unknown) {
      if (signal.aborted) return;
      log("warn", `kanban watch: poll failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (signal.aborted) return;
    for (const t of tasks) {
      if (signal.aborted) return;
      if (!t?.id || typeof t.status !== "string") continue;
      const prev = this.known.get(t.id);
      this.known.set(t.id, t.status);
      await this.checkNudge(t, signal);
      if (signal.aborted) return;
      if (!this.seeded) continue;
      const entered = prev === undefined ? ANNOUNCE.has(t.status) : prev !== t.status && ANNOUNCE.has(t.status);
      if (!entered) continue;
      try {
        await this.opts.announce(t, signal);
      } catch (error) {
        if (signal.aborted) return;
        log("warn", `kanban watch: announce failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.seeded = true;
  }

  private launchScheduledPoll(): void {
    if (!this.running || this.scheduledPoll) return;
    const poll = this.tick();
    this.scheduledPoll = poll;
    void poll.then(
      () => this.finishScheduledPoll(poll),
      (error: unknown) => {
        log("warn", `kanban watch: scheduled poll failed: ${error instanceof Error ? error.message : String(error)}`);
        this.finishScheduledPoll(poll);
      },
    );
  }

  private finishScheduledPoll(poll: Promise<void>): void {
    if (this.scheduledPoll !== poll) return;
    this.scheduledPoll = undefined;
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.launchScheduledPoll();
    }, Math.max(0, this.opts.intervalMs));
  }

  /**
   * A task with no started_at past the nudge threshold gets "nobody's picked
   * this up" reminders that KEEP COMING until someone starts it (deliberate:
   * one ping is missable). Persistent, not spammy — the gap doubles each
   * reminder (1h → 2h → 4h with the default threshold), capped at 4h or the
   * configured base, whichever is larger. Age comes from created_at, so
   * unlike transition announcements this fires from the first poll — a stale
   * todo is still news at boot.
   */
  private async checkNudge(t: KanbanTask, signal: AbortSignal): Promise<void> {
    const { nudge, nudgeAfterMs } = this.opts;
    if (!nudge || !nudgeAfterMs) return;
    if (t.started_at || ANNOUNCE.has(t.status) || typeof t.created_at !== "number") {
      this.nudged.delete(t.id); // picked up or resolved — stop reminding
      return;
    }
    const now = this.opts.now?.() ?? Date.now();
    const waitedMs = now - t.created_at * 1000;
    if (waitedMs < nudgeAfterMs) return;
    const state = this.nudged.get(t.id) ?? { count: 0, nextAt: 0 };
    if (now < state.nextAt) return;
    const gap = Math.min(nudgeAfterMs * 2 ** state.count, Math.max(nudgeAfterMs, 4 * 3_600_000));
    this.nudged.set(t.id, { count: state.count + 1, nextAt: now + gap });
    try {
      await nudge(t, waitedMs / 60_000, state.count + 1, signal);
    } catch (error) {
      if (signal.aborted) return;
      log("warn", `kanban watch: nudge failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
