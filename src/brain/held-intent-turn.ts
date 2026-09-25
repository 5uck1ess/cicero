import type { Brain, BrainTurnOptions } from "../types";
import { SpeculativePermissionHold } from "./speculative-permissions";

export type HeldTurnMode = "send" | "stream" | "progress";
const MAX_HELD_CHARS = 64 * 1024;

/** One prefetched chunk, with backpressure. Nothing can reach TTS before release. */
export class HeldIntentTurn {
  readonly permissions: SpeculativePermissionHold;
  readonly output: Brain;
  private controller = new AbortController();
  private iterator: AsyncIterator<string>;
  private first: Promise<IteratorResult<string>>;
  private pending: Promise<IteratorResult<string>>;
  private firstAt: number | undefined;
  private released = false;
  private completed = false;
  private cleanup: Promise<void> | undefined;
  private events: Array<() => void> = [];
  private eventChars = 0;
  private detach: () => void;

  constructor(
    readonly brain: Brain, message: string, mode: HeldTurnMode, options: BrainTurnOptions,
    private onCancel: (drain: Promise<void>) => void,
  ) {
    this.permissions = new SpeculativePermissionHold(options.speculativePermissionHold);
    const forward = <T>(callback: ((value: T) => void) | undefined, value: T): void => {
      if (!callback || this.completed || this.controller.signal.aborted) return;
      if (this.released) { callback(value); return; }
      const size = JSON.stringify(value).length;
      if (this.events.length < 32 && this.eventChars + size <= 16_384) {
        this.eventChars += size;
        this.events.push(() => callback(value));
      }
    };
    const heldOptions: BrainTurnOptions = {
      ...options, signal: this.controller.signal, speculative: true,
      speculativePermissionHold: this.permissions,
      onNotice: (notice) => forward(options.onNotice, notice),
      onStructuredUpdate: (update) => forward(options.onStructuredUpdate, update),
    };
    const source = async function* (): AsyncGenerator<string> {
      if (mode === "progress" && brain.streamProgress) yield* brain.streamProgress(message, heldOptions);
      else if (mode !== "send" && brain.sendStream) yield* brain.sendStream(message, heldOptions);
      else yield await brain.send(message, heldOptions);
    };
    this.iterator = source()[Symbol.asyncIterator]();
    this.first = this.iterator.next().then((result) => {
      if (!result.done) {
        this.firstAt = performance.now();
        if (result.value.length > MAX_HELD_CHARS) throw new Error("held intent output exceeds limit");
      }
      return result;
    });
    this.pending = this.first;
    void this.first.catch(() => {});
    const cancel = () => { void this.cancel(); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    this.detach = () => options.signal?.removeEventListener("abort", cancel);
    if (options.signal?.aborted) cancel();
    this.output = new Proxy(brain, {
      get: (target, key) => {
        if (key === "send") return async () => { let text = ""; for await (const chunk of this.stream()) text += chunk; return text; };
        if (key === "sendStream" || key === "streamProgress") return () => this.stream();
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Elapsed wait of the first ready output; zero when the brain is still working. */
  heldMs(): number { return this.firstAt === undefined ? 0 : Math.max(0, performance.now() - this.firstAt); }

  release(): void {
    this.controller.signal.throwIfAborted();
    this.released = true;
    this.permissions.adopt();
    const events = this.events;
    this.events = [];
    for (const deliver of events) deliver();
  }

  cancel(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.permissions.cancel();
    this.controller.abort(new Error("held intent turn discarded"));
    this.detach();
    this.events = [];
    this.cleanup = this.pending.catch(() => {}).then(async () => {
      try { await this.iterator.return?.(); }
      catch {
        // A rejected return closes our owned async generator. Confirm closure
        // with a second return rather than retaining a permanent failure latch.
        await this.iterator.return?.();
      }
    });
    // The switchboard quarantines this brain until the actual provider pull settles.
    this.onCancel(this.cleanup);
    void this.cleanup.catch(() => {});
    return this.cleanup;
  }

  private async *stream(): AsyncGenerator<string> {
    try {
      let next = await this.first;
      while (!next.done) {
        this.controller.signal.throwIfAborted();
        yield next.value;
        this.pending = this.iterator.next();
        next = await this.pending;
      }
      this.completed = true;
    } finally {
      if (!this.completed) void this.cancel();
      else this.detach();
    }
  }
}
