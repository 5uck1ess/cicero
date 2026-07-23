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

  constructor(readonly name: string) {}
  async start(): Promise<void> { this.starts += 1; await this.startGate; }
  async warmup(): Promise<void> { this.warmups += 1; if (this.warmupError) throw this.warmupError; }
  async health(): Promise<boolean> { this.healthChecks += 1; return this.healthy; }
  async stop(): Promise<void> {
    this.stops += 1;
    if (this.stopFailures > 0) {
      this.stopFailures -= 1;
      throw new Error("stop failed");
    }
  }
  async transcribe(): Promise<string> { return this.name; }
  async generateAudio(): Promise<ArrayBuffer> { return new TextEncoder().encode(this.name).buffer; }
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
});
