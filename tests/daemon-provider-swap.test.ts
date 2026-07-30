import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { randomInt } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderSlot } from "../src/backends/hot-swap";
import {
  StagedManagedServerPortError,
  startManagedServer,
} from "../src/backends/managed-server";
import type { STTProvider } from "../src/backends/stt/provider";
import type { TTSProvider } from "../src/backends/tts/provider";
import { loadConfig, updateConfigFields, type RuntimeConfig } from "../src/config";
import { CiceroDaemon } from "../src/daemon";
import type { SwapRequest, SwapResult } from "../src/runtime-control";

class FakeVoiceProvider implements STTProvider, TTSProvider {
  starts = 0;
  warmups = 0;
  stops = 0;
  healthy = true;

  constructor(readonly name: string) {}
  async start(): Promise<void> { this.starts += 1; }
  async warmup(): Promise<void> { this.warmups += 1; }
  async health(): Promise<boolean> { return this.healthy; }
  async stop(): Promise<void> { this.stops += 1; }
  async transcribe(): Promise<string> { return this.name; }
  async generateAudio(): Promise<ArrayBuffer> { return new ArrayBuffer(0); }
}

class StagedOwnershipProvider extends FakeVoiceProvider {
  startOutcome: "adopted" | "adoption-refused" | "owned" | null = null;

  constructor(
    name: string,
    readonly port: number,
    private readonly compatibleListenerAlreadyThere: boolean,
  ) {
    super(name);
  }

  override async start(): Promise<void> {
    this.starts += 1;
    if (!this.compatibleListenerAlreadyThere) {
      this.startOutcome = "owned";
      return;
    }
    try {
      const managed = await startManagedServer({
        name: this.name,
        port: this.port,
        command: [process.execPath],
        healthUrl: `http://127.0.0.1:${this.port}/health`,
        fetcher: async () => new Response("compatible", { status: 200 }),
      });
      this.startOutcome = managed?.managed ? "owned" : "adopted";
    } catch (error: unknown) {
      if (error instanceof StagedManagedServerPortError) {
        expect(error.outcome).toBe("adoption-refused");
        this.startOutcome = "adoption-refused";
      }
      throw error;
    }
  }
}

interface SwapHarness {
  running: boolean;
  lifecycle: "idle" | "starting" | "running" | "stopping";
  sttSlot: ProviderSlot<STTProvider> | null;
  ttsSlot: ProviderSlot<TTSProvider> | null;
  swapVoiceProvider(request: SwapRequest): Promise<SwapResult>;
}

let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

