import { describe, expect, test } from "bun:test";
import {
  ProviderSlot,
  SwappableSTTProvider,
  SwappableTTSProvider,
  pinGeneration,
} from "../../src/backends/hot-swap";
import type { STTProvider } from "../../src/backends/stt/provider";
import type { TTSProvider } from "../../src/backends/tts/provider";

class FakeVoiceProvider implements STTProvider, TTSProvider {
  starts = 0;
  warmups = 0;
  healthChecks = 0;
  stops = 0;
  stopFailures = 0;
  healthy = true;
  warmupError: Error | null = null;
  startGate: Promise<void> | null = null;
  /**
   * Whether this provider currently owns a process. Every managed backend
   * publishes that handle only once start() has returned (kokoro, mlx-audio,
   * pocket-tts, vibevoice all set it after their startup health passes), and
   * its stop() is a no-op while the handle is null — so counting stop() calls
   * alone hides a stop that reaped nothing.
   */
  managed = false;
  reaped = 0;

  constructor(readonly name: string) {}
  async start(): Promise<void> { this.starts += 1; await this.startGate; this.managed = true; }
  async warmup(): Promise<void> { this.warmups += 1; if (this.warmupError) throw this.warmupError; }
  async health(): Promise<boolean> { this.healthChecks += 1; return this.healthy; }
  async stop(): Promise<void> {
    this.stops += 1;
    if (this.stopFailures > 0) {
      this.stopFailures -= 1;
      throw new Error("stop failed");
    }
    if (this.managed) {
      this.managed = false;
      this.reaped += 1;
    }
  }
  async transcribe(): Promise<string> { return this.name; }
  async generateAudio(): Promise<ArrayBuffer> { return new TextEncoder().encode(this.name).buffer; }
}

/**
 * Capture an outcome the moment the promise is created. A swap these tests
 * deliberately leave in flight rejects while the test is awaiting a shutdown,
 * which without a handler already attached surfaces as an unhandled rejection.
 */
function settle(work: Promise<unknown>): Promise<Error | null> {
  return work.then(() => null, (error: unknown) => error as Error);
}

type Role = "stt" | "tts";
function slot(role: Role, provider: FakeVoiceProvider): ProviderSlot<STTProvider> | ProviderSlot<TTSProvider> {
  return role === "stt"
    ? new ProviderSlot<STTProvider>(provider)
    : new ProviderSlot<TTSProvider>(provider);
}

