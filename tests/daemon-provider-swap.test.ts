import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderSlot } from "../src/backends/hot-swap";
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
  describe(`${role.toUpperCase()} daemon swap transaction`, () => {
    test("persists only after candidate readiness and keeps the fallback configured", async () => {
      root = mkdtempSync(join(tmpdir(), `cicero-${role}-swap-`));
      const configPath = join(root, "config.yaml");
      const initial = role === "stt"
        ? {
            stt: { backend: "wyoming", host: "old.example.test", port: 10300, model: "old-model" },
            stt_fallback: { backend: "wyoming", host: "fallback.example.test", port: 10301 },
          }
        : {
            tts: { backend: "wyoming", host: "old.example.test", port: 10200, model: "old-model" },
            tts_fallback: { backend: "wyoming", host: "fallback.example.test", port: 10201 },
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

      const result = await state.swapVoiceProvider({ role, backend: "wyoming", model: "new-model" });
      const persisted = loadConfig({}, { home: root });

      expect(result).toEqual({ role, backend: "wyoming", model: "new-model", status: "active" });
      expect(candidate.starts).toBe(1);
      expect(candidate.warmups).toBe(1);
      expect(old.stops).toBe(1);
      expect((persisted.raw[role] as { model?: string }).model).toBe("new-model");
      const fallback = role === "stt" ? persisted.sttFallbackBackend : persisted.ttsFallbackBackend;
      expect(fallback).toMatchObject({ backend: "wyoming", host: "fallback.example.test" });
      const candidateFallback = role === "stt"
        ? candidateConfig!.sttFallbackBackend
        : candidateConfig!.ttsFallbackBackend;
      expect(candidateFallback).toMatchObject({ backend: "wyoming", host: "fallback.example.test" });
      await state.sttSlot.stop();
      await state.ttsSlot.stop();
    });

    test("health failure leaves persisted config and the active generation unchanged", async () => {
      root = mkdtempSync(join(tmpdir(), `cicero-${role}-rollback-`));
      const configPath = join(root, "config.yaml");
      const initial = role === "stt"
        ? { stt: { backend: "wyoming", host: "old.example.test", model: "old-model" } }
        : { tts: { backend: "wyoming", host: "old.example.test", model: "old-model" } };
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

      await expect(state.swapVoiceProvider({ role, backend: "wyoming", model: "bad-model" })).rejects.toThrow(
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