for (const role of ["stt", "tts"] as const) {
  // The backend here is not incidental: it must be one that actually SELECTS a
// model, because a swap naming a model for a fixed-model backend (kokoro,
// pocket-tts, wyoming) is now refused rather than persisted and reported active.
// These tests assert the swap transaction's model propagation, so they need a
// backend where propagating a model means something.
describe(`${role.toUpperCase()} daemon swap transaction`, () => {
    test("persists only after candidate readiness and keeps the fallback configured", async () => {
      root = mkdtempSync(join(tmpdir(), `cicero-${role}-swap-`));
      const configPath = join(root, "config.yaml");
      const initial = role === "stt"
        ? {
            stt: { backend: "audiocpp", host: "old.example.test", port: 10300, model: "old-model" },
            stt_fallback: { backend: "audiocpp", host: "fallback.example.test", port: 10301 },
          }
        : {
            tts: { backend: "audiocpp", host: "old.example.test", port: 10200, model: "old-model" },
            tts_fallback: { backend: "audiocpp", host: "fallback.example.test", port: 10201 },
          };
      updateConfigFields(initial, configPath);
      const config = loadConfig({}, { home: root });
      const old = new FakeVoiceProvider(`${role}-old`);
      const candidate = new FakeVoiceProvider(`${role}-new`);
      let candidateConfig: RuntimeConfig | null = null;
      const daemon = new CiceroDaemon(config, {
        configPath,
        sttProviderFactory: (next) => { candidateConfig = next; return candidate; },
        ttsProviderFactory: (next) => { candidateConfig = next; return candidate; },
      });
      const state = daemon as unknown as SwapHarness;
      state.running = true;
      state.lifecycle = "running";
      state.sttSlot = new ProviderSlot<STTProvider>(old);
      state.ttsSlot = new ProviderSlot<TTSProvider>(old);

      const result = await state.swapVoiceProvider({ role, backend: "audiocpp", model: "new-model" });
      const persisted = loadConfig({}, { home: root });

      expect(result).toEqual({ role, backend: "audiocpp", model: "new-model", status: "active" });
      expect(candidate.starts).toBe(1);
      expect(candidate.warmups).toBe(1);
      expect(old.stops).toBe(1);
      expect((persisted.raw[role] as { model?: string }).model).toBe("new-model");
      const fallback = role === "stt" ? persisted.sttFallbackBackend : persisted.ttsFallbackBackend;
      expect(fallback).toMatchObject({ backend: "audiocpp", host: "fallback.example.test" });
      const candidateFallback = role === "stt"
        ? candidateConfig!.sttFallbackBackend
        : candidateConfig!.ttsFallbackBackend;
      expect(candidateFallback).toMatchObject({ backend: "audiocpp", host: "fallback.example.test" });
      await state.sttSlot.stop();
      await state.ttsSlot.stop();
    });

    test("reports the inherited active model and rotates the old primary into fallback", async () => {
      root = mkdtempSync(join(tmpdir(), `cicero-${role}-fallback-promotion-`));
      const configPath = join(root, "config.yaml");
      const initial = role === "stt"
        ? {
            stt: { backend: "faster-whisper", host: "old.example.test", model: "old-model" },
            stt_fallback: { backend: "audiocpp", host: "fallback.example.test", model: "parakeet" },
          }
        : {
            tts: { backend: "vibevoice", host: "old.example.test", model: "old-model" },
            tts_fallback: { backend: "audiocpp", host: "fallback.example.test", model: "parakeet" },
          };
      updateConfigFields(initial, configPath);
      const config = loadConfig({}, { home: root });
      const old = new FakeVoiceProvider(`${role}-old`);
      const candidate = new FakeVoiceProvider(`${role}-new`);
      let candidateConfig: RuntimeConfig | null = null;
      const daemon = new CiceroDaemon(config, {
        configPath,
        sttProviderFactory: (next) => { candidateConfig = next; return candidate; },
        ttsProviderFactory: (next) => { candidateConfig = next; return candidate; },
      });
      const state = daemon as unknown as SwapHarness;
      state.running = true;
      state.lifecycle = "running";
      state.sttSlot = new ProviderSlot<STTProvider>(old);
      state.ttsSlot = new ProviderSlot<TTSProvider>(old);

      const result = await state.swapVoiceProvider({ role, backend: "audiocpp" });
      const persisted = loadConfig({}, { home: root });
      const persistedFallback = role === "stt"
        ? persisted.sttFallbackBackend
        : persisted.ttsFallbackBackend;
      const candidateFallback = role === "stt"
        ? candidateConfig!.sttFallbackBackend
        : candidateConfig!.ttsFallbackBackend;

      expect(result).toEqual({ role, backend: "audiocpp", model: "parakeet", status: "active" });
      expect(persistedFallback).toMatchObject({
        backend: role === "stt" ? "faster-whisper" : "vibevoice",
        host: "old.example.test",
        model: "old-model",
      });
      expect(candidateFallback).toEqual(persistedFallback);
      await state.sttSlot.stop();
      await state.ttsSlot.stop();
    });

    test("health failure leaves persisted config and the active generation unchanged", async () => {
      root = mkdtempSync(join(tmpdir(), `cicero-${role}-rollback-`));
      const configPath = join(root, "config.yaml");
      const initial = role === "stt"
        ? { stt: { backend: "audiocpp", host: "old.example.test", model: "old-model" } }
        : { tts: { backend: "audiocpp", host: "old.example.test", model: "old-model" } };
      updateConfigFields(initial, configPath);
      const config = loadConfig({}, { home: root });
      const old = new FakeVoiceProvider(`${role}-old`);
      const candidate = new FakeVoiceProvider(`${role}-bad`);
      candidate.healthy = false;
      const daemon = new CiceroDaemon(config, {
        configPath,
        sttProviderFactory: () => candidate,
        ttsProviderFactory: () => candidate,
      });
      const state = daemon as unknown as SwapHarness;
      state.running = true;
      state.lifecycle = "running";
      state.sttSlot = new ProviderSlot<STTProvider>(old);
      state.ttsSlot = new ProviderSlot<TTSProvider>(old);

      await expect(state.swapVoiceProvider({ role, backend: "audiocpp", model: "bad-model" })).rejects.toThrow(
        "active provider and config retained",
      );
      const persisted = loadConfig({}, { home: root });
      const slot = role === "stt" ? state.sttSlot : state.ttsSlot;

      expect((persisted.raw[role] as { model?: string }).model).toBe("old-model");
      expect(slot.providerName).toBe(`${role}-old`);
      expect(old.stops).toBe(0);
      expect(candidate.stops).toBe(1);
      await state.sttSlot.stop();
      await state.ttsSlot.stop();
    });
  });
}

test("a compatible listener that steals a staged port is refused and the swap retries another port", async () => {
  root = mkdtempSync(join(tmpdir(), "cicero-staged-port-swap-"));
  const configPath = join(root, "config.yaml");
  const used = new Set<number>();
  const nextPort = (): number => {
    let port: number;
    do port = randomInt(20_000, 60_000);
    while (used.has(port));
    used.add(port);
    return port;
  };
  const activePort = nextPort();
  const stolenPort = nextPort();
  const replacementPort = nextPort();
  updateConfigFields({
    stt: { backend: "faster-whisper", port: activePort, model: "old-model" },
  }, configPath);
  const config = loadConfig({}, { home: root });
  const old = new FakeVoiceProvider("stt-old");
  const candidates: StagedOwnershipProvider[] = [];
  const ports = [stolenPort, replacementPort];
  const daemon = new CiceroDaemon(config, {
    configPath,
    voiceSwapPortAllocator: async () => ports.shift()!,
    sttProviderFactory: (candidateConfig) => {
      const port = candidateConfig.sttBackend.port!;
      const candidate = new StagedOwnershipProvider(
        `candidate-${candidates.length + 1}`,
        port,
        candidates.length === 0,
      );
      candidates.push(candidate);
      return candidate;
    },
  });
  const state = daemon as unknown as SwapHarness;
  state.running = true;
  state.lifecycle = "running";
  state.sttSlot = new ProviderSlot<STTProvider>(old);

  const result = await state.swapVoiceProvider({
    role: "stt",
    backend: "faster-whisper",
    model: "new-model",
  });
  const persisted = loadConfig({}, { home: root });

  expect(result).toEqual({
    role: "stt",
    backend: "faster-whisper",
    model: "new-model",
    status: "active",
  });
  expect(candidates.map((candidate) => candidate.startOutcome)).toEqual([
    "adoption-refused",
    "owned",
  ]);
  expect(candidates[0]!.stops).toBe(1);
  expect(persisted.sttBackend.port).toBe(replacementPort);
  expect(persisted.sttBackend.port).not.toBe(stolenPort);
  expect(state.sttSlot.providerName).toBe("candidate-2");
  await state.sttSlot.stop();
});
