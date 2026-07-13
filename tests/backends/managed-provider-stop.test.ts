import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OllamaProvider } from "../../src/backends/llm/ollama";
import { AudioCppSTTProvider } from "../../src/backends/stt/audiocpp";
import { FasterWhisperProvider } from "../../src/backends/stt/faster-whisper";
import { MlxWhisperProvider } from "../../src/backends/stt/mlx-whisper";
import type { ManagedProcess } from "../../src/backends/managed-server";

const MANAGED_PROVIDER_FILES = [
  "src/backends/llm/mlx-lm.ts",
  "src/backends/ser/emotion2vec.ts",
  "src/backends/tts/vibevoice.ts",
  "src/backends/llm/ollama.ts",
  "src/backends/tts/pocket.ts",
  "src/backends/llm/llama-cpp.ts",
  "src/backends/turn/smart-turn.ts",
  "src/backends/tts/kokoro.ts",
  "src/backends/tts/audiocpp.ts",
  "src/backends/tts/mlx-audio.ts",
] as const;

const RETRYABLE_MANAGED_STT_FILES = [
  "src/backends/stt/faster-whisper.ts",
  "src/backends/stt/mlx-whisper.ts",
  "src/backends/stt/audiocpp.ts",
] as const;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a provider clears its exact managed handle even when reap observation fails", async () => {
  const provider = new OllamaProvider({ backend: "ollama" });
  const failedExit = Promise.reject<number>(new Error("fixture exit observation failed"));
  void failedExit.catch(() => { /* the provider stop observes the same rejection */ });
  const managed: ManagedProcess = {
    proc: {
      pid: 999_999,
      exited: failedExit,
      exitCode: null,
      signalCode: null,
      kill() {},
    } as never,
    port: 11434,
    managed: true,
    mode: "process",
  };
  const state = provider as unknown as { managed: ManagedProcess | null };
  state.managed = managed;

  await expect(provider.stop()).rejects.toThrow("cleanup failed");
  expect(state.managed).toBeNull();
  await expect(provider.stop()).resolves.toBeUndefined();
});

test("an in-flight stop cannot clear a replacement managed handle", async () => {
  const provider = new OllamaProvider({ backend: "ollama" });
  const exit = deferred<number>();
  const terminationStarted = deferred<void>();
  const original: ManagedProcess = {
    proc: {
      pid: 999_998,
      exited: exit.promise,
      exitCode: null,
      signalCode: null,
      kill() { terminationStarted.resolve(); },
    } as never,
    port: 11434,
    managed: true,
    mode: "process",
  };
  const replacement: ManagedProcess = {
    proc: null,
    port: 11434,
    managed: false,
    mode: "process",
  };
  const state = provider as unknown as { managed: ManagedProcess | null };
  state.managed = original;

  const stopping = provider.stop();
  await terminationStarted.promise;
  state.managed = replacement;
  exit.resolve(0);

  await expect(stopping).resolves.toBeUndefined();
  expect(state.managed).toBe(replacement);
});

test("managed STT starts coalesce and restart waits until a racing stop releases ownership", async () => {
  const providers = [
    new FasterWhisperProvider({ backend: "faster-whisper" }),
    new MlxWhisperProvider({ backend: "mlx-whisper" }),
    new AudioCppSTTProvider({ backend: "audiocpp" }),
  ];

  for (const [index, provider] of providers.entries()) {
    const launch = deferred<void>();
    let starts = 0;
    const state = provider as unknown as {
      managed: ManagedProcess | null;
      active: boolean;
      doStart: () => Promise<void>;
    };
    state.doStart = async () => {
      try {
        starts++;
        if (starts === 1) await launch.promise;
        state.managed = {
          proc: null,
          port: 20_000 + index,
          managed: false,
          mode: "process",
        };
        state.active = true;
      } catch (error: unknown) {
        throw error;
      }
    };

    const first = provider.start();
    const duplicate = provider.start();
    await Bun.sleep(0);
    expect(starts, provider.name).toBe(1);

    const stopping = provider.stop();
    const restarting = provider.start();
    await Bun.sleep(0);
    expect(starts, provider.name).toBe(1);

    launch.resolve(undefined);
    await first;
    await duplicate;
    await stopping;
    await restarting;
    expect(starts, provider.name).toBe(2);
    expect(state.managed, provider.name).not.toBeNull();
    await provider.start();
    expect(starts, provider.name).toBe(2);
    await provider.stop();
    expect(state.managed, provider.name).toBeNull();
  }
});