for (const role of ["stt", "tts"] as const) {
  describe(`${role.toUpperCase()} provider hot swap`, () => {
    test("starts, warms, health-gates, persists, cuts over, and stops the old generation", async () => {
      const old = new FakeVoiceProvider(`${role}-old`);
      const candidate = new FakeVoiceProvider(`${role}-new`);
      const owner = slot(role, old) as ProviderSlot<any>;
      const events: string[] = [];

      await owner.swap(candidate, () => { events.push("persist"); });

      expect(candidate.starts).toBe(1);
      expect(candidate.warmups).toBe(1);
      expect(candidate.healthChecks).toBe(1);
      expect(events).toEqual(["persist"]);
      expect(owner.providerName).toBe(`${role}-new`);
      expect(old.stops).toBe(1);
      expect(candidate.stops).toBe(0);
      await owner.stop();
      expect(candidate.stops).toBe(1);
    });

    test("warmup failure cleans the candidate and retains live state without persisting", async () => {
      const old = new FakeVoiceProvider(`${role}-old`);
      const candidate = new FakeVoiceProvider(`${role}-bad-warmup`);
      candidate.warmupError = new Error("model would not load");
      const owner = slot(role, old) as ProviderSlot<any>;
      let persisted = false;

      await expect(owner.swap(candidate, () => { persisted = true; })).rejects.toThrow("model would not load");

      expect(persisted).toBe(false);
      expect(owner.providerName).toBe(`${role}-old`);
      expect(old.stops).toBe(0);
      expect(candidate.stops).toBe(1);
      await owner.stop();
    });

    test("health failure cleans the candidate and retains live state", async () => {
      const old = new FakeVoiceProvider(`${role}-old`);
      const candidate = new FakeVoiceProvider(`${role}-unhealthy`);
      candidate.healthy = false;
      const owner = slot(role, old) as ProviderSlot<any>;

      await expect(owner.swap(candidate, () => {})).rejects.toThrow("failed its health check");
      expect(owner.providerName).toBe(`${role}-old`);
      expect(old.stops).toBe(0);
      expect(candidate.stops).toBe(1);
      await owner.stop();
    });

    test("persistence failure rolls back before cutover and cleans the candidate", async () => {
      const old = new FakeVoiceProvider(`${role}-old`);
      const candidate = new FakeVoiceProvider(`${role}-new`);
      const owner = slot(role, old) as ProviderSlot<any>;

      await expect(owner.swap(candidate, () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
      expect(owner.providerName).toBe(`${role}-old`);
      expect(old.stops).toBe(0);
      expect(candidate.stops).toBe(1);
      await owner.stop();
    });

    test("an in-flight lease stays on its generation until release", async () => {
      const old = new FakeVoiceProvider(`${role}-old`);
      const candidate = new FakeVoiceProvider(`${role}-new`);
      const owner = slot(role, old) as ProviderSlot<any>;
      const lease = owner.acquire();
      let swapped = false;
      const swapping = owner.swap(candidate, () => {}).then(() => { swapped = true; });

      await Bun.sleep(0);
      expect(owner.providerName).toBe(`${role}-new`);
      expect(lease.provider).toBe(old);
      expect(old.stops).toBe(0);
      expect(swapped).toBe(false);

      lease.release();
      await swapping;
      expect(old.stops).toBe(1);
      expect(swapped).toBe(true);
      await owner.stop();
    });

    test("bounds cutover cleanup while retaining ownership until an in-flight lease releases", async () => {
      const old = new FakeVoiceProvider(`${role}-old`);
      const candidate = new FakeVoiceProvider(`${role}-new`);
      const owner = role === "stt"
        ? new ProviderSlot<STTProvider>(old, { cleanupTimeoutMs: 5 })
        : new ProviderSlot<TTSProvider>(old, { cleanupTimeoutMs: 5 });
      const lease = owner.acquire();

      await expect((owner as ProviderSlot<any>).swap(candidate, () => {})).rejects.toThrow(
        "cutover committed, but old provider cleanup was not confirmed",
      );
      expect((owner as ProviderSlot<any>).providerName).toBe(`${role}-new`);
      expect(old.stops).toBe(0);

      lease.release();
      await Bun.sleep(0);
      expect(old.stops).toBe(1);
      await owner.stop();
    });

    test("rejects a concurrent swap with an actionable error", async () => {
      const old = new FakeVoiceProvider(`${role}-old`);
      const first = new FakeVoiceProvider(`${role}-first`);
      let releaseStart!: () => void;
      first.startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
      const second = new FakeVoiceProvider(`${role}-second`);
      const owner = slot(role, old) as ProviderSlot<any>;
      const swapping = owner.swap(first, () => {});
      await Bun.sleep(0);

      await expect(owner.swap(second, () => {})).rejects.toThrow("another provider swap is already in progress");
      expect(second.starts).toBe(0);
      expect(second.stops).toBe(1);

      releaseStart();
      await swapping;
      await owner.stop();
    });

    test("retries failed retired-generation cleanup before accepting another swap", async () => {
      const old = new FakeVoiceProvider(`${role}-old`);
      old.stopFailures = 1;
      const first = new FakeVoiceProvider(`${role}-first`);
      const second = new FakeVoiceProvider(`${role}-second`);
      const owner = slot(role, old) as ProviderSlot<any>;

      await expect(owner.swap(first, () => {})).rejects.toThrow("old provider cleanup was not confirmed");
      expect(owner.providerName).toBe(`${role}-first`);
      expect(old.stops).toBe(1);

      await owner.swap(second, () => {});

      expect(old.stops).toBe(2);
      expect(first.stops).toBe(1);
      expect(owner.providerName).toBe(`${role}-second`);
      await owner.stop();
    });
  });
}

describe("abandoned swap requests", () => {
  test("a cancelled request does not commit: no persist, no cutover, candidate cleaned up", async () => {
    // The CLI used to abort at 120s while a supported managed cold start is allowed
    // 300s, and the server ignored the abort — so it went on to write config and cut
    // over while the operator was told the swap had failed. persist() is the commit
    // point, so a request nobody is listening to must be refused before it.
    const live = new FakeVoiceProvider("tts-live");
    const candidate = new FakeVoiceProvider("tts-candidate");
    const owner = new ProviderSlot<TTSProvider>(live);
    const controller = new AbortController();
    let persisted = 0;

    // Abort while the candidate is still starting, i.e. before the commit gate.
    candidate.startGate = Promise.resolve().then(() => { controller.abort(); });

    await expect(
      owner.swap(candidate, () => { persisted += 1; }, { signal: controller.signal }),
    ).rejects.toThrow(/cancelled before it was committed/);

    expect(persisted).toBe(0);                       // config untouched
    expect(owner.providerName).toBe("tts-live");     // no cutover
    expect(candidate.stops).toBe(1);                 // candidate released, not leaked
    expect(live.stops).toBe(0);                      // live generation never retired
  });

  test("an abort that lands after the commit does not undo it", async () => {
    // Symmetry matters: once persist() has run the swap IS committed, and reporting
    // or unwinding it as a failure would be the same lie in the other direction.
    const live = new FakeVoiceProvider("tts-live");
    const candidate = new FakeVoiceProvider("tts-candidate");
    const owner = new ProviderSlot<TTSProvider>(live);
    const controller = new AbortController();

    await owner.swap(candidate, () => { controller.abort(); }, { signal: controller.signal });

    expect(owner.providerName).toBe("tts-candidate");
    expect(live.stops).toBe(1);
  });
});

describe("turn-length generation pins", () => {
  test("a pinned turn stays on its generation across a swap while new turns get the replacement", async () => {
    const old = new FakeVoiceProvider("tts-old");
    const next = new FakeVoiceProvider("tts-new");
    const owner = new ProviderSlot<TTSProvider>(old);
    const facade = new SwappableTTSProvider(owner);

    // Turn A pins the live generation for its whole duration.
    const pinA = facade.pinGeneration();
    expect(pinA.provider).toBe(old);

    // A swap cuts over mid-turn; Turn A must NOT move, and the swap waits for it.
    let swapped = false;
    const swapping = owner.swap(next, () => {}).then(() => { swapped = true; });
    await Bun.sleep(0);
    expect(facade.slot.providerName).toBe("tts-new"); // new turns see the replacement
    expect(pinA.provider).toBe(old);                  // Turn A still on its generation
    expect(swapped).toBe(false);
    expect(old.stops).toBe(0);

    // A turn that starts after cutover pins the replacement.
    const pinB = facade.pinGeneration();
    expect(pinB.provider).toBe(next);
    pinB.release();

    // Turn A finishes → its generation drains and stops; the swap resolves.
    pinA.release();
    await swapping;
    expect(swapped).toBe(true);
    expect(old.stops).toBe(1);
    await owner.stop();
  });

  test("pinGeneration on a plain (non-swappable) provider is a no-op pin over itself", () => {
    const plain = new FakeVoiceProvider("plain") as unknown as TTSProvider;
    const pin = pinGeneration(plain);
    expect(pin.provider).toBe(plain);
    expect(() => pin.release()).not.toThrow();
  });

  test("pinning a slot that is already shutting down hands back the current provider without throwing", async () => {
    const old = new FakeVoiceProvider("stt-old");
    const owner = new ProviderSlot<STTProvider>(old);
    const facade = new SwappableSTTProvider(owner);
    await owner.stop();

    const pin = facade.pinGeneration(); // acquire would throw; pin falls back gracefully
    expect(pin.provider).toBe(old);
    expect(() => pin.release()).not.toThrow();
  });

  test("a shutdown during candidate preparation refuses the cutover and releases the candidate", async () => {
    const old = new FakeVoiceProvider("tts-old");
    const owner = new ProviderSlot<TTSProvider>(old);
    const next = new FakeVoiceProvider("tts-next");

    // Hold the candidate inside start() so stop() lands mid-preparation — the
    // window in which stop() snapshots the generations it will ever reap.
    let releaseStart!: () => void;
    next.startGate = new Promise<void>((resolve) => { releaseStart = resolve; });

    let persisted = false;
    const swapping = settle(owner.swap(next, () => { persisted = true; }));
    await Bun.sleep(5);
    const stopping = owner.stop();
    releaseStart();
    await stopping;

    expect((await swapping)?.message).toMatch(/shutting down/);
    // Refused before persistence, and the candidate it started was stopped
    // rather than installed behind stop()'s back.
    expect(persisted).toBe(false);
    expect(next.stops).toBe(1);
    expect(owner.currentProvider()).toBe(old);
  });

  test("a preparing candidate whose stop fails during shutdown is retained, not lost", async () => {
    const old = new FakeVoiceProvider("tts-old");
    const owner = new ProviderSlot<TTSProvider>(old);
    const next = new FakeVoiceProvider("tts-next");
    next.stopFailures = 1; // refuses its first stop, like a process that will not exit

    let releaseStart!: () => void;
    next.startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const swapping = settle(owner.swap(next, () => {}));

    // The candidate is started but is not a generation yet, so stop() can only
    // reach it by claiming it. It refuses, so release is unconfirmed and stop()
    // must say so — reporting success here left the daemon dropping its last
    // handle to a provider that is still running.
    await Bun.sleep(5);
    const stopping = owner.stop();
    releaseStart();
    await expect(stopping).rejects.toThrow(/failed to stop/);
    expect((await swapping)?.message).toMatch(/shutting down/);
    expect(next.stops).toBe(1);

    // Retryable, not latched: the daemon's next teardown attempt reaches it.
    await owner.stop();
    expect(next.stops).toBe(2);
    expect(next.reaped).toBe(1);
  });

  // Round 4 (Codex): stop() claimed a candidate that was still inside start()
  // and reaped it on the spot. Managed backends publish the process they own
  // only once startup succeeds, so that stop was a no-op — and the child it
  // spawned a moment later outlived the daemon with no handle left on it.
  test("a shutdown reaps a candidate that publishes its process only when start() completes", async () => {
    const old = new FakeVoiceProvider("tts-old");
    const owner = new ProviderSlot<TTSProvider>(old);
    const next = new FakeVoiceProvider("tts-next");

    let releaseStart!: () => void;
    next.startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const swapping = settle(owner.swap(next, () => {}));
    await Bun.sleep(5);

    const stopping = owner.stop();
    // The startup that spawns the child finishes only now, after stop() has
    // already claimed the candidate.
    releaseStart();
    await stopping;
    expect((await swapping)?.message).toMatch(/shutting down/);

    expect(next.reaped).toBe(1);
    expect(next.managed).toBe(false);
  });

  test("a candidate startup that never settles is reported unconfirmed, not assumed clean", async () => {
    const old = new FakeVoiceProvider("tts-old");
    // Waiting for the start is bounded like every other release in this class.
    const owner = new ProviderSlot<TTSProvider>(old, { cleanupTimeoutMs: 25 });
    const next = new FakeVoiceProvider("tts-next");

    let releaseStart!: () => void;
    next.startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const swapping = settle(owner.swap(next, () => {}));
    await Bun.sleep(5);

    const failure = await settle(owner.stop()) as AggregateError | null;
    expect(failure?.errors.map(String).join("\n")).toMatch(/candidate startup did not finish within 25ms/);

    // Latched as retryable, not dropped: once the start settles, the next
    // teardown attempt reaps the process it published.
    releaseStart();
    expect((await swapping)?.message).toMatch(/shutting down/);
    await owner.stop();
    expect(next.reaped).toBe(1);
  });

  // Round 5 (Codex): the retry took the quarantined path, which stopped the
  // provider immediately. A candidate quarantined BECAUSE its startup had not
  // settled is exactly the one that cannot be stopped yet, so the retry reaped
  // nothing — and then deleted the entry, dropping the last handle on a child
  // that was about to exist. Managed startups legitimately run for minutes.
  test("a retry keeps waiting for a startup that has still not settled", async () => {
    const old = new FakeVoiceProvider("tts-old");
    const owner = new ProviderSlot<TTSProvider>(old, { cleanupTimeoutMs: 25 });
    const next = new FakeVoiceProvider("tts-next");

    let releaseStart!: () => void;
    next.startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const swapping = settle(owner.swap(next, () => {}));
    await Bun.sleep(5);

    // First attempt: the startup outruns the deadline and is reported.
    const first = await settle(owner.stop()) as AggregateError | null;
    expect(first?.errors.map(String).join("\n")).toMatch(/candidate startup did not finish/);

    // Second attempt, with the start STILL pending. Stopping now would reap
    // nothing, so this must report unconfirmed too rather than quietly forget it.
    const second = await settle(owner.stop()) as AggregateError | null;
    expect(second?.errors.map(String).join("\n")).toMatch(/candidate startup did not finish/);
    expect(next.reaped).toBe(0);

    // And once the startup finally lands, the next attempt does reap the child.
    releaseStart();
    expect((await swapping)?.message).toMatch(/shutting down/);
    await owner.stop();
    expect(next.reaped).toBe(1);
    expect(next.managed).toBe(false);
  });
});

// Round 3 (Codex): the cutover publishes the replacement synchronously, but
// swap() keeps running while it drains the retired generation — for up to the
// cleanup deadline. Callers that must invalidate state derived from the old
// provider (the web filler bank primes its clips through it) were doing so only
// after swap() resolved, so every turn admitted in that window ran on the new
// provider with the old provider's cached audio.
describe("cutover notification", () => {
  test("fires before any caller can acquire the replacement", async () => {
    const old = new FakeVoiceProvider("tts-old");
    const owner = new ProviderSlot<TTSProvider>(old);
    const next = new FakeVoiceProvider("tts-next");
    // Hold the retired generation's cleanup open, which is the window the
    // finding is about.
    const lease = owner.acquire();

    let providerAtCutover: string | undefined;
    const swapping = owner.swap(next, () => {}, {
      onCutover: () => { providerAtCutover = owner.currentProvider().name; },
    });
    await Bun.sleep(5);

    // The replacement is already live, and the hook saw exactly that instant.
    expect(providerAtCutover).toBe("tts-next");
    expect(owner.currentProvider()).toBe(next);
    lease.release();
    await swapping;
  });

  test("fires even when the retired generation misses its cleanup deadline", async () => {
    const old = new FakeVoiceProvider("tts-old");
    const owner = new ProviderSlot<TTSProvider>(old, { cleanupTimeoutMs: 20 });
    const next = new FakeVoiceProvider("tts-next");
    const lease = owner.acquire(); // never released: the drain cannot complete

    let cutOver = false;
    // swap() rejects on the drain, but the cutover DID commit — a caller that
    // keyed its invalidation off swap() resolving kept stale state forever.
    await expect(owner.swap(next, () => {}, { onCutover: () => { cutOver = true; } }))
      .rejects.toThrow(/cleanup was not confirmed/);
    expect(cutOver).toBe(true);
    expect(owner.currentProvider()).toBe(next);
    lease.release();
  });

  test("a throwing hook does not corrupt the slot", async () => {
    const old = new FakeVoiceProvider("tts-old");
    const owner = new ProviderSlot<TTSProvider>(old);
    const next = new FakeVoiceProvider("tts-next");

    await owner.swap(next, () => {}, { onCutover: () => { throw new Error("hook exploded"); } });

    expect(owner.currentProvider()).toBe(next);
    expect(old.stops).toBe(1);
  });

  test("it does not fire when the swap is refused before the cutover", async () => {
    const old = new FakeVoiceProvider("tts-old");
    const owner = new ProviderSlot<TTSProvider>(old);
    const next = new FakeVoiceProvider("tts-bad");
    next.healthy = false;

    let cutOver = false;
    await expect(owner.swap(next, () => {}, { onCutover: () => { cutOver = true; } })).rejects.toThrow();
    expect(cutOver).toBe(false);
    expect(owner.currentProvider()).toBe(old);
  });
});
