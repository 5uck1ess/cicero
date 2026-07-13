import { expect, test } from "bun:test";
import { AudioReleaseUnconfirmedError } from "../../src/platform/owned-audio-player";
import {
  SystemSpeaker,
  type SpawnSystemTts,
  type SystemTtsSpec,
} from "../../src/platform/system-tts";
import type { DirectChildProcess } from "../../src/process/direct-child";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function settlesWithin<T>(promise: PromiseLike<T>, label: string, timeoutMs = 100): Promise<T> {
  return Promise.race([
    Promise.resolve(promise),
    Bun.sleep(timeoutMs).then(() => { throw new Error(`${label} did not settle`); }),
  ]);
}

function controlledChild(pid: number, exitOnKill = true): DirectChildProcess & {
  signals: Array<NodeJS.Signals | number | undefined>;
  finish(code: number): void;
  failExit(reason: unknown): void;
} {
  const exit = deferred<number>();
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  let settled = false;
  return {
    pid,
    exited: exit.promise,
    signals,
    kill(signal) {
      signals.push(signal);
      if (settled || !exitOnKill) return;
      settled = true;
      exit.resolve(143);
    },
    finish(code) {
      if (settled) return;
      settled = true;
      exit.resolve(code);
    },
    failExit(reason) {
      if (settled) return;
      settled = true;
      exit.reject(reason);
    },
  };
}

function queueSpawner(children: DirectChildProcess[], seen: SystemTtsSpec[] = []): SpawnSystemTts {
  return (spec) => {
    const child = children.shift();
    if (!child) throw new Error("system TTS fixture queue exhausted");
    seen.push(spec);
    return { process: child };
  };
}

test("SystemSpeaker stop terminates and reaps every concurrent system voice", async () => {
  const first = controlledChild(501);
  const second = controlledChild(502);
  const speaker = new SystemSpeaker("darwin", queueSpawner([first, second]));

  const firstSpeak = speaker.speak("first");
  const secondSpeak = speaker.speak("second");
  await speaker.stop();
  await Promise.all([firstSpeak, secondSpeak]);

  expect(first.signals).toEqual(["SIGTERM"]);
  expect(second.signals).toEqual(["SIGTERM"]);
});

test("an older completion cannot hide a newer live system voice from stop", async () => {
  const first = controlledChild(503);
  const second = controlledChild(504);
  const speaker = new SystemSpeaker("linux", queueSpawner([first, second]));

  const firstSpeak = speaker.speak("first");
  const secondSpeak = speaker.speak("second");
  first.finish(0);
  await firstSpeak;
  await speaker.stop();
  await secondSpeak;

  expect(first.signals).toEqual([]);
  expect(second.signals).toEqual(["SIGTERM"]);
});

test("SystemSpeaker waits for SIGKILL reap instead of releasing audio ownership early", async () => {
  const child = controlledChild(505, false);
  const speaker = new SystemSpeaker("darwin", queueSpawner([child]));
  const speaking = speaker.speak("resistant");
  let stopped = false;
  const stopping = speaker.stop().then(() => { stopped = true; });

  await Bun.sleep(300);
  expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(stopped).toBe(false);
  child.finish(137);
  await stopping;
  await speaking;
  expect(stopped).toBe(true);
});

test("failed stop releases its speak caller and a later observed exit admits stop retry", async () => {
  const child = controlledChild(513, false);
  const speaker = new SystemSpeaker("darwin", queueSpawner([child]));
  const speaking = speaker.speak("unreaped");
  void speaking.catch(() => {});

  await expect(speaker.stop()).rejects.toBeInstanceOf(AudioReleaseUnconfirmedError);
  await expect(settlesWithin(speaking, "system speak after failed stop"))
    .rejects.toBeInstanceOf(AudioReleaseUnconfirmedError);
  expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);

  child.finish(137);
  await speaker.stop();
  expect(child.signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM"]);
});

