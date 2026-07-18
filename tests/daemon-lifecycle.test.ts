import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { CiceroDaemon, createRecordedWebTurn, recordParkedBriefingVoiceOutcome } from "../src/daemon";
import { OvernightStore } from "../src/notify/overnight-store";
import type { WebReplySink } from "../src/web-voice/turn";
import type { HistoryTurn } from "../src/web-voice/history";
import { readPairingState } from "../src/web-voice/pairing-state";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

describe("CiceroDaemon lifecycle", () => {
  test("aborting during a parked briefing callback write leaves the overnight snapshot unacked", async () => {
    const root = mkdtempSync(join(tmpdir(), "cicero-daemon-briefing-callback-abort-"));
    const store = new OvernightStore(join(root, "overnight.json"), () => 1_700_000_000_000, () => "item-1");
    await store.enqueue("queued overnight");
    const snapshot = await store.peek();
    const controller = new AbortController();
    const channels = { voice: "accepted" };
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });

    try {
      const recording = recordParkedBriefingVoiceOutcome(controller.signal, channels, async () => {
        markWriteStarted();
        await writeGate;
      });
      await writeStarted;
      controller.abort(new Error("briefing scheduler stopped"));
      releaseWrite();
      await recording;

      const accepted = Object.values(channels).filter((outcome) => outcome === "accepted").length;
      if (accepted > 0) await store.ack(snapshot.map((item) => item.id));

      expect(channels).toEqual({ voice: "aborted", callback: "aborted" });
      expect((await store.peek()).map((item) => item.text)).toEqual(["queued overnight"]);
    } finally {
      releaseWrite();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a completed WebSocket turn does not drain before history persistence", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    const rows: HistoryTurn[] = [];
    const sink: WebReplySink = {
      transcript: () => {},
      sentence: () => {},
      audio: () => {},
      control: () => {},
      done: () => {},
      error: () => {},
      aborted: () => false,
    };
    const recorded = createRecordedWebTurn(sink, {
      append: async (row) => {
        try {
          rows.push(row);
          writeStarted();
          await gate;
        } catch (error) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      },
    });
    recorded.sink.transcript("hello");
    recorded.sink.sentence("Hi there.");
    recorded.sink.done();
    await started;

    let settled = false;
    const draining = recorded.drain().then(() => { settled = true; });
    await Bun.sleep(0);
    expect(settled).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user: "hello", reply: "Hi there." });

    release();
    await draining;
    expect(settled).toBe(true);
  });

  test("a startup failure rolls back the PID marker and stop remains idempotent", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-daemon-test-"));
    const pidFile = join(home, "cicero.pid");
    const daemon = new CiceroDaemon(loadConfig({}, { home }), {
      pidFile,
      providerFactory: () => { throw new Error("provider construction failed"); },
    });

    try {
      await expect(daemon.start()).rejects.toThrow(/provider construction failed/);
      expect(existsSync(pidFile)).toBe(false);
      await daemon.stop();
      await daemon.stop();
      await expect(daemon.start()).rejects.toThrow(/provider construction failed/);
      expect(existsSync(pidFile)).toBe(false);
    } catch (error) {
      throw new Error(`lifecycle rollback test failed: ${(error as Error).message}`, { cause: error });
    }
  });

  test("an unavailable configured brain fails readiness and rolls back startup", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-daemon-brain-readiness-test-"));
    const pidFile = join(home, "cicero.pid");
    const config = loadConfig({}, { home });
    config.raw.headless = true;
    config.raw.dashboard = { enabled: false };
    config.raw.tts_enabled = false;
    config.raw.web_voice = {
      enabled: true,
      port: 0,
      token: "test-token-that-is-long-enough",
      tls: { enabled: false },
    };
    config.raw.brain = {
      ...config.raw.brain,
      backend: "qwen",
      mode: "subprocess",
      binary: "/definitely/missing/cicero-brain",
      thinking_filler: false,
    };
    const daemon = new CiceroDaemon(config, {
      skipServers: true,
      pidFile,
      brainReadiness: { maxAttempts: 3, retryDelayMs: 0, timeoutMs: 100 },
      providerFactory: () => ({
        stt: {
          name: "test-stt",
          transcribe: () => Promise.resolve(null),
          health: () => Promise.resolve(true),
        },
        tts: {
          name: "test-tts",
          generateAudio: () => Promise.resolve(new ArrayBuffer(0)),
          health: () => Promise.resolve(true),
        },
        llm: {
          name: "test-llm",
          chatCompletion: () => Promise.resolve("ok"),
          health: () => Promise.resolve(true),
        },
      }),
    });

    try {
      await expect(daemon.start()).rejects.toThrow(/configured brain 'qwen' failed its startup readiness check/);
      expect(existsSync(pidFile)).toBe(false);
      await daemon.stop();
    } catch (error: unknown) {
      await daemon.stop().catch(() => {});
      throw new Error(`brain readiness rollback test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });

  test("a successful stop clears every daemon-owned timer", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-daemon-timer-test-"));
    const daemon = new CiceroDaemon(loadConfig({}, { home }));
    let schedulerStarted = false;
    let schedulerStopStarted = false;
    let releaseScheduler!: () => void;
    const schedulerDrain = new Promise<void>((resolve) => { releaseScheduler = resolve; });
    const state = daemon as unknown as {
      lifecycle: "idle" | "starting" | "running" | "stopping";
      running: boolean;
      briefingScheduler: { start: () => void; stop: () => Promise<void> } | null;
      minutesTimer?: ReturnType<typeof setTimeout>;
    };
    state.lifecycle = "running";
    state.running = true;
    state.briefingScheduler = {
        start: () => { schedulerStarted = true; },
        stop: async () => { schedulerStopStarted = true; await schedulerDrain; },
    };
    state.briefingScheduler.start();
    let delayedWorkRan = false;

    try {
      expect(schedulerStarted).toBe(true);
      state.minutesTimer = setTimeout(() => { delayedWorkRan = true; }, 20);

      let stopped = false;
      const stopping = daemon.stop().then(() => { stopped = true; });
      await Bun.sleep(0);
      expect(schedulerStopStarted).toBe(true);
      expect(stopped).toBe(false);
      releaseScheduler();
      await stopping;
      await daemon.stop();
      await Bun.sleep(40);

      expect(delayedWorkRan).toBe(false);
      expect(state.briefingScheduler).toBeNull();
      expect(state.minutesTimer).toBeUndefined();
    } catch (error) {
      await daemon.stop().catch(() => {});
      throw new Error(`successful lifecycle timer test failed: ${(error as Error).message}`, { cause: error });
    }
  });

  test("stop during provider startup waits, rolls back, and never becomes running", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-daemon-start-race-test-"));
    const pidFile = join(home, "cicero.pid");
    const config = loadConfig({}, { home });
    config.raw.headless = true;
    config.raw.web_voice = { ...config.raw.web_voice, enabled: true };
    config.raw.dashboard = { enabled: false };
    config.raw.tts_enabled = false;
    config.raw.brain = {
      ...config.raw.brain,
      backend: "qwen",
      mode: "subprocess",
      binary: process.execPath,
      binary_args: ["-e", "console.log('ok')"],
      thinking_filler: false,
    };
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let signalProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => { signalProviderStarted = resolve; });
    const stopped: string[] = [];
    const daemon = new CiceroDaemon(config, {
      pidFile,
      providerFactory: () => ({
        stt: {
          name: "test-stt",
          transcribe: () => Promise.resolve(null),
          health: () => Promise.resolve(true),
          start: () => Promise.resolve(),
          stop: () => { stopped.push("stt"); return Promise.resolve(); },
        },
        tts: {
          name: "test-tts",
          generateAudio: () => Promise.resolve(new ArrayBuffer(0)),
          health: () => Promise.resolve(true),
          start: () => Promise.resolve(),
          stop: () => { stopped.push("tts"); return Promise.resolve(); },
        },
        llm: {
          name: "test-llm",
          chatCompletion: () => Promise.resolve("ok"),
          health: () => Promise.resolve(true),
          start: async () => {
            try {
              signalProviderStarted();
              await providerGate;
            } catch (error) {
              throw new Error(`delayed provider start failed: ${(error as Error).message}`, { cause: error });
            }
          },
          stop: () => { stopped.push("llm"); return Promise.resolve(); },
        },
      }),
    });

    try {
      const startResult = daemon.start().then(
        () => null,
        (error: unknown) => error,
      );
      await providerStarted;
      const stopping = daemon.stop();
      let stopSettled = false;
      const observedStop = stopping.then(
        () => { stopSettled = true; },
        () => { stopSettled = true; },
      );
      await Bun.sleep(10);
      expect(stopSettled).toBe(false);

      releaseProvider();
      const startError = await startResult;
      await observedStop;

      expect(startError).toBeInstanceOf(Error);
      expect((startError as Error).message).toContain("startup cancelled by shutdown");
      expect(new Set(stopped)).toEqual(new Set(["stt", "tts", "llm"]));
      expect(existsSync(pidFile)).toBe(false);
    } catch (error) {
      releaseProvider();
      await daemon.stop().catch(() => {});
      throw new Error(`stop-during-start test failed: ${(error as Error).message}`, { cause: error });
    }
  });

  test("stop cancels in-flight automatic TLS generation instead of waiting for its deadline", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-daemon-tls-race-test-"));
    const pidFile = join(home, "cicero.pid");
    const config = loadConfig({}, { home });
    config.raw.headless = true;
    config.raw.dashboard = { enabled: false };
    config.raw.tts_enabled = false;
    config.raw.web_voice = {
      enabled: true,
      port: 0,
      token: "test-token-that-is-long-enough",
    };
    config.raw.brain = {
      ...config.raw.brain,
      backend: "qwen",
      mode: "subprocess",
      binary: process.execPath,
      binary_args: ["-e", "console.log('ok')"],
      thinking_filler: false,
    };
    let signalTlsStarted!: () => void;
    const tlsStarted = new Promise<void>((resolve) => { signalTlsStarted = resolve; });
    const daemon = new CiceroDaemon(config, {
      skipServers: true,
      pidFile,
      providerFactory: () => ({
        stt: {
          name: "test-stt",
          transcribe: () => Promise.resolve(null),
          health: () => Promise.resolve(true),
        },
        tts: {
          name: "test-tts",
          generateAudio: () => Promise.resolve(new ArrayBuffer(0)),
          health: () => Promise.resolve(true),
        },
        llm: {
          name: "test-llm",
          chatCompletion: () => Promise.resolve("ok"),
          health: () => Promise.resolve(true),
        },
      }),
      tlsEnsurer: ({ signal }) => {
        signalTlsStarted();
        return new Promise((resolve, reject) => {
          if (!signal) {
            reject(new Error("daemon did not pass its lifecycle signal to TLS setup"));
            return;
          }
          if (signal.aborted) {
            reject(new Error("TLS setup aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("TLS setup aborted")), { once: true });
        });
      },
    });

    try {
      const startOutcome = daemon.start().then(
        () => null,
        (error: unknown) => error,
      );
      await withTimeout(tlsStarted, 1_000, "TLS setup start");
      const stoppingAt = performance.now();
      await withTimeout(daemon.stop(), 1_000, "TLS-cancelled daemon stop");
      const startError = await startOutcome;

      expect(performance.now() - stoppingAt).toBeLessThan(1_000);
      expect(startError).toBeInstanceOf(Error);
      expect((startError as Error).message).toContain("startup cancelled by shutdown");
      expect(existsSync(pidFile)).toBe(false);
    } catch (error) {
      await daemon.stop().catch(() => {});
      throw new Error(`TLS shutdown-cancellation test failed: ${(error as Error).message}`, { cause: error });
    }
  });

  test("unabortable warmups and tone startup cannot hold the shutdown drain", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-daemon-ser-race-test-"));
    const pidFile = join(home, "cicero.pid");
    const config = loadConfig({}, { home });
    config.raw.headless = true;
    config.raw.dashboard = { enabled: false };
    config.raw.tts_enabled = false;
    config.raw.web_voice = {
      enabled: true,
      port: 0,
      token: "test-token-that-is-long-enough",
      tls: { enabled: false },
    };
    config.raw.tone = { enabled: true };
    config.raw.brain = {
      ...config.raw.brain,
      backend: "qwen",
      mode: "subprocess",
      binary: process.execPath,
      binary_args: ["-e", "console.log('ok')"],
      thinking_filler: false,
    };
    let releaseSer!: () => void;
    const serGate = new Promise<void>((resolve) => { releaseSer = resolve; });
    let signalSerStarted!: () => void;
    const serStarted = new Promise<void>((resolve) => { signalSerStarted = resolve; });
    let releaseTts!: () => void;
    const ttsGate = new Promise<void>((resolve) => { releaseTts = resolve; });
    let signalTtsStarted!: () => void;
    const ttsStarted = new Promise<void>((resolve) => { signalTtsStarted = resolve; });
    let releaseStt!: () => void;
    const sttGate = new Promise<void>((resolve) => { releaseStt = resolve; });
    let signalSttStarted!: () => void;
    const sttStarted = new Promise<void>((resolve) => { signalSttStarted = resolve; });
    let serStops = 0;
    let signalSerStopped!: () => void;
    const serStopped = new Promise<void>((resolve) => { signalSerStopped = resolve; });
    const daemon = new CiceroDaemon(config, {
      pidFile,
      providerFactory: () => ({
        stt: {
          name: "test-stt",
          transcribe: () => Promise.resolve(null),
          health: () => Promise.resolve(true),
          warmup: () => { signalSttStarted(); return sttGate; },
        },
        tts: {
          name: "test-tts",
          generateAudio: () => Promise.resolve(new ArrayBuffer(0)),
          health: () => Promise.resolve(true),
          warmup: () => { signalTtsStarted(); return ttsGate; },
        },
        llm: {
          name: "test-llm",
          chatCompletion: () => Promise.resolve("ok"),
          health: () => Promise.resolve(true),
        },
      }),
      serProviderFactory: () => ({
        name: "test-ser",
        classify: () => Promise.resolve(null),
        health: () => Promise.resolve(true),
        start: () => { signalSerStarted(); return serGate; },
        stop: () => {
          serStops += 1;
          signalSerStopped();
          return Promise.resolve();
        },
      }),
    });

    try {
      await daemon.start();
      await Promise.all([serStarted, ttsStarted, sttStarted]);

      await withTimeout(daemon.stop(), 250, "daemon stop");

      expect(serStops).toBe(0);
      expect(existsSync(pidFile)).toBe(false);

      releaseTts();
      releaseStt();
      releaseSer();
      await withTimeout(serStopped, 250, "late tone cleanup");

      expect(serStops).toBe(1);
    } catch (error) {
      releaseTts();
      releaseStt();
      releaseSer();
      await daemon.stop().catch(() => {});
      throw new Error(`unabortable background lifecycle test failed: ${(error as Error).message}`, { cause: error });
    }
  });

  test("shutdown drains dashboard and web ingress before stopping brain and speaker", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-daemon-ingress-order-test-"));
    const daemon = new CiceroDaemon(loadConfig({}, { home }));
    let releaseDashboard!: () => void;
    const dashboardGate = new Promise<void>((resolve) => { releaseDashboard = resolve; });
    let releaseWeb!: () => void;
    const webGate = new Promise<void>((resolve) => { releaseWeb = resolve; });
    const events: string[] = [];
    const state = daemon as unknown as {
      lifecycle: "idle" | "starting" | "running" | "stopping";
      running: boolean;
      dashboard: { stop: () => Promise<void> } | null;
      webVoice: { stop: () => Promise<void> } | null;
      brain: { stop: () => Promise<void> } | null;
      streamingSpeaker: { stop: () => Promise<void> } | null;
      speaker: { stop: () => Promise<void> } | null;
    };
    state.lifecycle = "running";
    state.running = true;
    state.dashboard = {
      stop: () => {
        events.push("dashboard-quiesced");
        return dashboardGate.then(() => { events.push("dashboard-drained"); });
      },
    };
    state.webVoice = {
      stop: () => {
        events.push("web-quiesced");
        return webGate.then(() => { events.push("web-drained"); });
      },
    };
    state.brain = { stop: () => { events.push("brain-stopped"); return Promise.resolve(); } };
    state.streamingSpeaker = { stop: () => { events.push("streaming-speaker-stopped"); return Promise.resolve(); } };
    state.speaker = { stop: () => { events.push("speaker-stopped"); return Promise.resolve(); } };

    const stopping = daemon.stop();
    // Quiescence is synchronous: no request can enter in the first microtask
    // after stop() while the daemon waits for an outstanding startup/voice task.
    expect(events).toEqual(["dashboard-quiesced", "web-quiesced"]);

    releaseDashboard();
    await Bun.sleep(10);
    expect(events).toEqual(["dashboard-quiesced", "web-quiesced", "dashboard-drained"]);

    releaseWeb();
    await stopping;
    expect(events).toEqual([
      "dashboard-quiesced",
      "web-quiesced",
      "dashboard-drained",
      "web-drained",
      "streaming-speaker-stopped",
      "speaker-stopped",
      "brain-stopped",
    ]);
  });

  test("shutdown reaps every owned local command before provider teardown completes", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-daemon-local-turn-drain-test-"));
    const daemon = new CiceroDaemon(loadConfig({}, { home }));
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let receivedSignal: AbortSignal | undefined;
    let brainStops = 0;
    const state = daemon as unknown as {
      lifecycle: "idle" | "starting" | "running" | "stopping";
      running: boolean;
      handleCommand: (text: string, signal: AbortSignal) => Promise<void>;
      dispatchCommand: (text: string) => Promise<void>;
      brain: { stop: () => Promise<void> } | null;
      streamingSpeaker: { stop: () => Promise<void> } | null;
      speaker: { stop: () => Promise<void> } | null;
    };
    state.lifecycle = "running";
    state.running = true;
    state.handleCommand = async (_text, signal) => {
      receivedSignal = signal;
      markStarted();
      await turnGate;
    };
    state.streamingSpeaker = { stop: () => Promise.resolve() };
    state.speaker = { stop: () => Promise.resolve() };
    state.brain = { stop: () => { brainStops += 1; return Promise.resolve(); } };

    const dispatched = state.dispatchCommand("keep ownership");
    await started;
    let stopSettled = false;
    const stopping = daemon.stop().then(() => { stopSettled = true; });
    await Bun.sleep(10);

    expect(receivedSignal?.aborted).toBe(true);
    expect(brainStops).toBe(1);
    expect(stopSettled).toBe(false);

    releaseTurn();
    await Promise.all([dispatched, stopping]);
    expect(stopSettled).toBe(true);
    expect(state.lifecycle).toBe("idle");
  });

  test("a local-command drain timeout blocks provider teardown and can be retried", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-daemon-local-turn-retry-test-"));
    const daemon = new CiceroDaemon(loadConfig({}, { home }), { shutdownDrainTimeoutMs: 20 });
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const state = daemon as unknown as {
      lifecycle: "idle" | "starting" | "running" | "stopping";
      running: boolean;
      handleCommand: (text: string, signal: AbortSignal) => Promise<void>;
      dispatchCommand: (text: string) => Promise<void>;
      brain: { stop: () => Promise<void> } | null;
      streamingSpeaker: { stop: () => Promise<void> } | null;
      speaker: { stop: () => Promise<void> } | null;
    };
    state.lifecycle = "running";
    state.running = true;
    state.handleCommand = async () => {
      markStarted();
      await turnGate;
    };
    state.streamingSpeaker = { stop: () => Promise.resolve() };
    state.speaker = { stop: () => Promise.resolve() };
    state.brain = { stop: () => Promise.resolve() };

    const dispatched = state.dispatchCommand("ignore cancellation briefly");
    await started;
    await expect(daemon.stop()).rejects.toThrow("local command turns did not drain within 20ms");
    expect(state.lifecycle).toBe("stopping");

    releaseTurn();
    await dispatched;
    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(state.lifecycle).toBe("idle");
  });

  test("an unconfirmed streaming-speaker release keeps daemon shutdown retryable", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-daemon-speaker-retry-test-"));
    const daemon = new CiceroDaemon(loadConfig({}, { home }));
    let streamingStops = 0;
    const state = daemon as unknown as {
      lifecycle: "idle" | "starting" | "running" | "stopping";
      running: boolean;
      brain: { stop: () => Promise<void> } | null;
      streamingSpeaker: { stop: () => Promise<void> } | null;
      speaker: { stop: () => Promise<void> } | null;
    };
    state.lifecycle = "running";
    state.running = true;
    state.streamingSpeaker = {
      stop: () => {
        streamingStops += 1;
        return streamingStops === 1
          ? Promise.reject(new Error("raw audio player reap unconfirmed"))
          : Promise.resolve();
      },
    };
    state.speaker = { stop: () => Promise.resolve() };
    state.brain = { stop: () => Promise.resolve() };

    await expect(daemon.stop()).rejects.toThrow("raw audio player reap unconfirmed");
    expect(state.lifecycle).toBe("stopping");
    expect(streamingStops).toBe(1);

    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(streamingStops).toBe(2);
    expect(state.lifecycle).toBe("idle");
  });

  test("an ingress drain failure blocks dependency teardown and a later stop retries", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-daemon-ingress-retry-test-"));
    const daemon = new CiceroDaemon(loadConfig({}, { home }));
    let webStops = 0;
    let dashboardStops = 0;
    let brainStops = 0;
    let speakerStops = 0;
    const state = daemon as unknown as {
      lifecycle: "idle" | "starting" | "running" | "stopping";
      running: boolean;
      dashboard: { stop: () => Promise<void> } | null;
      webVoice: { stop: () => Promise<void> } | null;
      brain: { stop: () => Promise<void> } | null;
      streamingSpeaker: { stop: () => Promise<void> } | null;
      speaker: { stop: () => Promise<void> } | null;
    };
    state.lifecycle = "running";
    state.running = true;
    state.dashboard = {
      stop: () => { dashboardStops += 1; return Promise.resolve(); },
    };
    state.webVoice = {
      stop: () => {
        webStops += 1;
        return webStops === 1
          ? Promise.reject(new Error("web handler still owns the brain"))
          : Promise.resolve();
      },
    };
    state.brain = { stop: () => { brainStops += 1; return Promise.resolve(); } };
    state.streamingSpeaker = { stop: () => Promise.resolve() };
    state.speaker = { stop: () => { speakerStops += 1; return Promise.resolve(); } };

    await expect(daemon.stop()).rejects.toThrow("external ingress did not drain");
    expect(brainStops).toBe(0);
    expect(speakerStops).toBe(0);
    expect(state.lifecycle).toBe("stopping");

    await daemon.stop();
    expect(webStops).toBe(2);
    expect(dashboardStops).toBe(2);
    expect(brainStops).toBe(1);
    expect(speakerStops).toBe(1);
    expect(state.lifecycle).toBe("idle");
  });

  test("a required configured provider failure rolls back every started provider and the PID lease", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-daemon-required-provider-test-"));
    const pidFile = join(home, "cicero.pid");
    const config = loadConfig({}, { home });
    config.raw.dashboard = { enabled: false };
    config.raw.stt = { backend: "company-stt-plugin" };
    const stopped: string[] = [];
    const daemon = new CiceroDaemon(config, {
      pidFile,
      providerFactory: () => ({
        stt: {
          name: "company-stt-plugin",
          transcribe: () => Promise.resolve(null),
          start: () => Promise.reject(new Error("GPU seat unavailable")),
          health: () => Promise.resolve(false),
          stop: async () => { stopped.push("stt"); },
        },
        tts: {
          name: "company-tts-plugin",
          generateAudio: () => Promise.resolve(new ArrayBuffer(0)),
          start: () => Promise.resolve(),
          health: () => Promise.resolve(true),
          stop: async () => { stopped.push("tts"); },
        },
        llm: {
          name: "company-llm-plugin",
          chatCompletion: () => Promise.resolve("ok"),
          start: () => Promise.resolve(),
          health: () => Promise.resolve(true),
          stop: async () => { stopped.push("llm"); },
        },
      }),
    });

    try {
      const outcome = await daemon.start().then(
        () => null,
        (error: unknown) => error,
      );
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain(
        "Configured STT primary stt.backend='company-stt-plugin' failed to start: GPU seat unavailable",
      );
      expect((outcome as Error).message).toContain(
        "Check the provider or plugin configuration for stt.backend",
      );
      expect((outcome as Error).message).not.toContain("mlx-whisper, faster-whisper");
      expect(new Set(stopped)).toEqual(new Set(["stt", "tts", "llm"]));
      expect(existsSync(pidFile)).toBe(false);
    } catch (error) {
      await daemon.stop().catch(() => {});
      throw new Error(`required provider rollback test failed: ${(error as Error).message}`, { cause: error });
    }
  });

  test("--no-servers still verifies a required external primary without taking ownership", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-daemon-external-provider-test-"));
    const pidFile = join(home, "cicero.pid");
    const config = loadConfig({}, { home });
    config.raw.dashboard = { enabled: false };
    config.raw.stt = { backend: "remote-company-stt", host: "speech.internal" };
    const lifecycleCalls: string[] = [];
    const daemon = new CiceroDaemon(config, {
      skipServers: true,
      pidFile,
      providerFactory: () => ({
        stt: {
          name: "remote-company-stt",
          transcribe: () => Promise.resolve(null),
          start: async () => { lifecycleCalls.push("start"); },
          health: async () => { lifecycleCalls.push("health"); return false; },
          stop: async () => { lifecycleCalls.push("stop"); },
        },
        tts: {
          name: "unused-tts",
          generateAudio: () => Promise.resolve(new ArrayBuffer(0)),
          health: () => Promise.resolve(true),
        },
        llm: {
          name: "unused-llm",
          chatCompletion: () => Promise.resolve("ok"),
          health: () => Promise.resolve(true),
        },
      }),
    });

    try {
      await expect(daemon.start()).rejects.toThrow(
        "stt.backend='remote-company-stt' failed its health check",
      );
      expect(lifecycleCalls).toEqual(["health"]);
      expect(existsSync(pidFile)).toBe(false);
    } catch (error) {
      await daemon.stop().catch(() => {});
      throw new Error(`external required provider test failed: ${(error as Error).message}`, { cause: error });
    }
  });

  test("required primaries can start while later STT and TTS warmup failures remain optional", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-daemon-optional-warmup-test-"));
    const pidFile = join(home, "cicero.pid");
    const pairingFile = join(home, "web-voice", "pairing.json");
    const config = loadConfig({}, { home });
    config.raw.headless = true;
    config.raw.dashboard = { enabled: false };
    config.raw.stt = { backend: "company-stt-plugin" };
    config.raw.tts = { backend: "company-tts-plugin" };
    config.raw.web_voice = {
      enabled: true,
      port: 0,
      token: "test-token-that-is-long-enough",
      tls: { enabled: false },
    };
    config.raw.brain = {
      ...config.raw.brain,
      backend: "qwen",
      mode: "subprocess",
      binary: process.execPath,
      binary_args: ["-e", "console.log('ok')"],
      thinking_filler: false,
    };
    const warmups: string[] = [];
    const daemon = new CiceroDaemon(config, {
      pidFile,
      webVoiceServerStarter: () => ({
        scheme: "http",
        port: 18_443,
        clientCount: () => 0,
        notify: () => Promise.resolve(null),
        stop: () => Promise.resolve(),
      }),
      providerFactory: () => ({
        stt: {
          name: "company-stt-plugin",
          transcribe: () => Promise.resolve(null),
          start: () => Promise.resolve(),
          health: () => Promise.resolve(true),
          warmup: async () => {
            warmups.push("stt");
            throw new Error("STT warmup deliberately failed");
          },
          stop: () => Promise.resolve(),
        },
        tts: {
          name: "company-tts-plugin",
          generateAudio: () => Promise.resolve(new ArrayBuffer(0)),
          start: () => Promise.resolve(),
          health: () => Promise.resolve(true),
          warmup: async () => {
            warmups.push("tts");
            throw new Error("TTS warmup deliberately failed");
          },
          stop: () => Promise.resolve(),
        },
        llm: {
          name: "company-llm-plugin",
          chatCompletion: () => Promise.resolve("ok"),
          start: () => Promise.resolve(),
          health: () => Promise.resolve(true),
          stop: () => Promise.resolve(),
        },
      }),
    });

    try {
      await daemon.start();
      await Bun.sleep(20);
      expect(new Set(warmups)).toEqual(new Set(["stt", "tts"]));
      expect(existsSync(pidFile)).toBe(true);
      expect(readPairingState(pairingFile)).toMatchObject({
        scheme: "http",
        tunnelProvider: null,
        tunnelUrl: null,
        pid: process.pid,
      });
      expect(readFileSync(pairingFile, "utf8")).not.toContain("test-token-that-is-long-enough");
      await daemon.stop();
      expect(existsSync(pidFile)).toBe(false);
      expect(existsSync(pairingFile)).toBe(false);
    } catch (error) {
      await daemon.stop().catch(() => {});
      throw new Error(`optional warmup test failed: ${(error as Error).message}`, { cause: error });
    }
  });
});
