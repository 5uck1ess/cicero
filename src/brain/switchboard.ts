import type { BackgroundTurnOptions, Brain, BrainTurnOptions, PendingConfirmation } from "../types";
import { dialBackMemo, matchCallMe } from "../call-intent";
import { log } from "../logger";
import { BrainTurnContext } from "./turn-context";
import { bindBrainCapability } from "./capabilities";
import { segmentSentences } from "../speaker/sentence-stream";
import { collectPendingConfirmations, hasPendingConfirmations, relayBoundConfirmation, resolveBoundConfirmation } from "./approval";

/** Sentence count using the SAME segmentation the TTS pipeline applies, so the
 * standup's per-sentence voice queue stays aligned with what actually renders. */
async function sentenceCount(text: string): Promise<number> {
  let n = 0;
  for await (const s of segmentSentences((async function* () { yield text; })())) {
    if (s.trim()) n++;
  }
  return n;
}

/**
 * Lane switchboard: Cicero as the front desk of a multi-agent "office". Each
 * lane is another agent (e.g. a hermes profile — the coder, the thinker) with
 * its own conversation, memory, and optionally its own TTS voice. Saying
 * "let me talk to the coder" PINS the conversation to that lane — every turn
 * goes to that employee until "back to Cicero" releases it. Switching is
 * sticky and lexical (a phone transfer, not per-utterance relay), which is
 * the whole point: the human stops being the context mule between chats.
 *
 * Lanes start lazily on first pin — a roster of employees shouldn't cost a
 * process each at boot.
 */

export interface LaneDef {
  brain: Brain;
  /** Extra spoken names that resolve to this lane ("the coder", "code guy"). */
  aliases?: string[];
  /** TTS voice override while this lane is pinned — employees sound different. */
  voice?: string;
  /** Spoken when the lane picks up. Default: "<Name> here." */
  greeting?: string;
  /**
   * In-character speaking instructions injected into the lane's first turn
   * (rides the agent's conversation from then on). Personality, not policy —
   * the agent's own profile still governs how it works.
   */
  persona?: string;
}

export interface SwitchboardOptions {
  /** Absolute wall-clock budget for one started lane's standup check-in. */
  standupLaneTimeoutMs?: number;
}

const DEFAULT_STANDUP_LANE_TIMEOUT_MS = 20_000;
/** Bun/JavaScript timers overflow above a signed 32-bit millisecond delay. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_STANDUP_ERROR_LOG_CHARS = 240;

interface RollcallVoiceQueue {
  /** Unique lease: stale generators may mutate or clear only their own queue. */
  readonly owner: symbol;
  readonly voices: Array<string | null>;
  /** Active standups append voices over time; sealed queues are complete. */
  sealed: boolean;
  /** Present only while a standup owns cancellable downstream work. */
  readonly scope?: AbortController;
  /** Public turn that owns this voice lease until it completes successfully. */
  readonly turn: AcceptedTurn;
  /** Caller cancellation remains meaningful until TTS drains the lease. */
  detachAbort: () => void;
}

interface AcceptedTurn {
  /** Monotonic generation used to reject late completion from older turns. */
  readonly sequence: number;
  /** Aborted immediately when a newer public turn is accepted. */
  readonly superseded: AbortController;
  /** Locally-owned signal fed by caller cancellation while the turn is live. */
  readonly signal: AbortSignal;
  readonly callerSignal: AbortSignal | undefined;
  /** Completion disarms generation supersession without aborting provider state. */
  settled: boolean;
  detachAbort: () => void;
  detachCaller: () => void;
}

interface LaneStartLifecycle {
  /** A global stop retires the attempt without waiting for an uncooperative start. */
  retired: boolean;
  promise: Promise<void>;
}

/**
 * Reject immediately on cancellation even when downstream ignores its signal.
 * Both branches remain observed, and the abort listener is removed on settle.
 */
function raceWithSignal<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  // Observe `work` before examining an already-aborted signal. Iterator.next()
  // may have returned a rejected promise while resuming stale generator code;
  // throwing first would strand that rejection as unhandled.
  const promise = Promise.resolve(work);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const finish = (callback: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      try {
        signal.throwIfAborted();
      } catch (error: unknown) {
        fail(error);
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(resolve, value),
      (error: unknown) => fail(error),
    );
    if (signal.aborted) onAbort();
  });
}

/** Race every iterator pull; never await an uncooperative iterator's return. */
async function* iterateWithSignal<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const next = await raceWithSignal(iterator.next(), signal);
      if (next.done) {
        completed = true;
        return;
      }
      signal.throwIfAborted();
      yield next.value;
    }
  } finally {
    if (!completed && iterator.return) {
      const cleanup = Promise.resolve().then(() => iterator.return!());
      void cleanup.catch(() => { /* downstream cancellation cleanup is best-effort */ });
    }
  }
}

class StandupLaneTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`standup lane exceeded its ${timeoutMs}ms deadline`);
    this.name = "StandupLaneTimeoutError";
  }
}

class SwitchboardTurnSupersededError extends Error {
  constructor() {
    super("switchboard turn superseded by a newer accepted turn");
    this.name = "SwitchboardTurnSupersededError";
  }
}

class LaneStartRetiredError extends Error {
  constructor(readonly lane: string) {
    super(`lane ${lane} start was retired by a lifecycle boundary`);
    this.name = "LaneStartRetiredError";
  }
}

// Matched against a normalized utterance (commas stripped, whitespace collapsed,
// trailing punctuation removed) so STT decoration ("I said, let me talk to the
// coder.") can't defeat a transfer. Lead-ins, question forms ("can you…"), and a
// trailing "please" are all tolerated — real callers don't speak in imperatives.
const LEAD_IN = "(?:(?:hey|ok(?:ay)?|so|yes|yeah|alright|please|wait|cicero|jarvis|i said|again)\\s+){0,3}";
const ASK_WRAP = "(?:(?:can|could|would|will) you\\s+|(?:can|could|may) i\\s+|i (?:want|need) to\\s+|i(?:'d| would) like to\\s+)?(?:please\\s+)?";
// STRICT verbs are unambiguous transfer requests — an unknown name gets the
// spoken roster. LOOSE verbs ("get me", "give me", "talk to", "put") appear in
// ordinary sentences ("give me your opinion"), so they only transfer when the
// name resolves to a real lane; otherwise the turn goes to the brain as usual.
const STRICT_VERB = "let me (?:talk|speak) (?:to|with)|switch(?: me)?(?: over)? to|connect me (?:to|with)|put me through to|transfer me (?:over )?to|transfer to";
// "pass/hand/patch me to <name>" live here, not in STRICT: with a resolvable
// name they transfer; with a description ("whoever handles the code") they
// fall through to the classifier instead of dead-ending at the roster.
const LOOSE_VERB = "(?:talk|speak) (?:to|with)|put|get me|give me|pass me (?:over |through )?to|hand me (?:over )?to|patch me (?:through |over )?to";
const PIN_RE = new RegExp(`^${LEAD_IN}${ASK_WRAP}(?:(${STRICT_VERB})|(?:${LOOSE_VERB}))\\s+(?:the\\s+)?(?!me\\b|you\\b|us\\b)(.{1,60}?)(?:\\s+on(?: the line)?)?(?:\\s+please)?$`, "i");
const RELEASE_RE = new RegExp(`^${LEAD_IN}(?:thanks\\s+|thank you\\s+)?(?:(?:go |switch )?back to (?:you|cicero|jarvis)|(?:cicero|jarvis) come back|switch back|that(?:'s| is) all(?: for now)?|hang up|end (?:the )?(?:call|transfer))(?:\\s+please)?$`, "i");
// Roll call: every employee checks in, each sentence rendered in that lane's
// own voice (the voice queue below feeds activeLaneVoice per sentence).
// "Group call" style requests land here too — there's no conference mode, so
// hearing everyone briefly IS what "bring everyone in" can mean.
const GROUP_ASK = "(?:(?:can|could|would|will) (?:you|we)\\s+)?(?:please\\s+)?(?:just\\s+)?(?:do\\s+a(?:nother)?\\s+|let's\\s+(?:do|have)\\s+a(?:nother)?\\s+)?";
// Trailing qualifiers callers naturally append to group requests: "roll call
// WITH EVERYONE", "status FROM EACH AGENT" — same request, must not break the match.
const GROUP_REF = "(?:every(?:one|body)|the (?:team|office|agents?)|all(?:\\s+(?:of\\s+)?(?:them|you|the agents?))?|each(?:\\s+(?:one|agent|of (?:them|you)))?)";
const GROUP_TAIL = `(?:\\s+(?:with|from|of|for)\\s+${GROUP_REF})?`;
const ROLLCALL_RE = new RegExp(
  `^${LEAD_IN}${GROUP_ASK}(?:` +
    "avengers\\s+assemble|(?:do|let's do) a(?:nother)? roll\\s?-?call|roll\\s?-?call" +
    "|(?:i want\\s+|i'd like\\s+)?(?:to\\s+)?(?:have\\s+|get\\s+|bring\\s+)?every(?:one|body)(?:\\s+to)?\\s+(?:check(?:\\s|-)?in|say (?:hi|hello)|join(?:\\s+(?:in|the (?:call|conversation)))?|come in)" +
    "|(?:have\\s+|get\\s+|bring\\s+)every(?:one|body)(?:\\s+(?:in(?:to the (?:call|conversation))?|on the line|in here))?" +
    "|all hands(?:\\s+on deck)?|team\\s+check\\s?-?in|group call(?:\\s+with everyone)?" +
  `)${GROUP_TAIL}(?:\\s+please)?$`, "i");