test("SystemSpeaker reports nonzero natural exits but suppresses its own stop exit", async () => {
  const failed = controlledChild(506);
  const stopped = controlledChild(507);
  const first = new SystemSpeaker("linux", queueSpawner([failed]));
  const second = new SystemSpeaker("linux", queueSpawner([stopped]));

  const failure = first.speak("fail");
  failed.finish(4);
  await expect(failure).rejects.toThrow("spd-say' exited with 4");

  const intentional = second.speak("stop");
  await second.stop();
  await expect(intentional).resolves.toBeUndefined();
});

test("SystemSpeaker exposes unconfirmed exit ownership and never admits speech after stop", async () => {
  const child = controlledChild(508);
  let spawns = 0;
  const speaker = new SystemSpeaker("darwin", (spec) => {
    spawns += 1;
    expect(spec.cmd[0]).toBe("say");
    return { process: child };
  });

  const speaking = speaker.speak("uncertain");
  child.failExit(new Error("waitpid failed"));
  await expect(speaking).rejects.toBeInstanceOf(AudioReleaseUnconfirmedError);
  // A rejected exit promise does not prove the child is gone. Cleanup must be
  // attempted immediately, not deferred until a later global stop.
  expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  await expect(speaker.stop()).rejects.toBeInstanceOf(AudioReleaseUnconfirmedError);
  // Failed stop attempts remain retryable and continue targeting this exact
  // retained child rather than dropping ownership.
  await expect(speaker.stop()).rejects.toBeInstanceOf(AudioReleaseUnconfirmedError);
  expect(child.signals).toEqual([
    "SIGTERM", "SIGKILL",
    "SIGTERM", "SIGKILL",
    "SIGTERM", "SIGKILL",
  ]);
  await speaker.speak("must stay stopped");
  expect(spawns).toBe(1);
});

test("Windows stdin failure reaps the child and admits one clean retry", async () => {
  const failed = controlledChild(510);
  const retry = controlledChild(511);
  let spawns = 0;
  let retryText = "";
  const speaker = new SystemSpeaker("win32", (spec) => {
    expect(spec.cmd.join(" ")).not.toContain(spec.stdinText!);
    spawns++;
    if (spawns === 1) {
      return {
        process: failed,
        writeInput() { return Promise.reject(new Error("stdin pipe closed")); },
      };
    }
    return {
      process: retry,
      writeInput(text) { retryText = text; },
    };
  });

  await expect(speaker.speak("first payload")).rejects.toThrow("could not write system TTS input");
  expect(failed.signals).toEqual(["SIGTERM"]);

  const retried = speaker.speak("retry payload");
  retry.finish(0);
  await retried;
  expect(retryText).toBe("retry payload");
  expect(spawns).toBe(2);
});

test("stop releases a speak call whose Windows stdin finalization never settles", async () => {
  const child = controlledChild(512);
  const writerStarted = deferred<void>();
  const speaker = new SystemSpeaker("win32", () => ({
    process: child,
    writeInput() {
      writerStarted.resolve();
      return new Promise<void>(() => { /* intentionally never settles */ });
    },
  }));

  const speaking = speaker.speak("blocked stdin");
  await writerStarted.promise;
  await speaker.stop();
  await speaking;
  expect(child.signals).toEqual(["SIGTERM"]);
});

test("Windows system voice keeps text out of argv and writes the exact stdin payload", async () => {
  const child = controlledChild(509);
  let written = "";
  let command: string[] = [];
  const speaker = new SystemSpeaker("win32", (spec) => {
    command = [...spec.cmd];
    return {
      process: child,
      writeInput(text) { written = text; },
    };
  });

  const speaking = speaker.speak("quotes ' and $() stay data");
  child.finish(0);
  await speaking;

  expect(written).toBe("quotes ' and $() stay data");
  expect(command.join(" ")).not.toContain("quotes");
});
