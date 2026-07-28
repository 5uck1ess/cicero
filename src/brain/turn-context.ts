import { log } from "../logger";

export type BrainChatMessage = { role: "system" | "user" | "assistant"; content: string };

const MAX_PENDING_ENTRIES = 50;
const MAX_PENDING_CHARS = 24_000;
const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_CHARS = 32_000;
export const MAX_SYSTEM_CONTEXT_CHARS = 2_048;

/**
 * How far history may overrun its normal cap while a compaction is in flight.
 * Without a compactor this is never used and eviction behaves exactly as before.
 */
const COMPACTION_OVERRUN_FACTOR = 2;
/** Turns handed to the compactor when the cap is crossed — the older half. */
const COMPACT_BATCH_TURNS = Math.floor(MAX_HISTORY_TURNS / 2);
/** Bound on the returned summary; it is model output being retained. */
export const MAX_SUMMARY_CHARS = 4_000;
/** Absolute deadline for one compaction. */
const COMPACTION_TIMEOUT_MS = 30_000;

const SYSTEM_CONTEXT_LABEL =
  "Host operational context for this invocation only (not conversation memory):";
const SUMMARY_LABEL = "Summary of earlier conversation:";

function tail(value: string, max: number): string {
  return value.length <= max ? value : `[earlier content truncated]\n${value.slice(-max)}`;
}

interface HistoryTurn { user: string; assistant: string }

/**
 * Summarizes a span of conversation into one paragraph. Receives the turns
 * being retired plus the previous summary (if the history has been compacted
 * before), so successive compactions fold into a single running summary rather
 * than a growing stack of them.
 */
export type HistoryCompactor = (
  input: { turns: readonly HistoryTurn[]; previousSummary: string | null },
  signal: AbortSignal,
) => Promise<string>;

/**
 * Process-wide compactor, consulted by any context without an explicit one.
 *
 * Each brain adapter constructs its own BrainTurnContext privately, so there is
 * no single instance to configure. The compactor is a daemon-wide resource
 * anyway — one summarizer endpoint shared by every lane — so it is registered
 * once at startup rather than threaded through eight constructors and every
 * brain wrapper (which is the forwarding trap that silently drops optional
 * capabilities).
 */
let defaultCompactor: HistoryCompactor | null = null;

/** Register the daemon-wide compactor. Returns a disposer that restores the previous one. */
export function setDefaultHistoryCompactor(compactor: HistoryCompactor | null): () => void {
  const previous = defaultCompactor;
  defaultCompactor = compactor;
  return () => { defaultCompactor = previous; };
}

/**
 * Shared context contract for every brain adapter.
 *
 * Injected context is one-shot: it rides the next actual model/agent turn and
 * is consumed when that turn starts. Stateless adapters may also retain a
 * bounded transcript; stateful sessions disable transcript replay.
 *
 * The transcript is bounded. By default the oldest turns are simply dropped, so
 * a long conversation silently forgets its beginning. Given a compactor, the
 * older half is summarized in the BACKGROUND instead: the full turns keep
 * serving prompts until the summary lands, then they are replaced by it. If the
 * compactor is slow or fails, eviction still applies at a hard ceiling — the
 * transcript can never grow without bound.
 */
export class BrainTurnContext {
  private pending: string[] = [];
  private history: HistoryTurn[] = [];
  private summary: string | null = null;
  /**
   * Tri-state. `undefined` = never configured, so the process-wide default
   * applies; `null` = explicitly turned off for this context, which must NOT
   * silently fall back to the default.
   */
  private compactor: HistoryCompactor | null | undefined = undefined;
  /** In-flight compaction. Single-flight: a second trigger is a no-op. */
  private compacting: Promise<void> | null = null;
  /** Bumped by clear(); a compaction that started under an older one is stale. */
  private generation = 0;

  /**
   * Enable background compaction. Without this the context evicts exactly as it
   * always has, so this is purely additive.
   */
  setCompactor(compactor: HistoryCompactor | null): void {
    this.compactor = compactor;
  }

  /** The instance compactor if one was set (including an explicit off), else the daemon-wide default. */
  private get activeCompactor(): HistoryCompactor | null {
    return this.compactor === undefined ? defaultCompactor : this.compactor;
  }

  /** Awaits an in-flight compaction. For shutdown drains and tests. */
  settled(): Promise<void> {
    return this.compacting ?? Promise.resolve();
  }

  inject(context: string): void {
    const value = context.trim();
    if (!value) return;
    this.pending.push(tail(value, 8_000));
    if (this.pending.length > MAX_PENDING_ENTRIES) this.pending = this.pending.slice(-MAX_PENDING_ENTRIES);
    while (this.pending.join("\n").length > MAX_PENDING_CHARS && this.pending.length > 1) this.pending.shift();
  }

  clear(): void {
    this.pending = [];
    this.history = [];
    this.summary = null;
    // Invalidate any compaction already in flight. Without this it would land
    // afterwards and reattach a summary of the conversation we just cleared.
    this.generation += 1;
  }

  get pendingSize(): number {
    return this.pending.length;
  }

  takePending(): string | null {
    if (this.pending.length === 0) return null;
    const value = this.pending.join("\n\n");
    this.pending = [];
    return value;
  }