test("managed STT lifecycle honors a final stop queued after a pending restart", async () => {
  const providers = [
    new FasterWhisperProvider({ backend: "faster-whisper" }),
    new MlxWhisperProvider({ backend: "mlx-whisper" }),
    new AudioCppSTTProvider({ backend: "audiocpp" }),
  ];

  for (const provider of providers) {
    const firstLaunch = deferred<void>();
    let starts = 0;
    let stops = 0;
    const state = provider as unknown as {
      active: boolean;
      doStart: () => Promise<void>;
      doStop: () => Promise<void>;
    };
    state.doStart = async () => {
      try {
        starts++;
        if (starts === 1) await firstLaunch.promise;
        state.active = true;
      } catch (error: unknown) {
        throw error;
      }
    };
    state.doStop = () => {
      stops++;
      state.active = false;
      return Promise.resolve();
    };

    const firstStart = provider.start();
    const firstStop = provider.stop();
    const restart = provider.start();
    const finalStop = provider.stop();
    await Bun.sleep(0);
    expect(starts, provider.name).toBe(1);

    firstLaunch.resolve(undefined);
    await Promise.all([firstStart, firstStop, restart, finalStop]);
    expect(starts, provider.name).toBe(2);
    expect(stops, provider.name).toBe(2);
    expect(state.active, provider.name).toBe(false);
  }
});

test("managed STT providers fail closed after unconfirmed cleanup", async () => {
  const providers = [
    new FasterWhisperProvider({ backend: "faster-whisper" }),
    new MlxWhisperProvider({ backend: "mlx-whisper" }),
    new AudioCppSTTProvider({ backend: "audiocpp" }),
  ];

  for (const provider of providers) {
    let starts = 0;
    const state = provider as unknown as {
      active: boolean;
      doStart: () => Promise<void>;
      doStop: () => Promise<void>;
    };
    state.doStart = async () => {
      try {
        starts++;
        state.active = true;
      } catch (error: unknown) {
        throw error;
      }
    };
    state.doStop = () => Promise.reject(new Error("managed child was not reaped"));

    await provider.start();
    const stopping = provider.stop().catch((error: unknown) => error);
    const racedRestart = provider.start().catch((error: unknown) => error);
    const stopError = await stopping;
    const restartError = await racedRestart;
    expect(stopError).toBeInstanceOf(Error);
    expect(String(stopError)).toContain("managed child was not reaped");
    expect(String(restartError)).toContain("prior cleanup failed");
    await expect(provider.start()).rejects.toThrow("prior cleanup failed");
    expect(starts, provider.name).toBe(1);
  }
});

test("managed STT providers retain uncertain ownership and admit a later cleanup retry", async () => {
  const providers = [
    new FasterWhisperProvider({ backend: "faster-whisper" }),
    new MlxWhisperProvider({ backend: "mlx-whisper" }),
    new AudioCppSTTProvider({ backend: "audiocpp" }),
  ];
  const fixtures = providers.map((provider, index) => {
    const exit = deferred<number>();
    const managed: ManagedProcess = {
      proc: {
        pid: 999_900 - index,
        exited: exit.promise,
        exitCode: null,
        signalCode: null,
        kill() {},
      } as never,
      port: 20_100 + index,
      managed: true,
      mode: "process",
    };
    const state = provider as unknown as {
      managed: ManagedProcess | null;
      active: boolean;
      cleanupFailure: Error | null;
      doStart: () => Promise<void>;
    };
    state.managed = managed;
    state.active = true;
    return { provider, exit, managed, state };
  });

  const failedStops = await Promise.all(fixtures.map(({ provider }) =>
    provider.stop().catch((error: unknown) => error)));
  for (const [index, error] of failedStops.entries()) {
    const fixture = fixtures[index]!;
    expect(error, fixture.provider.name).toBeInstanceOf(Error);
    expect(fixture.state.managed, fixture.provider.name).toBe(fixture.managed);
    expect(fixture.state.cleanupFailure, fixture.provider.name).toBeInstanceOf(Error);
    await expect(fixture.provider.start()).rejects.toThrow("prior cleanup failed");
  }

  for (const fixture of fixtures) fixture.exit.resolve(0);
  await Promise.all(fixtures.map(({ provider }) => provider.stop()));
  for (const fixture of fixtures) {
    expect(fixture.state.managed, fixture.provider.name).toBeNull();
    expect(fixture.state.cleanupFailure, fixture.provider.name).toBeNull();
    fixture.state.doStart = () => {
      fixture.state.active = true;
      return Promise.resolve();
    };
    await expect(fixture.provider.start()).resolves.toBeUndefined();
  }
});

test("non-retryable managed backends use identity-guarded finally cleanup", () => {
  for (const file of MANAGED_PROVIDER_FILES) {
    const source = readFileSync(join(import.meta.dir, "../..", file), "utf8");
    expect(source, file).toMatch(/finally\s*\{\s*if \(this\.managed === managed\) this\.managed = null;\s*\}/);
  }
});

test("retryable managed STT cleanup retains the exact handle until reap succeeds", () => {
  for (const file of RETRYABLE_MANAGED_STT_FILES) {
    const source = readFileSync(join(import.meta.dir, "../..", file), "utf8");
    expect(source, file).toMatch(/await stopManagedServer\(managed\);\s*if \(this\.managed === managed\) this\.managed = null;/);
    expect(source, file).not.toMatch(/finally\s*\{\s*if \(this\.managed === managed\) this\.managed = null;\s*\}/);
  }
});