// Bare repeat requests ("again", "one more time") re-run the last group action
// — a caller who just heard a roll call points at it instead of restating it
// (live miss 2026-07-12). Only honored while lastGroupAction is set; any
// normal brain turn in between clears it, so "again" in ordinary conversation
// still goes to whoever's on the line.
const AGAIN_RE = new RegExp(
  `^${LEAD_IN}(?:do (?:it|that) again|(?:run|say) (?:it|that) again|again|another(?:\\s+one)?|one more(?:\\s+time)?|once more|repeat (?:it|that))(?:\\s+please)?$`, "i");
// Standup: every employee reports what it's working on, one line each, in its
// own voice. Started lanes are actually asked; idle lanes say so.
const STANDUP_RE = new RegExp(
  `^${LEAD_IN}${GROUP_ASK}(?:` +
    "(?:daily\\s+)?stand\\s?-?up" +
    "|(?:i (?:want|need)\\s+(?:the\\s+|a\\s+)?)?status(?:\\s+(?:report|update))?\\s+from\\s+(?:every(?:one|body)|each(?:\\s+(?:one|of (?:them|you)))?|the (?:team|office)|all(?: of (?:them|you))?)" +
    "|(?:get|give)\\s+me\\s+(?:a\\s+|the\\s+)?(?:team\\s+)?status(?:\\s+(?:report|update))?(?:\\s+from\\s+every(?:one|body))?" +
    "|what(?:'s| is) every(?:one|body)\\s+(?:working on|doing|up to)" +
    "|every(?:one|body)\\s+report(?:\\s+in)?|all hands report" +
    // Bare "status" needs an explicit group reference ("the status of each
    // agent") — plain "status?" stays a normal turn for whoever's pinned.
    `|(?:i (?:want|need)\\s+)?(?:a\\s+|the\\s+)?status(?:\\s+(?:report|update))?\\s+(?:with|from|of|for)\\s+${GROUP_REF}` +
  `)${GROUP_TAIL}(?:\\s+please)?$`, "i");

// Cheap gate for the intent classifier: only utterances containing control-ish
// vocabulary are worth a classification round-trip; everything else goes
// straight to the brain with zero added latency.
const CONTROLISH_RE = /\b(?:every(?:one|body)|team|office|roll|status|check|transfer|switch|connect|talk|speak|bring|put|pass|hand|patch|line|hang|stand\s?-?up|report|back|join|agents?|all hands|assemble|conference|group|call|ring|phone|dial)\b/i;

// Voicemail is matched on the RAW utterance (not normalized) so the message
// body keeps its punctuation — it's delivered as text, not as a pattern.
const VOICEMAIL_RE = /^(?:(?:hey|ok(?:ay)?|cicero|please)[,\s]+){0,2}(?:can you\s+|could you\s+)?(?:leave|take|pass(?: along)?)\s+(?:a\s+)?(?:message|note|word)\s+(?:for|to)\s+([^:,]{1,40}?)\s*[:,]\s*(.+)$/i;

/** Spoken form of a lane name: short codes read as initials ("qa" → "QA"). */
function laneTitle(name: string): string {
  return name.length <= 2 ? name.toUpperCase() : name[0]!.toUpperCase() + name.slice(1);
}

/**
 * The name a colleague is actually called — the lane's first alias ("Ada"),
 * title-cased; the lane id ("coder") is plumbing and only surfaces when no
 * alias exists. Everything spoken to the user goes through here.
 */
function workingName(name: string, def?: LaneDef): string {
  const called = def?.aliases?.[0];
  if (!called) return laneTitle(name);
  // "the" stays lowercase ("the coder" → "the Coder") so the name reads
  // naturally mid-sentence; sentence starts capitalize it themselves.
  return called.replace(/\b\w+/g, (w) => (w === "the" ? w : w[0]!.toUpperCase() + w.slice(1)));
}