  remember(user: string, assistant: string): void {
    const reply = assistant.trim();
    if (!reply) return;
    this.history.push({ user: tail(user.trim(), 4_000), assistant: tail(reply, 8_000) });

    // With a compactor, crossing the cap starts a background summarisation and
    // the transcript is allowed to overrun until it lands. Without one, or once
    // the overrun ceiling is reached, the oldest turns are dropped as before.
    if (this.activeCompactor && this.overCap()) this.beginCompaction();
    const turnLimit = this.limit(MAX_HISTORY_TURNS);
    const charLimit = this.limit(MAX_HISTORY_CHARS);
    if (this.history.length > turnLimit) this.history = this.history.slice(-turnLimit);
    const chars = () => this.history.reduce((n, turn) => n + turn.user.length + turn.assistant.length, 0);
    while (chars() > charLimit && this.history.length > 1) this.history.shift();
  }

  /** The effective ceiling: relaxed only while a compaction is actually running. */
  private limit(base: number): number {
    return this.compacting ? base * COMPACTION_OVERRUN_FACTOR : base;
  }

  private overCap(): boolean {
    if (this.history.length > MAX_HISTORY_TURNS) return true;
    return this.history.reduce((n, turn) => n + turn.user.length + turn.assistant.length, 0) > MAX_HISTORY_CHARS;
  }

  private beginCompaction(): void {
    if (this.compacting) return; // single-flight
    const compactor = this.activeCompactor;
    if (!compactor) return;
    // Capture the exact turn OBJECTS being retired. Indices are not safe: new
    // turns arrive while this runs, and the hard ceiling may evict underneath.
    const batch = this.history.slice(0, Math.min(COMPACT_BATCH_TURNS, this.history.length - 1));
    if (batch.length === 0) return;
    const previousSummary = this.summary;
    const generation = this.generation;

    const run = async (): Promise<void> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), COMPACTION_TIMEOUT_MS);
      try {
        const result = await compactor({ turns: batch, previousSummary }, controller.signal);
        const summary = result.trim();
        if (!summary) throw new Error("compactor returned nothing");
        if (generation !== this.generation) return; // cleared while we were running
        this.applyCompaction(batch, summary);
      } catch (error: unknown) {
        // Falling back to eviction is the correct failure mode: the transcript
        // stays bounded, we just lose the older turns as we always did.
        log("info", `History compaction failed, falling back to eviction: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timer);
      }
    };

    // `tracked` must be the promise the field holds, not `run()`'s promise:
    // comparing against the un-chained one never matches, so the latch would
    // never clear and only the FIRST compaction would ever run.
    const tracked: Promise<void> = run().finally(() => {
      if (this.compacting === tracked) this.compacting = null;
    });
    this.compacting = tracked;
    // Observed by settled(); never left as an unhandled rejection.
    void tracked.catch(() => { /* run() already handled it */ });
  }

  /**
   * Swap the summarized turns out, if they are still present. A turn already
   * evicted by the hard ceiling is simply not found — the summary still covers
   * it, so nothing is lost by that.
   */
  private applyCompaction(batch: readonly HistoryTurn[], summary: string): void {
    const retired = new Set<HistoryTurn>(batch);
    this.history = this.history.filter((turn) => !retired.has(turn));
    this.summary = tail(summary, MAX_SUMMARY_CHARS);
  }

  buildTextPrompt(message: string, includeHistory: boolean, systemContext?: string): string {
    const sections: string[] = [];
    if (includeHistory && this.summary) sections.push(`${SUMMARY_LABEL}\n${this.summary}`);
    if (includeHistory && this.history.length > 0) {
      sections.push(
        "Conversation so far:\n" + this.history
          .map((turn) => `User: ${turn.user}\nAssistant: ${turn.assistant}`)
          .join("\n\n"),
      );
    }
    const pending = this.takePending();
    if (pending) sections.push(`Context for this turn:\n${pending}`);
    const operational = boundedSystemContext(systemContext);
    if (operational) sections.push(`${SYSTEM_CONTEXT_LABEL}\n${operational}`);
    if (sections.length === 0) return message;
    sections.push(`Current user request:\n${message}`);
    return sections.join("\n\n");
  }

  buildChatMessages(message: string, systemPrompt?: string, systemContext?: string): BrainChatMessage[] {
    const messages: BrainChatMessage[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    if (this.summary) messages.push({ role: "system", content: `${SUMMARY_LABEL}\n${this.summary}` });
    const operational = boundedSystemContext(systemContext);
    if (operational) messages.push({ role: "system", content: `${SYSTEM_CONTEXT_LABEL}\n${operational}` });
    const pending = this.takePending();
    if (pending) messages.push({ role: "system", content: `Context for this turn:\n${pending}` });
    for (const turn of this.history) {
      messages.push({ role: "user", content: turn.user });
      messages.push({ role: "assistant", content: turn.assistant });
    }
    messages.push({ role: "user", content: message });
    return messages;
  }
}

function boundedSystemContext(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= MAX_SYSTEM_CONTEXT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_SYSTEM_CONTEXT_CHARS - 22)}\n[context truncated]`;
}
