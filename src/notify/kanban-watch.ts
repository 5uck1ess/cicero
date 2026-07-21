import { log } from "../logger";
import { CommandAbortError, runBoundedCommand } from "../process/bounded-command";

const KANBAN_COMMAND_TIMEOUT_MS = 10_000;
const KANBAN_LIST_STDOUT_LIMIT_BYTES = 1024 * 1024;
const KANBAN_LINK_STDOUT_LIMIT_BYTES = 256 * 1024;
const KANBAN_STDERR_LIMIT_BYTES = 64 * 1024;
export const KANBAN_SNAPSHOT_TASK_LIMIT = 1_000;

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

export interface KanbanSnapshot {
  tasks: readonly KanbanTask[];
  asOfMs: number;
  truncated: boolean;
  totalTasks: number;
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

/** Cap on parent ids read from a task's detail — a sane board has a handful. */
const MAX_PARENT_IDS = 32;

/** How often a parked (parent-gated) task re-evaluates its gate. */
const GATE_RECHECK_MS = 5 * 60_000;

/**
 * Per-lookup deadline for a parent-gate detail read. Deliberately shorter than
 * the general command timeout: a `show <id>` is a fast point read, and the poll
 * loop runs these sequentially, so a slow one must not dominate a poll.
 */
const GATE_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * Most parent-gate lookups run in a single poll. Beyond this, a task's gate
 * decision is deferred to a later poll rather than running an unbounded number
 * of sequential subprocesses — which would delay every later task's nudge and
 * announcement in the same poll. Deferred tasks keep their escalation state and
 * are re-evaluated on the next cadence, so nothing is skipped, only spread out.
 *
 * Deferred tasks are marked due again immediately while looked-up-gated tasks
 * enter the longer {@link GATE_RECHECK_MS} cooldown, so on the next poll the
 * overflow is what's due and rotates in — fair coverage as long as the poll
 * interval is shorter than the gate recheck window (the default 20s vs 5min has
 * a wide margin). Only if an operator sets a poll interval LONGER than the gate
 * recheck could tasks early in a very large gated backlog keep winning the
 * budget; that misconfiguration delays (never drops) a reminder.
 */
const MAX_GATE_LOOKUPS_PER_POLL = 16;

/**
 * Parent statuses that DON'T gate a child — a parent in any of these has
 * reached a terminal state, so the dependency is satisfied. Anything else that
 * is present on the board (todo/doing/blocked/…) is an unfinished parent that
 * gates. Matched case-insensitively. Terminal-but-not-"done" statuses like
 * `archived`/`cancelled` are included so a child is never silenced forever
 * behind a parent that will never reach exactly `done`.
 */
const SATISFIED_PARENT_STATUSES = new Set([
  "done",
  "complete",
  "completed",
  "resolved",
  "closed",
  "archived",
  "cancelled",
  "canceled",
]);

/**
 * A task's parent ids from `<task_command> <id> --json`. The board's list
 * output omits parents (it is null there), so a dependency gate is only
 * visible via the per-task detail. Returns [] when the task has no parents,
 * the field is absent/malformed, or the CLI hiccups — a lookup failure must
 * never be mistaken for "gated" (that would silence a genuinely stalled task).
 */
export async function taskParentsViaCli(
  id: string,
  command: string[],
  options: KanbanCommandOptions = {},
): Promise<string[]> {
  try {
    const result = await runBoundedCommand([...command, id, "--json"], {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? GATE_LOOKUP_TIMEOUT_MS,
      stdoutLimitBytes: KANBAN_LINK_STDOUT_LIMIT_BYTES,
      stderrLimitBytes: KANBAN_STDERR_LIMIT_BYTES,
      totalLimitBytes: KANBAN_LINK_STDOUT_LIMIT_BYTES + KANBAN_STDERR_LIMIT_BYTES,
      outputLimitBehavior: "error",
      stderrCapture: "tail",
    });
    if (result.exitCode !== 0) return [];
    const d = JSON.parse(result.stdout.text) as { parents?: unknown };
    if (!Array.isArray(d.parents)) return [];
    return d.parents
      .filter((p): p is string => typeof p === "string")
      .slice(0, MAX_PARENT_IDS)
      .map((p) => p.slice(0, 128));
  } catch (error) {
    if (error instanceof CommandAbortError || options.signal?.aborted) throw error;
    return [];
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
  /** Last successful bounded board read. Failed polls never replace it. */
  private lastSnapshot: KanbanSnapshot | null = null;

  /** Per unstarted task: reminders already sent and when the next is allowed. */
  private nudged = new Map<string, { count: number; nextAt: number }>();

  /** Status by id from the current poll's task list — used for parent-gate checks. */
  private statusById = new Map<string, string>();

  /** Parent-gate lookups spent in the current poll — reset each poll, bounded. */
  private gateLookupsThisPoll = 0;

  constructor(private opts: {
    list: (signal: AbortSignal) => Promise<KanbanTask[]>;
    /** Called with the transitioned task — the caller formats and voices it. */
    announce: (task: KanbanTask, signal: AbortSignal) => void | Promise<void>;
    intervalMs: number;
    /** Called for each reminder about a task sitting unstarted past nudgeAfterMs. */
    nudge?: (task: KanbanTask, waitedMinutes: number, nth: number, signal: AbortSignal) => void | Promise<void>;
    nudgeAfterMs?: number;
    /**
     * A task's parent ids (the list feed omits them). When provided, a task
     * whose parent is still on the board in a non-terminal status is treated as
     * parked behind a dependency, not neglected, so no "nobody picked this up"
     * nudge fires. Absent = nudge on age alone (previous behavior).
     */
    parents?: (task: KanbanTask, signal: AbortSignal) => Promise<string[]>;
    /**
     * How often a parent-gated task re-checks its gate (ms). A parked task is
     * re-evaluated at most this often, NOT every poll, so a large/slow board
     * never runs a parent-lookup subprocess per parked task per poll. Default
     * {@link GATE_RECHECK_MS}; tests set 0 to re-check on every tick.
     */
    gateRecheckMs?: number;
    /** Clock override for tests. */
    now?: () => number;
  }) {}

  /** Whether polling has been started (and not yet stopped). */
  get polling(): boolean {
    return this.running;
  }

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

  /** Read-only cached state for latency-sensitive voice turns; never polls. */
  snapshot(): KanbanSnapshot | null {
    if (!this.lastSnapshot) return null;
    return {
      asOfMs: this.lastSnapshot.asOfMs,
      truncated: this.lastSnapshot.truncated,
      totalTasks: this.lastSnapshot.totalTasks,
      tasks: this.lastSnapshot.tasks.map((task) => ({ ...task })),
    };
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
    this.lastSnapshot = {
      asOfMs: this.opts.now?.() ?? Date.now(),
      truncated: tasks.length > KANBAN_SNAPSHOT_TASK_LIMIT,
      totalTasks: tasks.length,
      tasks: tasks.slice(0, KANBAN_SNAPSHOT_TASK_LIMIT).map(boundedTask).filter((task): task is KanbanTask => task !== null),
    };
    // Whole-list status map, built before the loop so a parent-gate check sees
    // every current status regardless of task order (a child may precede its
    // parent). A parent absent here (done-and-archived, or off the board) is
    // treated as a satisfied gate.
    this.statusById = new Map(
      tasks.filter((t) => t?.id && typeof t.status === "string").map((t) => [t.id, t.status]),
    );
    this.gateLookupsThisPoll = 0; // fresh per-poll subprocess budget
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
    // Gate check happens only here — right before a nudge would fire — so the
    // per-task detail lookup runs for the rare stale-and-due task, not every
    // task every poll. A task parked behind an unfinished parent is waiting by
    // design, not neglected.
    const recheckMs = this.opts.gateRecheckMs ?? GATE_RECHECK_MS;
    if (this.opts.parents) {
      // Bound the sequential subprocess work in one poll: past the budget, defer
      // this task's gate decision to a later poll rather than let a large board
      // run an unbounded chain of ~seconds-long lookups that would delay every
      // later task's nudge and announcement. Deferred tasks stay due (not the
      // longer gate cooldown) so once the looked-up tasks enter their cooldown
      // the overflow rotates in and no task is starved. Escalation is preserved.
      if (this.gateLookupsThisPoll >= MAX_GATE_LOOKUPS_PER_POLL) {
        this.nudged.set(t.id, { count: state.count, nextAt: now });
        return;
      }
      this.gateLookupsThisPoll++;
      if (await this.isGatedByParent(t, signal)) {
        // The lookup may have awaited across a shutdown; a superseded/aborted
        // poll must not publish a late nudge into a stopped watcher.
        if (signal.aborted) return;
        // Re-check the gate on a bounded cadence rather than every poll, so a
        // parked task doesn't run a parent-lookup subprocess on every poll.
        // Escalation state (count) is preserved so an eventual un-gating nudges
        // at the right level instead of restarting from zero.
        this.nudged.set(t.id, { count: state.count, nextAt: now + recheckMs });
        return;
      }
      if (signal.aborted) return;
    }
    const gap = Math.min(nudgeAfterMs * 2 ** state.count, Math.max(nudgeAfterMs, 4 * 3_600_000));
    this.nudged.set(t.id, { count: state.count + 1, nextAt: now + gap });
    try {
      await nudge(t, waitedMs / 60_000, state.count + 1, signal);
    } catch (error) {
      if (signal.aborted) return;
      log("warn", `kanban watch: nudge failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * True when the task has a parent still on the board in a non-terminal status
   * — i.e. a dependency gate that has not opened. Deliberately fails toward
   * informing rather than hiding a possibly-stalled task:
   * - A lookup failure returns false (the nudge fires) — a broken detail command
   *   must never silence a genuinely neglected task.
   * - A parent absent from the current board returns not-gating. NOTE: if the
   *   configured list command filters (by assignee/status/tenant), an unfinished
   *   parent it omits looks satisfied; on a filtered board this can still let a
   *   nudge through. That is the safe direction (a spurious reminder, never a
   *   silenced task) and single-operator Hermes boards are unfiltered.
   * - A terminal-but-not-`done` parent ({@link SATISFIED_PARENT_STATUSES},
   *   e.g. `archived`) does NOT gate, so a child is never parked forever behind
   *   a parent that will never reach exactly `done`. A self-parent never gates.
   * The status snapshot is taken once per poll, so a parent that flips right
   * after the snapshot is one poll stale — bounded and self-correcting.
   */
  private async isGatedByParent(t: KanbanTask, signal: AbortSignal): Promise<boolean> {
    if (!this.opts.parents) return false;
    let parentIds: string[];
    try {
      parentIds = await this.opts.parents(t, signal);
    } catch (error) {
      if (signal.aborted) return false;
      log("warn", `kanban watch: parent lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    return parentIds.some((pid) => {
      if (pid === t.id) return false; // a self-parent is not a real dependency
      const status = this.statusById.get(pid);
      if (status === undefined) return false; // not on the board = treated as satisfied
      return !SATISFIED_PARENT_STATUSES.has(status.toLowerCase());
    });
  }
}

function boundedTask(task: KanbanTask): KanbanTask | null {
  if (!task || typeof task.id !== "string" || typeof task.status !== "string") return null;
  return {
    id: task.id.slice(0, 128),
    title: typeof task.title === "string" ? task.title.slice(0, 240) : "(untitled)",
    status: task.status.slice(0, 64),
    assignee: typeof task.assignee === "string" ? task.assignee.slice(0, 128) : task.assignee ?? null,
    created_at: typeof task.created_at === "number" && Number.isFinite(task.created_at) ? task.created_at : null,
    started_at: typeof task.started_at === "number" && Number.isFinite(task.started_at) ? task.started_at : null,
  };
}