/** Capitalize the first character — for working names opening a sentence. */
function sentenceCase(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Levenshtein distance — small strings only (lane names and aliases). */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3; // beyond any budget — skip the work
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function clipText(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Keep adapter failures useful in logs without copying unbounded output. */
function boundedError(error: unknown): string {
  try {
    const detail = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
    return clipText(detail, MAX_STANDUP_ERROR_LOG_CHARS) || "unknown error";
  } catch {
    return "unprintable error";
  }
}

/** Collapse STT decoration so the whole-utterance anchors still hold. */
function normalizeUtterance(message: string): string {
  return message.trim().replace(/,/g, "").replace(/\s+/g, " ").replace(/[.!?\s]+$/, "");
}

/** Normalize a captured lane reference: lowercase, strip filler and punctuation. */
function normalizeRef(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,!?'"]/g, "")
    .replace(/\b(?:please|now|again|lane|profile|agent|employee)\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // The pin pattern consumes a leading "the" before its capture, so aliases
    // written naturally ("the thinker") must drop theirs too or never match.
    .replace(/^the\s+/, "");
}

export class SwitchboardBrain implements Brain {
  /** Pinned lane name, or null = the front desk (primary). */
  private active: string | null = null;
  private started = new Set<string>();
  /** Cold starts outlive initiating turns and are shared by concurrent callers. */
  private laneStarts = new Map<string, LaneStartLifecycle>();
  /** Cleanup calls coalesce when a failing start races global shutdown. */
  private laneStops = new Map<string, Promise<void>>();
  /** Persona context belongs to a lane lifecycle, not to each start attempt. */
  private personaInstalled = new Set<string>();
  /** Per-control-turn voice lease; null entries select the front desk voice. */
  private rollcall: RollcallVoiceQueue | null = null;
  /** True when the last turn was answered lexically (ack/roll call/standup). */
  private control = false;
  /** The group action "again" repeats; cleared when a normal brain turn intervenes. */
  private lastGroupAction: "rollcall" | "standup" | null = null;
  /** The most recent real exchange, for handoff briefings on transfer. */
  private lastExchange: { speaker: string; user: string; reply: string } | null = null;
  /** Bounded tail of the pinned lane's conversation, for the release recap —
   * the mirror of the handoff briefing: the front desk gets back a caller it
   * can talk to coherently about what just happened. */
  private laneLog: Array<{ user: string; reply: string }> = [];
  private static readonly LANE_LOG_TURNS = 5;
  private turnContext = new BrainTurnContext();
  private readonly standupLaneTimeoutMs: number;
  private acceptedTurnSequence = 0;
  private acceptedTurn: AcceptedTurn | null = null;
  private stopping = false;
  private lifecycleSequence = 0;
  private lifecycleBarrier: Promise<void> = Promise.resolve();
  private primaryStop: Promise<void> | null = null;
  private primaryStopBarrier: Promise<void> = Promise.resolve();

  constructor(
    private primary: Brain,
    private lanes: Record<string, LaneDef>,
    /** Optional small-local-model classifier for phrasings the patterns miss. */
    private classify?: (prompt: string, signal?: AbortSignal) => Promise<string>,
    options: SwitchboardOptions = {},
  ) {
    const configured = options.standupLaneTimeoutMs;
    if (configured !== undefined && (
      !Number.isSafeInteger(configured)
      || configured <= 0
      || configured > MAX_TIMER_DELAY_MS
    )) {
      throw new RangeError(
        `standupLaneTimeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`,
      );
    }
    this.standupLaneTimeoutMs = configured ?? DEFAULT_STANDUP_LANE_TIMEOUT_MS;
  }

  /** Which lane is pinned right now (for logging/UX). */
  activeLane(): string | null {
    return this.active;
  }

  /** Daemon-injected dial-back: rings the user's phone (optionally with a
   * named employee picking up). Returns the spoken ack. Absent = the intent
   * falls through to a normal brain turn, exactly as before. */
  private callMe?: (who?: string, options?: BrainTurnOptions) => Promise<string>;
  setCallMeHandler(handler: (who?: string, options?: BrainTurnOptions) => Promise<string>): void {
    this.callMe = handler;
  }

  /**
   * Programmatic transfer — the Telegram "have ada call me" path. Resolves a
   * typed name through the same alias/fuzzy table as spoken transfers and pins
   * the lane, so whoever picks up the resulting call IS that employee. Returns
   * the working name once they're on the line; null when nobody matched or the
   * lane wouldn't start (pinLane logs which) — the caller owns that reply.
   *
   * `brief` (given the resolved lane id) builds call context — e.g. "you're
   * being called about your blocked task" — injected before the lane picks up,
   * so it rides the first turn of the call. A failing brief never blocks the
   * transfer.
   */
  transferTo(
    ref: string,
    brief?: (lane: string) => Promise<string | null>,
    options?: BrainTurnOptions,
  ): Promise<string | null> {
    return this.runAcceptedTurn(options, async (turn) => {
      const lane = this.resolveLane(ref);
      this.assertAcceptedTurn(turn);
      if (!lane) return null;

      let context: string | null = null;
      if (brief) {
        try {
          context = await raceWithSignal(
            Promise.resolve().then(() => {
              turn.signal.throwIfAborted();
              return brief(lane);
            }),
            turn.signal,
          );
        } catch {
          // Brief failures are best-effort; supersession/caller cancellation is
          // rethrown by the generation assertion instead of being swallowed.
          this.assertAcceptedTurn(turn);
        }
      }

      await this.pinLane(lane, turn, context);
      this.assertAcceptedTurn(turn);
      if (this.active !== lane) return null; // lane failed to start — pin never took
      return workingName(lane, this.lanes[lane]);
    });
  }

  /** TTS voice for the current speaker — undefined = the default (Cicero's) voice. */
  activeLaneVoice(): string | undefined {
    const queue = this.rollcall;
    if (queue && queue.voices.length > 0) {
      const lane = queue.voices.shift();
      if (queue.voices.length === 0 && queue.sealed && this.rollcall === queue) {
        queue.detachAbort();
        this.rollcall = null;
      }
      return lane ? this.lanes[lane]?.voice : undefined;
    }
    return this.active ? this.lanes[this.active]?.voice : undefined;
  }

  /**
   * Install one control turn's voice lease. A newer control response owns the
   * singleton activeLaneVoice() channel, so it also cancels an older standup's
   * still-running lane work. Identity checks keep the older generator from
   * clearing or appending to the replacement queue while it unwinds.
   */
  private beginRollcall(
    voices: Array<string | null>,
    options: { sealed: boolean; scope?: AbortController },
    turn: AcceptedTurn,
  ): RollcallVoiceQueue {
    this.assertAcceptedTurn(turn);
    const previous = this.rollcall;
    if (previous?.scope && !previous.sealed && !previous.scope.signal.aborted) {
      previous.scope.abort(new SwitchboardTurnSupersededError());
    }
    previous?.detachAbort();
    const queue: RollcallVoiceQueue = {
      owner: Symbol("switchboard-rollcall"),
      voices,
      sealed: options.sealed,
      scope: options.scope,
      turn,
      detachAbort: () => {},
    };
    this.rollcall = queue;
    const voiceSignal = turn.callerSignal;
    const onAbort = (): void => {
      if (this.rollcall !== queue) return;
      const reason = voiceSignal?.reason instanceof Error
        ? voiceSignal.reason
        : new Error("switchboard voice lease cancelled");
      this.discardRollcall(reason);
    };
    voiceSignal?.addEventListener("abort", onAbort, { once: true });
    queue.detachAbort = () => voiceSignal?.removeEventListener("abort", onAbort);
    if (voiceSignal?.aborted) onAbort();
    return queue;
  }

  private assertRollcallOwner(
    queue: RollcallVoiceQueue,
    signal: AbortSignal,
    turn: AcceptedTurn,
  ): void {
    this.assertAcceptedTurn(turn);
    signal.throwIfAborted();
    if (this.rollcall !== queue) throw new SwitchboardTurnSupersededError();
  }

  private finishRollcall(queue: RollcallVoiceQueue): void {
    queue.sealed = true;
    if (this.rollcall === queue && queue.voices.length === 0) {
      queue.detachAbort();
      this.rollcall = null;
    }
  }

  private abandonRollcall(queue: RollcallVoiceQueue): void {
    queue.detachAbort();
    if (this.rollcall === queue) this.rollcall = null;
  }

  private discardRollcall(reason: Error): void {
    const queue = this.rollcall;
    if (queue?.scope && !queue.sealed && !queue.scope.signal.aborted) {
      queue.scope.abort(reason);
    }
    queue?.detachAbort();
    if (this.rollcall === queue) this.rollcall = null;
  }

  /**
   * Every accepted public turn owns the singleton voice route from its first
   * instruction onward. Centralizing supersession here covers early lexical
   * returns (confirmation, bare-name transfer, and voicemail) as well as
   * ordinary/model-backed turns without letting a late control path clear a
   * newer turn's lease.
   */
  private beginAcceptedTurn(options?: BrainTurnOptions): AcceptedTurn {
    options?.signal?.throwIfAborted();
    if (this.stopping) throw new Error("switchboard is stopping");
    const reason = new SwitchboardTurnSupersededError();
    const previous = this.acceptedTurn;
    if (previous && !previous.superseded.signal.aborted) {
      previous.superseded.abort(reason);
    }
    const superseded = new AbortController();
    const turn: AcceptedTurn = {
      sequence: ++this.acceptedTurnSequence,
      superseded,
      signal: superseded.signal,
      callerSignal: options?.signal,
      settled: false,
      detachAbort: () => {},
      detachCaller: () => {},
    };
    this.acceptedTurn = turn;
    const forwardCallerAbort = (): void => {
      if (!superseded.signal.aborted) superseded.abort(options?.signal?.reason);
    };
    options?.signal?.addEventListener("abort", forwardCallerAbort, { once: true });
    turn.detachCaller = () => options?.signal?.removeEventListener("abort", forwardCallerAbort);
    const onAbort = (): void => this.finishAcceptedTurn(turn, false);
    turn.signal.addEventListener("abort", onAbort, { once: true });
    turn.detachAbort = () => turn.signal.removeEventListener("abort", onAbort);
    if (options?.signal?.aborted) forwardCallerAbort();
    if (turn.signal.aborted) onAbort();
    this.discardRollcall(reason);
    return turn;
  }

  private assertAcceptedTurn(turn: AcceptedTurn): void {
    turn.signal.throwIfAborted();
    if (turn.settled || this.acceptedTurn?.sequence !== turn.sequence || this.acceptedTurn !== turn) {
      throw new SwitchboardTurnSupersededError();
    }
  }

  /**
   * Settle a public turn exactly once. Failed/cancelled turns relinquish only
   * their own voice lease; successful leases remain for the TTS consumer.
   */
  private finishAcceptedTurn(turn: AcceptedTurn, successful: boolean): void {
    if (turn.settled) return;
    turn.settled = true;
    turn.detachAbort();
    turn.detachCaller();
    if (!successful && this.rollcall?.turn === turn) {
      this.discardRollcall(
        turn.signal.aborted && turn.signal.reason instanceof Error
          ? turn.signal.reason
          : new Error("switchboard turn did not complete"),
      );
    }
    if (this.acceptedTurn === turn) this.acceptedTurn = null;
  }

  private abortAcceptedTurn(turn: AcceptedTurn, reason: unknown): void {
    if (turn.settled) return;
    if (!turn.superseded.signal.aborted) turn.superseded.abort(reason);
    this.finishAcceptedTurn(turn, false);
  }

  private cancelCurrentTurn(reason: Error): void {
    const turn = this.acceptedTurn;
    if (turn) this.abortAcceptedTurn(turn, reason);
    // A completed control turn can leave a sealed voice lease after its public
    // promise settles, so lifecycle boundaries must clear that lease as well.
    this.discardRollcall(reason);
  }

  private enqueueLifecycle(work: () => Promise<void>): Promise<void> {
    const ready = this.lifecycleBarrier.catch(() => {});
    const operation = ready.then(work);
    this.lifecycleBarrier = operation.catch(() => {});
    return operation;
  }

  // Coalesced like stopLane(): concurrent shutdown callers share one
  // in-flight primary.stop() — the leaf is not required to be reentrant. The
  // memo clears on settle either way, so a failed stop stays retryable.
  private stopPrimary(): Promise<void> {
    return this.primaryStop ?? this.freshPrimaryStop();
  }

  // Queues a NEW leaf stop behind any in-flight one. Stale-cleanup needs this
  // stronger form: an in-flight stop began before the late start surfaced its
  // process, so sharing it could miss the reap entirely.
  private freshPrimaryStop(): Promise<void> {
    const ready = this.primaryStopBarrier.catch(() => {});
    let stopping!: Promise<void>;
    stopping = ready
      .then(() => this.primary.stop())
      .finally(() => {
        if (this.primaryStop === stopping) this.primaryStop = null;
      });
    this.primaryStopBarrier = stopping.catch(() => {});
    this.primaryStop = stopping;
    return stopping;
  }

  private async cleanupStalePrimary(operation: string): Promise<void> {
    try {
      // Queue behind an already-running shutdown stop. A late start/restart
      // needs a fresh cleanup pass, but Brain.stop() is not required to be
      // reentrant and concurrent calls can corrupt provider-owned state.
      await this.freshPrimaryStop();
    } catch (error: unknown) {
      log("warn", `switchboard: primary cleanup after ${operation} failed: ${boundedError(error)}`);
    }
  }

  private async runAcceptedTurn<T>(
    options: BrainTurnOptions | undefined,
    body: (turn: AcceptedTurn, options: BrainTurnOptions) => Promise<T>,
  ): Promise<T> {
    const turn = this.beginAcceptedTurn(options);
    const turnOptions = this.optionsForTurn(turn, options);
    try {
      const result = await body(turn, turnOptions);
      this.assertAcceptedTurn(turn);
      this.finishAcceptedTurn(turn, true);
      return result;
    } catch (error: unknown) {
      this.abortAcceptedTurn(turn, error);
      throw error;
    }
  }

  /**
   * Own an async iterator explicitly so return()/throw() can abort a provider
   * pull before JavaScript queues generator cleanup behind that pending pull.
   */
  private runAcceptedStream(
    options: BrainTurnOptions | undefined,
    body: (turn: AcceptedTurn, options: BrainTurnOptions) => AsyncIterable<string>,
  ): AsyncIterable<string> {
    let turn: AcceptedTurn | undefined;
    let iterator: AsyncIterator<string> | undefined;
    let closed = false;
    let cleanupStarted = false;
    const initialize = (): void => {
      if (turn || closed) return;
      turn = this.beginAcceptedTurn(options);
      const turnOptions = this.optionsForTurn(turn, options);
      try {
        iterator = body(turn, turnOptions)[Symbol.asyncIterator]();
      } catch (error: unknown) {
        this.abortAcceptedTurn(turn, error);
        closed = true;
        throw error;
      }
    };
    const fail = (error: unknown): void => {
      closed = true;
      if (turn) this.abortAcceptedTurn(turn, error);
    };
    const detachCleanup = (error?: unknown): void => {
      if (cleanupStarted || !iterator) return;
      cleanupStarted = true;
      let cleanup: PromiseLike<IteratorResult<string>> | undefined;
      try {
        cleanup = error !== undefined && iterator.throw
          ? iterator.throw(error)
          : iterator.return?.();
      } catch {
        return;
      }
      if (cleanup) void Promise.resolve(cleanup).catch(() => {});
    };
    const owned: AsyncIterableIterator<string> = {
      [Symbol.asyncIterator](): AsyncIterableIterator<string> {
        return owned;
      },
      next: async (): Promise<IteratorResult<string>> => {
        if (closed) return { done: true, value: undefined };
        initialize();
        try {
          const result = await iterator!.next();
          if (result.done) {
            this.assertAcceptedTurn(turn!);
            closed = true;
            this.finishAcceptedTurn(turn!, true);
          }
          return result;
        } catch (error: unknown) {
          fail(error);
          throw error;
        }
      },
      return: async (): Promise<IteratorResult<string>> => {
        const cancelled = !closed;
        if (cancelled) fail(new Error("switchboard stream consumer stopped"));
        if (cancelled) detachCleanup();
        if (turn) this.finishAcceptedTurn(turn, false);
        return { done: true, value: undefined };
      },
      throw: async (error?: unknown): Promise<IteratorResult<string>> => {
        fail(error ?? new Error("switchboard stream consumer failed"));
        detachCleanup(error);
        if (turn) this.finishAcceptedTurn(turn, false);
        throw error;
      },
    };
    return owned;
  }

  private optionsForTurn(turn: AcceptedTurn, options?: BrainTurnOptions): BrainTurnOptions {
    this.assertAcceptedTurn(turn);
    return { ...options, signal: turn.signal };
  }

  /** Control-plane replies (acks, roll call, standup) skip the TLDR gate. */
  wasControlTurn(): boolean {
    return this.control;
  }

  private resolveLane(ref: string): string | null {
    const want = normalizeRef(ref);
    if (!want) return null;
    for (const [name, def] of Object.entries(this.lanes)) {
      if (normalizeRef(name) === want) return name;
      if (def.aliases?.some((a) => normalizeRef(a) === want)) return name;
    }
    // Fuzzy pass — STT mishears names ("talk to Thank" for think). One edit
    // of slack, two for longer refs, and only when exactly ONE lane matches.
    const budget = want.length >= 7 ? 2 : 1;
    const hits = new Set<string>();
    for (const [name, def] of Object.entries(this.lanes)) {
      const refs = [name, ...(def.aliases ?? [])].map(normalizeRef);
      if (refs.some((r) => r.length >= 4 && editDistance(r, want) <= budget)) hits.add(name);
    }
    if (hits.size === 1) {
      const hit = [...hits][0];
      log("info", `switchboard: fuzzy-matched "${ref}" to lane ${hit}`);
      return hit;
    }
    return null;
  }

  /**
   * Handle a switch command. Returns the spoken acknowledgment, or null when
   * the message is a normal turn for whoever's on the line.
   */
  private doRollcall(turn: AcceptedTurn): string | null {
    this.assertAcceptedTurn(turn);
    const names = Object.keys(this.lanes);
    if (names.length === 0) return null;
    // One sentence per employee, exactly — the voice queue is consumed per
    // rendered sentence, so the ack must segment 1:1 with the queue.
    this.beginRollcall([...names], { sealed: true }, turn);
    this.lastGroupAction = "rollcall";
    log("info", `switchboard: roll call — ${names.join(", ")}`);
    // Recipient-neutral facts only: this note may be read by any persona,
    // including one whose own check-in was part of the roll call.
    this.leaveMemo(`System note: the user just ran a roll call — ${names.join(", ")} each checked in aloud with their current status.`);
    return names.map((n) => `${sentenceCase(workingName(n, this.lanes[n]))} checking in.`).join(" ");
  }

  private doRelease(turn: AcceptedTurn): string | null {
    this.assertAcceptedTurn(turn);
    if (this.active === null) return null; // "that's all" mid-chat with Cicero is just a turn
    const released = this.active;
    log("info", `switchboard: released ${released} — back to the front desk`);
    this.active = null;
    // The front desk never heard the lane conversation, so the memo carries
    // the tail of what it missed (the mirror of the handoff briefing a lane
    // gets on transfer). Recipient-neutral facts only: the one-shot channel
    // delivers to whoever answers next — which can be ${name} itself if the
    // user immediately pins the same lane again.
    const name = workingName(released, this.lanes[released]);
    const recap = this.laneLog.length
      ? ` Their last ${this.laneLog.length === 1 ? "exchange" : `${this.laneLog.length} exchanges`}:\n${this.laneLog
          .map((e) => `  User: "${e.user}" — ${name}: "${e.reply}"`)
          .join("\n")}`
      : "";
    this.laneLog = [];
    this.leaveMemo(`System note: the user just ended a side conversation with ${name} and returned to the main line.${recap}`);
    return "Back with you.";
  }

  /**
   * One lifecycle promise owns each cold lane start. It deliberately does not
   * inherit a turn signal: a superseded caller stops waiting, while a process
   * that still comes up is recorded and remains owned by stop().
   */
  private stopLane(lane: string): Promise<void> {
    const existing = this.laneStops.get(lane);
    if (existing) return existing;

    let stopping!: Promise<void>;
    stopping = Promise.resolve()
      .then(() => this.lanes[lane]!.brain.stop())
      .finally(() => {
        if (this.laneStops.get(lane) === stopping) this.laneStops.delete(lane);
      });
    this.laneStops.set(lane, stopping);
    return stopping;
  }

  private logLaneCleanupFailure(lane: string, error: unknown): void {
    log("warn", `switchboard: lane ${lane} cleanup failed: ${boundedError(error)}`);
  }

  private startLane(lane: string): Promise<void> {
    if (this.started.has(lane)) return Promise.resolve();
    const existing = this.laneStarts.get(lane);
    if (existing) return existing.promise;

    const lifecycle: LaneStartLifecycle = {
      retired: false,
      promise: Promise.resolve(),
    };
    const starting = Promise.resolve().then(() => this.lanes[lane]!.brain.start());
    lifecycle.promise = starting
      .then(
        async () => {
          if (lifecycle.retired) {
            // stop() may have returned before an uncooperative start settled.
            // Reap a process that nevertheless appeared after that boundary.
            await this.stopLane(lane).catch((error: unknown) => {
              this.logLaneCleanupFailure(lane, error);
            });
            throw new LaneStartRetiredError(lane);
          }
          this.started.add(lane);
        },
        async (error: unknown) => {
          log("warn", `switchboard: lane ${lane} failed to start: ${boundedError(error)}`);
          // A rejected start may still have allocated a partial child/session.
          // Finish cleanup before admitting a retry, but preserve the start error.
          await this.stopLane(lane).catch((cleanupError: unknown) => {
            this.logLaneCleanupFailure(lane, cleanupError);
          });
          throw error;
        },
      )
      .finally(() => {
        if (this.laneStarts.get(lane) === lifecycle) this.laneStarts.delete(lane);
      });
    this.laneStarts.set(lane, lifecycle);
    return lifecycle.promise;
  }

  private async pinLane(
    lane: string,
    turn: AcceptedTurn,
    explicitContext: string | null = null,
  ): Promise<string> {
    this.assertAcceptedTurn(turn);
    const def = this.lanes[lane];
    try {
      while (!this.started.has(lane)) {
        const prior = this.laneStarts.get(lane);
        if (prior?.retired) {
          // A new board session must not overlap the old session's unresolved
          // start. Wait interruptibly for its late cleanup, then launch fresh.
          await raceWithSignal(prior.promise, turn.signal).catch(() => {
            this.assertAcceptedTurn(turn);
          });
          this.assertAcceptedTurn(turn);
          continue;
        }

        // Persona must precede the first start, but only a current generation
        // may install it. It belongs to the lifecycle, not each failed attempt.
        this.assertAcceptedTurn(turn);
        if (def.persona && !this.personaInstalled.has(lane)) {
          def.brain.injectContext(def.persona);
          this.personaInstalled.add(lane);
        }
        await raceWithSignal(this.startLane(lane), turn.signal);
        this.assertAcceptedTurn(turn);
      }
    } catch (err: unknown) {
      // Supersession/caller cancellation is control flow, not a failed lane
      // start to translate into a stale spoken acknowledgment.
      this.assertAcceptedTurn(turn);
      return `I couldn't reach ${lane} right now.`;
    }
    this.assertAcceptedTurn(turn);
    if (!this.started.has(lane)) return `I couldn't reach ${lane} right now.`;
    // Programmatic call context is held locally across a cold start. Only the
    // generation that actually pins the lane may install it.
    if (explicitContext) def.brain.injectContext(explicitContext);
    // Handoff briefing belongs only to the generation that actually pins the
    // line; a superseded cold-start initiator must not leave stale context.
    const ex = this.lastExchange;
    if (ex && ex.speaker !== lane) {
      def.brain.injectContext(
        `Handoff from ${ex.speaker}: the user was just discussing — "${clipText(ex.user, 200)}" — and was told: "${clipText(ex.reply, 240)}". Pick up with that context; don't make the user repeat it.`,
      );
      log("info", `switchboard: briefed ${lane} on the ${ex.speaker} exchange`);
    }
    // A redundant re-pin of the line already held continues one conversation;
    // only an actual change of counterpart starts a fresh recap tail.
    if (this.active !== lane) this.laneLog = [];
    this.active = lane;
    log("info", `switchboard: pinned to ${lane}`);
    return def.greeting ?? `${lane[0].toUpperCase()}${lane.slice(1)} here.`;
  }

  /** Voicemail: "leave a message for the coder: ship it tonight" — delivered
   * into that lane's context, spoken back to the user as a confirmation. */
  private takeVoicemail(message: string, turn: AcceptedTurn): string | null {
    this.assertAcceptedTurn(turn);
    const vm = VOICEMAIL_RE.exec(message.trim());
    if (!vm) return null;
    const lane = this.resolveLane(vm[1] ?? "");
    const body = (vm[2] ?? "").trim();
    if (!lane || !body) {
      if (!lane) return `I don't have a line to ${normalizeRef(vm[1] ?? "") || "them"}. I can take a message for: ${Object.keys(this.lanes).join(", ")}.`;
      return null;
    }
    this.lanes[lane].brain.injectContext(
      `Voicemail from the user: "${body}". Acknowledge you got this message the next time you speak with them.`,
    );
    log("info", `switchboard: voicemail taken for ${lane}`);
    return `I'll pass that along to ${workingName(lane, this.lanes[lane])}.`;
  }

  /** Control-plane actions (dial-backs, roll calls, releases) happen outside
   * every brain's context; without a memo the persona flatly denies things
   * the user just watched happen ("did you call me?" seconds after the phone
   * rang — live incident 2026-07-13). The note rides the switchboard's
   * bounded one-shot turn context, so it follows routing to whichever brain
   * actually answers the next turn — not whoever happened to be pinned when
   * the action ran — and repeated control turns pool instead of piling up. */
  private leaveMemo(note: string): void {
    this.turnContext.inject(note);
  }

  private async handleControl(message: string, turn: AcceptedTurn): Promise<string | null> {
    this.assertAcceptedTurn(turn);
    const m = normalizeUtterance(message);
    if (ROLLCALL_RE.test(m)) return this.doRollcall(turn);
    if (RELEASE_RE.test(m)) return this.doRelease(turn);
    // Spoken dial-back ("call me", "have ada call me") — must beat PIN_RE:
    // "have ada call me" would otherwise read as a transfer to "ada call".
    if (this.callMe) {
      const call = matchCallMe(m);
      if (call) {
        log("info", `switchboard: dial-back requested${call.who ? ` — ${call.who}` : ""}`);
        const reply = await this.callMe(call.who, { signal: turn.signal });
        // Memo even if this turn was superseded meanwhile: the call was placed.
        this.leaveMemo(dialBackMemo(call.who));
        return reply;
      }
    }
    const pin = PIN_RE.exec(m);
    if (!pin) return null;
    const strict = pin[1] !== undefined;
    const target = pin[2] ?? "";
    const lane = this.resolveLane(target);
    if (!lane) {
      // An unambiguous transfer verb naming nobody we know ("transfer me to my
      // manager") still reads as a transfer request — answer it with the
      // roster. A loose verb ("give me your opinion") is just a sentence.
      if (!strict) return null;
      const roster = Object.keys(this.lanes).join(", ");
      return `I don't have a line to ${normalizeRef(target) || "them"}. I can connect you to: ${roster}.`;
    }
    const reply = await this.pinLane(lane, turn);
    this.assertAcceptedTurn(turn);
    return reply;
  }

  // ---- generic intent fallback -------------------------------------------
  // Lexical patterns catch the common phrasings instantly, but nobody can
  // enumerate every way to ask for a transfer. Utterances that LOOK control-
  // ish (cheap keyword gate) yet miss the patterns are classified by a small
  // local model into a strict routing label. The label is consumed by code —
  // the classifier cannot answer the user, so it cannot role-play; a wrong or
  // slow answer degrades to "none" (a normal turn), never to made-up speech.

  private classifyIntent(m: string, signal: AbortSignal): Promise<string | null> {
    if (!this.classify || !CONTROLISH_RE.test(m)) return Promise.resolve(null);
    const roster = Object.entries(this.lanes)
      .map(([n, l]) => (l.aliases?.length ? `${n} (aka ${l.aliases.join(", ")})` : n))
      .join("; ");
    const prompt =
      `You route utterances for a voice assistant's switchboard. Employees: ${roster}.\n` +
      "Reply with EXACTLY one label and nothing else:\n" +
      "transfer:<employee> = the user asks to talk to that ONE specific employee\n" +
      "release = the user wants to end the transfer / go back to the assistant\n" +
      "rollcall = the user wants everyone to check in / join / a group call\n" +
      "standup = the user wants a status or update from everyone / each employee\n" +
      "callme = the user wants the assistant to call/ring their phone now (a dial-back)\n" +
      "callme:<employee> = they want that ONE employee to be the one who calls their phone\n" +
      "none = anything else: a question, an instruction, small talk, or unclear\n" +
      "rollcall and standup require the WHOLE GROUP to be referenced (everyone, the team, all agents). " +
      "Words like check, status, or report about anything else are none.\n" +
      "Questions ABOUT calls (\"did you call me?\", \"who called?\") are none, not callme.\n" +
      "When in doubt, reply none.\n" +
      `Utterance: "${m}"`;
    return raceWithSignal(
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return this.classify!(prompt, signal);
      }),
      signal,
    )
      .then((raw) => {
        const label = raw.trim().toLowerCase().split(/\s/)[0] ?? "";
        if (!/^(?:transfer:[a-z0-9 _-]+|callme(?::[a-z0-9 _-]+)?|release|rollcall|standup|none)$/.test(label)) return null;
        if (label === "none") return null;
        log("info", `switchboard: classifier routed "${m.slice(0, 60)}" → ${label}`);
        return label;
      })
      .catch((error: unknown) => {
        // Classifier failure degrades normally; turn cancellation does not.
        if (signal.aborted) signal.throwIfAborted();
        void error;
        return null;
      });
  }

  /** Resolve a classified intent to a spoken ack, or null for a normal turn. */
  private async actOnIntent(
    label: string | null,
    utterance: string,
    turn: AcceptedTurn,
  ): Promise<string | "standup" | null> {
    this.assertAcceptedTurn(turn);
    if (!label) return null;
    // The classifier sometimes labels a bare "what's the status?" as a team
    // standup (seen live 2026-07-11 — the front desk hijacked a question meant
    // for the pinned lane). Group actions demand a group word — or the action's
    // own name — in the actual utterance; a caller who literally said "roll
    // call" cannot be a hallucinated label (live miss 2026-07-12: "yes, initiate
    // roll call" was discarded here and the persona apologized instead).
    const group = /\b(?:every(?:one|body)|team|office|all|each|agents?|staff|group|hands)\b/i;
    const literal = label === "rollcall" ? /\broll\s?-?calls?\b/i : /\bstand\s?-?ups?\b/i;
    if ((label === "standup" || label === "rollcall") && !group.test(utterance) && !literal.test(utterance)) {
      log("info", `switchboard: classifier said ${label} but "${utterance.slice(0, 50)}" names no group — ignoring`);
      return null;
    }
    if (label === "standup") return "standup";
    if (label === "rollcall") return this.doRollcall(turn);
    if (label === "release") return this.doRelease(turn);
    if (label === "callme" || label.startsWith("callme:")) {
      // Same hallucinated-label defense as the group actions: dialing the
      // user's phone demands call vocabulary in the actual utterance.
      if (!this.callMe || !/\b(?:call|ring|phone|dial)\b/i.test(utterance)) {
        if (this.callMe) log("info", `switchboard: classifier said ${label} but "${utterance.slice(0, 50)}" mentions no call — ignoring`);
        return null;
      }
      const who = label.startsWith("callme:") ? label.slice("callme:".length).trim() : "";
      log("info", `switchboard: dial-back requested (classifier)${who ? ` — ${who}` : ""}`);
      const reply = await this.callMe(who || undefined);
      // Memo before the turn assert: a superseding turn still needs to know.
      this.leaveMemo(dialBackMemo(who || undefined));
      this.assertAcceptedTurn(turn);
      return reply;
    }
    if (label.startsWith("transfer:")) {
      const lane = this.resolveLane(label.slice("transfer:".length));
      if (lane) {
        const reply = await this.pinLane(lane, turn);
        this.assertAcceptedTurn(turn);
        return reply;
      }
    }
    return null;
  }

  private current(): Brain {
    return this.active ? this.lanes[this.active].brain : this.primary;
  }

  /**
   * Unattended background turn (scheduled prompts). Not a spoken turn: no
   * turn admission, no control plane, and the pinned lane never moves.
   * options.lane targets a named lane — cold-starting it exactly like a
   * transfer would, persona included — otherwise the front desk answers.
   */
  async sendBackground(message: string, options?: BackgroundTurnOptions): Promise<string> {
    if (this.stopping) throw new Error("switchboard is stopping");
    const lane = options?.lane;
    const turnOptions = options?.signal ? { signal: options.signal } : undefined;
    if (lane === undefined) {
      return this.primary.sendBackground
        ? this.primary.sendBackground(message, turnOptions)
        : this.primary.send(message, turnOptions);
    }
    const def = this.lanes[lane];
    if (!def) throw new Error(`unknown lane "${lane}" for a background turn`);
    while (!this.started.has(lane)) {
      if (this.stopping) throw new Error("switchboard is stopping");
      options?.signal?.throwIfAborted();
      const prior = this.laneStarts.get(lane);
      if (prior?.retired) {
        // A fresh session must not overlap the old session's unresolved start.
        const late = options?.signal ? raceWithSignal(prior.promise, options.signal) : prior.promise;
        await late.catch(() => {});
        options?.signal?.throwIfAborted();
        continue;
      }
      // Persona precedes the first start and belongs to the lane lifecycle.
      if (def.persona && !this.personaInstalled.has(lane)) {
        def.brain.injectContext(def.persona);
        this.personaInstalled.add(lane);
      }
      await (options?.signal ? raceWithSignal(this.startLane(lane), options.signal) : this.startLane(lane));
    }
    return def.brain.send(message, turnOptions);
  }

  /** Optional terminal controls belong to whichever line is currently active. */
  get sendToTab(): Brain["sendToTab"] {
    if (!bindBrainCapability(this.current(), "sendToTab")) return undefined;
    return (message, tabName, options) => this.runAcceptedTurn(
      options,
      async (turn, turnOptions) => {
        // A caller may cache this getter across a transfer. Resolve the active
        // line at invocation time instead of retaining the old line's method.
        const capability = bindBrainCapability(this.current(), "sendToTab");
        if (!capability) throw new Error("active switchboard lane does not support sendToTab");
        const reply = await raceWithSignal(
          capability(message, tabName, turnOptions),
          turn.signal,
        );
        this.assertAcceptedTurn(turn);
        return reply;
      });
  }
  get switchTab(): Brain["switchTab"] { return bindBrainCapability(this.current(), "switchTab"); }
  get getTargetTab(): Brain["getTargetTab"] { return bindBrainCapability(this.current(), "getTargetTab"); }

  /**
   * Keep the switchboard's own control plane in front of narrated turns. A
   * direct bound delegate would make "talk to the coder" reach the model
   * instead of pinning the requested line.
   */
  get streamProgress(): Brain["streamProgress"] {
    if (!bindBrainCapability(this.current(), "streamProgress")) return undefined;
    return (message: string, options?: BrainTurnOptions): AsyncIterable<string> => this.runAcceptedStream(
      options,
      (turn, turnOptions) => this.sendProgress(message, turnOptions, turn),
    );
  }

  /** Route one-shot context only to the employee who actually receives the turn. */
  private currentForTurn(): Brain {
    const brain = this.current();
    const context = this.turnContext.takePending();
    if (context) brain.injectContext(context);
    return brain;
  }

  private async *sendProgress(
    message: string,
    turnOptions: BrainTurnOptions,
    turn: AcceptedTurn,
  ): AsyncIterable<string> {
    this.control = false;
    const routed = await this.controlPlane(message, turn);
    this.assertAcceptedTurn(turn);
    if (routed === "standup") {
      this.control = true;
      yield* iterateWithSignal(this.runStandup(turnOptions, turn), turn.signal);
      return;
    }
    if (routed !== null) {
      this.control = true;
      this.assertAcceptedTurn(turn);
      yield routed;
      return;
    }

    this.assertAcceptedTurn(turn);
    const brain = this.currentForTurn();
    const progress = bindBrainCapability(brain, "streamProgress");
    let full = "";
    if (progress) {
      for await (const chunk of iterateWithSignal(progress(message, turnOptions), turn.signal)) {
        this.assertAcceptedTurn(turn);
        full += chunk;
        yield chunk;
      }
    } else if (brain.sendStream) {
      // The active line can change between feature detection and invocation
      // (for example, through a concurrent remote transfer). Preserve the
      // turn with standard streaming instead of calling the stale line.
      for await (const chunk of iterateWithSignal(brain.sendStream(message, turnOptions), turn.signal)) {
        this.assertAcceptedTurn(turn);
        full += chunk;
        yield chunk;
      }
    } else {
      full = await raceWithSignal(brain.send(message, turnOptions), turn.signal);
      this.assertAcceptedTurn(turn);
      yield full;
    }
    this.assertAcceptedTurn(turn);
    this.recordExchange(message, full);
  }

  /**
   * The standup: ask every STARTED lane for a one-liner (in parallel), speak
   * the answers in roster order, each in that employee's voice. Idle lanes
   * are reported without waking them — a status request shouldn't cost four
   * process launches.
   */
  private async *runStandup(
    options: BrainTurnOptions | undefined,
    turn: AcceptedTurn,
  ): AsyncIterable<string> {
    this.assertAcceptedTurn(turn);
    this.lastGroupAction = "standup";
    const turnOptions = this.optionsForTurn(turn, options);
    const names = Object.keys(this.lanes);
    const scope = new AbortController();
    const laneOptions: BrainTurnOptions = {
      ...turnOptions,
      signal: AbortSignal.any([turn.signal, scope.signal]),
    };
    const standupSignal = laneOptions.signal!;
    let completed = false;
    let drain: Promise<PromiseSettledResult<string>[]> | null = null;
    const voiceQueue = this.beginRollcall([null], { sealed: false, scope }, turn);
    log("info", `switchboard: standup — ${names.join(", ")}`);
    try {
      this.assertRollcallOwner(voiceQueue, standupSignal, turn);
      yield "Getting status from the team.";
      this.assertRollcallOwner(voiceQueue, standupSignal, turn);
      const answers = names.map((n) => this.laneStatus(n, laneOptions));
      // If caller cancellation rejects one answer while the generator unwinds,
      // keep every other parallel lane rejection observed as well.
      drain = Promise.allSettled(answers);
      for (let i = 0; i < names.length; i++) {
        this.assertRollcallOwner(voiceQueue, standupSignal, turn);
        const answer = await answers[i]!;
        this.assertRollcallOwner(voiceQueue, standupSignal, turn);
        let chunk = `${sentenceCase(workingName(names[i]!, this.lanes[names[i]!]))}: ${answer.trim()}`;
        if (!/[.!?]$/.test(chunk)) chunk += "."; // sentence boundary — keeps the voice queue aligned
        const count = await sentenceCount(chunk);
        this.assertRollcallOwner(voiceQueue, standupSignal, turn);
        voiceQueue.voices.push(...Array<string | null>(count).fill(names[i]!));
        this.assertRollcallOwner(voiceQueue, standupSignal, turn);
        yield " " + chunk;
      }
      this.assertRollcallOwner(voiceQueue, standupSignal, turn);
      this.finishRollcall(voiceQueue);
      completed = true;
    } finally {
      if (!completed) {
        if (!scope.signal.aborted) scope.abort(new Error("standup consumer stopped"));
        this.abandonRollcall(voiceQueue);
      }
      void drain;
    }
  }

  private async laneStatus(name: string, options?: BrainTurnOptions): Promise<string> {
    const callerSignal = options?.signal;
    callerSignal?.throwIfAborted();
    if (!this.started.has(name)) return "idle, no active session";

    const deadline = new AbortController();
    const turnSignal = callerSignal
      ? AbortSignal.any([callerSignal, deadline.signal])
      : deadline.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeCallerAbort = (): void => {};

    try {
      const reply = Promise.resolve().then(() => {
        turnSignal.throwIfAborted();
        return this.lanes[name]!.brain.send(
          "Standup check-in: in ONE short spoken sentence, what are you working on right now? Reply with only that sentence.",
          { ...options, signal: turnSignal },
        );
      });
      // Promise.race observes late rejection already; this explicit observer
      // documents and preserves that guarantee if the timeout/caller wins.
      void reply.catch(() => {});

      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new StandupLaneTimeoutError(this.standupLaneTimeoutMs);
          deadline.abort(error);
          reject(error);
        }, this.standupLaneTimeoutMs);
      });

      const waits: Array<Promise<string>> = [reply, timeout];
      if (callerSignal) {
        waits.push(new Promise<never>((_, reject) => {
          const onAbort = (): void => {
            try {
              callerSignal.throwIfAborted();
            } catch (err: unknown) {
              reject(err);
            }
          };
          callerSignal.addEventListener("abort", onAbort, { once: true });
          removeCallerAbort = () => callerSignal.removeEventListener("abort", onAbort);
          if (callerSignal.aborted) onAbort();
        }));
      }

      return (await Promise.race(waits)).trim() || "no answer";
    } catch (err: unknown) {
      // Caller cancellation is control flow for the whole standup, not a lane
      // failure to turn into speech. Preserve its original abort reason.
      if (callerSignal?.aborted) callerSignal.throwIfAborted();
      if (err instanceof StandupLaneTimeoutError) return "didn't answer";
      log("warn", `switchboard: standup lane ${name} failed: ${boundedError(err)}`);
      return "didn't answer";
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeCallerAbort();
    }
  }

  /**
   * Resolve a turn against the control plane: lexical patterns first (0ms),
   * then the intent classifier for control-ish phrasings the patterns miss.
   * Returns "standup" (streamed by the caller), a spoken ack, or null.
   */
  private async controlPlane(
    message: string,
    turn: AcceptedTurn,
  ): Promise<string | "standup" | null> {
    this.assertAcceptedTurn(turn);
    const m = normalizeUtterance(message);
    const pendingAck = this.relayPendingConfirmation(m);
    if (pendingAck !== null) return pendingAck;
    // "Again" right after a roll call / standup repeats it. Checked before the
    // bare-name transfer so "again" can't be mistaken for a lane name.
    if (this.lastGroupAction !== null && AGAIN_RE.test(m)) {
      if (this.lastGroupAction === "standup") return "standup";
      const redo = this.doRollcall(turn);
      if (redo !== null) return redo;
    }
    if (STANDUP_RE.test(m)) return "standup";
    // A bare name as the ENTIRE utterance is a transfer — the natural
    // correction after a misheard "can I talk to X?" is to repeat the name.
    const bareRaw = /^(?:please\s+)?(?:the\s+)?(\S{1,24}(?:\s\S{1,24})?)$/.exec(m)?.[1];
    if (bareRaw !== undefined) {
      const bare = normalizeRef(bareRaw); // the utterance keeps its case; refs don't
      // Exact names/aliases only — no fuzzy on bare words ("start" must not
      // route to stark), so resolveLane's fuzzy pass is bypassed here.
      for (const [name, def] of Object.entries(this.lanes)) {
        if (normalizeRef(name) === bare || def.aliases?.some((a) => normalizeRef(a) === bare)) {
          const reply = await this.pinLane(name, turn);
          this.assertAcceptedTurn(turn);
          return reply;
        }
      }
    }
    this.assertAcceptedTurn(turn);
    const vm = this.takeVoicemail(message, turn); // matched on the RAW text — the message body keeps its punctuation
    if (vm !== null) return vm;
    const ack = await this.handleControl(message, turn);
    this.assertAcceptedTurn(turn);
    if (ack !== null) return ack;
    const label = await this.classifyIntent(m, turn.signal);
    this.assertAcceptedTurn(turn);
    const routed = await this.actOnIntent(label, m, turn);
    this.assertAcceptedTurn(turn);
    // A normal brain turn ends the "again" context — a later bare "again"
    // refers to the conversation, not to a roll call from minutes ago.
    if (routed === null) this.lastGroupAction = null;
    return routed;
  }

  /** Surface every lane's gate so a capability routes back to its origin even
   * after the user transfers elsewhere. */
  hasPendingConfirmation(): boolean {
    return hasPendingConfirmations(this.confirmationBrains());
  }

  pendingConfirmations(): readonly PendingConfirmation[] {
    return collectPendingConfirmations(this.confirmationBrains());
  }

  resolvePendingConfirmation(approved: boolean, nonce: string): boolean {
    return resolveBoundConfirmation(this.confirmationBrains(), approved, nonce);
  }

  private relayPendingConfirmation(m: string): string | null {
    return relayBoundConfirmation(this, m);
  }

  private confirmationBrains(): readonly Brain[] {
    return [this.primary, ...Object.values(this.lanes).map((lane) => lane.brain)];
  }

  /** Remember the exchange so the next transfer can brief the new employee. */
  private recordExchange(user: string, reply: string): void {
    if (!reply.trim()) return;
    this.lastExchange = { speaker: this.active ?? "Cicero", user, reply };
    if (this.active !== null) {
      // Bounded before retained: the release recap needs a tail, not a log.
      this.laneLog.push({ user: clipText(user, 200), reply: clipText(reply, 240) });
      if (this.laneLog.length > SwitchboardBrain.LANE_LOG_TURNS) this.laneLog.shift();
    }
  }

  /** The front desk sometimes ANSWERS with a magic phrase ("status from
   * everyone") when the user says "yes, do that" — it means to invoke it,
   * not recite it. A reply that IS a trigger phrase executes it. */
  private replyTrigger(reply: string): "standup" | "rollcall" | null {
    if (this.active !== null) return null; // only the front desk drives the board
    const r = normalizeUtterance(reply);
    if (/^(?:status from every(?:one|body)|standup)$/.test(r)) return "standup";
    if (/^roll\s?-?call$/.test(r)) return "rollcall";
    return null;
  }

  send(message: string, options?: BrainTurnOptions): Promise<string> {
    return this.runAcceptedTurn(options, async (turn, turnOptions) => {
      this.control = false;
      const routed = await this.controlPlane(message, turn);
      this.assertAcceptedTurn(turn);
      if (routed === "standup") {
        this.control = true;
        let out = "";
        for await (const chunk of iterateWithSignal(this.runStandup(turnOptions, turn), turn.signal)) {
          this.assertAcceptedTurn(turn);
          out += chunk;
        }
        this.assertAcceptedTurn(turn);
        return out;
      }
      if (routed !== null) { this.control = true; return routed; }
      const reply = await raceWithSignal(
        this.currentForTurn().send(message, turnOptions),
        turn.signal,
      );
      this.assertAcceptedTurn(turn);
      const trig = this.replyTrigger(reply);
      if (trig === "standup") {
        this.control = true;
        let out = "";
        for await (const chunk of iterateWithSignal(this.runStandup(turnOptions, turn), turn.signal)) {
          this.assertAcceptedTurn(turn);
          out += chunk;
        }
        this.assertAcceptedTurn(turn);
        return out;
      }
      if (trig === "rollcall") { this.control = true; return this.doRollcall(turn) ?? reply; }
      this.assertAcceptedTurn(turn);
      this.recordExchange(message, reply);
      this.assertAcceptedTurn(turn);
      return reply;
    });
  }

  sendStream(message: string, options?: BrainTurnOptions): AsyncIterable<string> {
    return this.runAcceptedStream(
      options,
      (turn, turnOptions) => this.sendStreamTurn(message, turnOptions, turn),
    );
  }

  private async *sendStreamTurn(
    message: string,
    turnOptions: BrainTurnOptions,
    turn: AcceptedTurn,
  ): AsyncIterable<string> {
    this.control = false;
    const routed = await this.controlPlane(message, turn);
    this.assertAcceptedTurn(turn);
    if (routed === "standup") {
      this.control = true;
      yield* iterateWithSignal(this.runStandup(turnOptions, turn), turn.signal);
      return;
    }
    if (routed !== null) {
      this.control = true;
      this.assertAcceptedTurn(turn);
      yield routed;
      return;
    }
    this.assertAcceptedTurn(turn);
    const brain = this.currentForTurn();
    // Front-desk replies buffer up to a few words before speaking: a reply
    // that turns out to BE a trigger phrase must execute, not be recited.
    if (this.active === null && brain.sendStream) {
      let full = "";
      const buffered: string[] = [];
      let decided = false;
      for await (const chunk of iterateWithSignal(brain.sendStream(message, turnOptions), turn.signal)) {
        this.assertAcceptedTurn(turn);
        full += chunk;
        if (!decided) {
          buffered.push(chunk);
          if (full.length > 40) { decided = true; yield buffered.join(""); buffered.length = 0; }
          continue;
        }
        yield chunk;
      }
      this.assertAcceptedTurn(turn);
      if (!decided) {
        const trig = this.replyTrigger(full);
        if (trig === "standup") {
          this.control = true;
          yield* iterateWithSignal(this.runStandup(turnOptions, turn), turn.signal);
          return;
        }
        if (trig === "rollcall") {
          this.control = true;
          this.assertAcceptedTurn(turn);
          yield this.doRollcall(turn) ?? full;
          return;
        }
        this.assertAcceptedTurn(turn);
        yield buffered.join("");
      }
      this.assertAcceptedTurn(turn);
      this.recordExchange(message, full);
      return;
    }
    let full = "";
    if (brain.sendStream) {
      for await (const chunk of iterateWithSignal(brain.sendStream(message, turnOptions), turn.signal)) {
        this.assertAcceptedTurn(turn);
        full += chunk;
        yield chunk;
      }
    } else {
      full = await raceWithSignal(brain.send(message, turnOptions), turn.signal);
      this.assertAcceptedTurn(turn);
      yield full;
    }
    this.assertAcceptedTurn(turn);
    this.recordExchange(message, full);
  }

  /** Only the front desk starts eagerly; lanes connect on first pin. */
  async start(): Promise<void> {
    const lifecycle = ++this.lifecycleSequence;
    this.stopping = true;
    this.cancelCurrentTurn(new Error("switchboard starting"));
    try {
      await this.enqueueLifecycle(async () => {
        if (this.lifecycleSequence !== lifecycle) return;
        try {
          await this.primary.start();
        } catch (error: unknown) {
          // A rejected start can still leave a partially allocated session.
          await this.cleanupStalePrimary("failed start");
          throw error;
        }
        if (this.lifecycleSequence !== lifecycle) {
          // stop() deliberately does not wait for an uncooperative start. If
          // one appears after that boundary, reap it before a queued start can
          // enter the next board session.
          await this.cleanupStalePrimary("retired start");
          return;
        }
        this.stopping = false;
      });
    } catch (error: unknown) {
      // Failed startup remains closed until the caller explicitly retries.
      if (this.lifecycleSequence === lifecycle) this.stopping = true;
      throw error;
    }
  }

  async stop(): Promise<void> {
    ++this.lifecycleSequence;
    this.stopping = true;
    const reason = new Error("switchboard stopping");
    this.cancelCurrentTurn(reason);

    const pendingNames = [...this.laneStarts.keys()];
    for (const lifecycle of this.laneStarts.values()) lifecycle.retired = true;
    const lanesToStop = new Set([...this.started, ...pendingNames]);

    // Reset routing before awaiting cleanup so no caller can observe or reuse a
    // stopped lane if start() is called again on this Switchboard instance.
    this.active = null;
    this.started.clear();
    this.personaInstalled.clear();
    this.control = false;
    this.lastExchange = null;
    this.laneLog = [];
    this.turnContext.clear();

    // Shutdown preempts lifecycle serialization: primary.start/restart and
    // lane.start have no cancellation contract, so waiting behind one can
    // deadlock stop forever. Future starts still wait on BOTH the prior
    // lifecycle and this cleanup, preventing a late stop from killing a new
    // session. Retired operations reap themselves if they eventually settle.
    const cleanup = Promise.allSettled([
      this.stopPrimary(),
      ...[...lanesToStop].map((name) => this.stopLane(name)),
    ]).then(() => {});
    const priorLifecycle = this.lifecycleBarrier.catch(() => {});
    this.lifecycleBarrier = Promise.all([priorLifecycle, cleanup]).then(() => {});
    await cleanup;
  }

  injectContext(context: string): void {
    this.turnContext.inject(context);
  }

  async restart(): Promise<void> {
    const lifecycle = ++this.lifecycleSequence;
    this.stopping = true;
    const reason = new Error("switchboard restarting");
    this.cancelCurrentTurn(reason);
    this.turnContext.clear();
    this.control = false;
    this.lastExchange = null;
    this.laneLog = [];

    const started = [...this.started];
    const pending = [...this.laneStarts.entries()];
    for (const [name, laneStart] of pending) {
      laneStart.retired = true;
      this.personaInstalled.delete(name);
    }
    await this.enqueueLifecycle(async () => {
      if (this.lifecycleSequence !== lifecycle) return;
      const pendingCleanup = Promise.allSettled(
        pending.map(([name]) => this.stopLane(name)),
      );
      try {
        await this.primary.restart();
        if (this.lifecycleSequence !== lifecycle) {
          await this.cleanupStalePrimary("retired restart");
          return;
        }
        for (const name of started) {
          if (this.lifecycleSequence !== lifecycle) return;
          const def = this.lanes[name];
          try {
            await def.brain.restart();
            if (this.lifecycleSequence !== lifecycle) {
              // A concurrent stop may have completed before this restart
              // materialized a new lane session. Reap that late session too.
              await this.stopLane(name).catch((error: unknown) => {
                this.logLaneCleanupFailure(name, error);
              });
              return;
            }
            // Concrete brains clear their conversation/context on restart.
            // Restore the lane persona before reopening turn admission.
            if (def.persona) {
              def.brain.injectContext(def.persona);
              this.personaInstalled.add(name);
            }
          } catch (err: unknown) {
            this.started.delete(name);
            this.personaInstalled.delete(name);
            if (this.active === name) this.active = null;
            await this.stopLane(name).catch((error: unknown) => {
              this.logLaneCleanupFailure(name, error);
            });
            log("warn", `switchboard: lane ${name} restart failed — line dropped: ${boundedError(err)}`);
          }
        }
      } finally {
        await pendingCleanup;
      }
      if (this.lifecycleSequence === lifecycle) this.stopping = false;
    });
  }

  health(): Promise<boolean> {
    return this.primary.health();
  }
}
