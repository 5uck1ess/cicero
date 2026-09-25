/** One owner for accepted interactive turns, with foreground admission per session. */
import { redactSecrets } from "./redact";
export type TurnSource = "web" | "telegram" | "local-mic" | "text";
export type TurnLane = "foreground" | "background";

export interface TurnRequest {
  sessionId: string;
  turnId: string;
  source: TurnSource;
  audio?: ArrayBuffer;
  text?: string;
  signal?: AbortSignal;
  lane?: TurnLane;
}

export type TurnEvent =
  | { type: "transcript" | "sentence" | "notice"; text: string }
  | { type: "audio"; audio: ArrayBuffer; text?: string }
  | { type: "control"; message: unknown }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "aborted" };

export type TurnEventSink = (event: TurnEvent) => void | Promise<void>;

const MAX_INPUT_TEXT_CHARS = 16_384;
const MAX_INPUT_AUDIO_BYTES = 4 * 1024 * 1024;
// A chat turn may emit a 16 KiB transcript and a full 64 KiB reply. Count all
// emitted text once, without a smaller per-event limit on a valid reply.
const MAX_OUTPUT_TEXT_CHARS = 128 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 16_384;
const MAX_EVENT_AUDIO_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_ID_CHARS = 256;
const MAX_RECENT_TURN_IDS = 512;

export class TurnLease {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private terminal: "done" | "error" | "aborted" | null = null;
  private outputTextChars = 0;
  private outputAudioBytes = 0;
  private readonly onInputAbort = () => this.abort(this.request.signal?.reason);

  constructor(
    readonly request: TurnRequest,
    private readonly sink: TurnEventSink,
    private readonly release: () => void,
  ) {
    if (request.signal?.aborted) this.abort(request.signal.reason);
    else request.signal?.addEventListener("abort", this.onInputAbort, { once: true });
  }

  get active(): boolean { return this.terminal === null && !this.signal.aborted; }
  get outcome(): "done" | "error" | "aborted" | null { return this.terminal; }

  emit(event: Exclude<TurnEvent, { type: "done" | "error" | "aborted" }>): void | Promise<void> {
    if (!this.active) return;
    if (event.type === "audio") {
      this.outputAudioBytes += event.audio.byteLength;
      if (event.audio.byteLength > MAX_EVENT_AUDIO_BYTES || this.outputAudioBytes > MAX_OUTPUT_AUDIO_BYTES) {
        this.fail("turn audio output limit exceeded");
        return;
      }
    }
    if ("text" in event && typeof event.text === "string") {
      if (event.text.length > MAX_OUTPUT_TEXT_CHARS - this.outputTextChars) {
        this.fail("turn text output limit exceeded");
        return;
      }
      this.outputTextChars += event.text.length;
    }
    try {
      const delivered = this.sink(event);
      if (delivered instanceof Promise) {
        return delivered.catch((error: unknown) => {
          this.fail("turn event delivery failed");
          throw error;
        });
      }
      return delivered;
    } catch (error) {
      this.fail("turn event delivery failed");
      throw error;
    }
  }

  complete(): void { this.finish("done", { type: "done" }); }
  fail(message: string): void {
    if (!this.active) return;
    const safeMessage = message.length > MAX_ERROR_MESSAGE_CHARS ? "turn failed" : redactSecrets(message);
    this.finish("error", { type: "error", message: safeMessage });
    // Send the terminal error while the transport sink is still live, then
    // cancel any provider continuation that might still be running.
    this.controller.abort(new Error("turn failed"));
  }
  abort(reason?: unknown): void {
    if (this.terminal) return;
    if (!this.signal.aborted) this.controller.abort(reason);
    this.finish("aborted", { type: "aborted" });
  }
  /** Settle a legacy pipeline that returned without calling done or error. */
  settle(): void {
    if (this.terminal) return;
    if (this.signal.aborted) this.abort(this.signal.reason);
    else this.complete();
  }

  private finish(outcome: "done" | "error" | "aborted", event: TurnEvent): void {
    if (this.terminal) return;
    this.terminal = outcome;
    this.request.signal?.removeEventListener("abort", this.onInputAbort);
    this.release();
    // A transport sink is external to ownership. Its failure must not reopen
    // the lease or publish a second terminal event.
    try { void Promise.resolve(this.sink(event)).catch(() => {}); }
    catch { /* owner already settled */ }
  }
}

export class TurnCoordinator {
  private readonly foreground = new Map<string, TurnLease>();
  private readonly foregroundGenerations = new Map<string, AbortController>();
  private readonly owners = new Map<string, TurnLease>();
  private readonly recentIds: string[] = [];
  private readonly seenIds = new Set<string>();

  /** Pre-admission capture work can observe this without claiming a turn. */
  supersessionSignal(sessionId: string): AbortSignal {
    let generation = this.foregroundGenerations.get(sessionId);
    if (!generation) {
      generation = new AbortController();
      this.foregroundGenerations.set(sessionId, generation);
    }
    return generation.signal;
  }

  start(request: TurnRequest, sink: TurnEventSink = () => {}): TurnLease {
    if (!request.sessionId || !request.turnId ||
      request.sessionId.length > MAX_ID_CHARS || request.turnId.length > MAX_ID_CHARS ||
      (request.text === undefined) === (request.audio === undefined) ||
      (request.text?.length ?? 0) > MAX_INPUT_TEXT_CHARS ||
      (request.audio?.byteLength ?? 0) > MAX_INPUT_AUDIO_BYTES) {
      throw new Error("invalid or oversized turn input");
    }
    // A request already cancelled at admission cannot displace live work.
    if (request.signal?.aborted) return new TurnLease(request, sink, () => {});
    const key = `${request.sessionId.length}:${request.sessionId}${request.turnId}`;
    if (this.seenIds.has(key)) throw new Error("turn already owned");
    if (request.lane !== "background") {
      const reason = new Error("superseded by a newer foreground turn");
      const generation = this.foregroundGenerations.get(request.sessionId);
      if (generation) {
        generation.abort(reason);
        this.foregroundGenerations.set(request.sessionId, new AbortController());
      }
      this.foreground.get(request.sessionId)?.abort(reason);
    }
    this.seenIds.add(key);
    this.recentIds.push(key);
    if (this.recentIds.length > MAX_RECENT_TURN_IDS) {
      this.seenIds.delete(this.recentIds.shift()!);
    }
    let lease!: TurnLease;
    lease = new TurnLease(request, sink, () => {
      if (this.owners.get(key) === lease) this.owners.delete(key);
      if (this.foreground.get(request.sessionId) === lease) this.foreground.delete(request.sessionId);
    });
    if (lease.active) {
      this.owners.set(key, lease);
      if (request.lane !== "background") this.foreground.set(request.sessionId, lease);
    }
    return lease;
  }

  abortForeground(sessionId: string, reason?: unknown): void { this.foreground.get(sessionId)?.abort(reason); }
  abortAll(reason?: unknown): void {
    for (const lease of [...this.owners.values()]) lease.abort(reason);
  }
}
