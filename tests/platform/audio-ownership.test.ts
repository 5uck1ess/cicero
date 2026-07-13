import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AudioReleaseUnconfirmedError,
  OwnedAudioPlayer,
  type AudioPlayerProcess,
} from "../../src/platform/owned-audio-player";

interface FakePlayer extends AudioPlayerProcess {
  signals: Array<NodeJS.Signals | number | undefined>;
  finish(code: number): void;
  fail(error: Error): void;
}

function fakePlayer(pid: number, exitOnKill = true): FakePlayer {
  let resolveExit!: (code: number) => void;
  let rejectExit!: (error: Error) => void;
  let settled = false;
  const exited = new Promise<number>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  return {
    pid,
    exited,
    signals,
    kill(signal) {
      signals.push(signal);
      if (settled || !exitOnKill) return;
      settled = true;
      resolveExit(signal === "SIGKILL" ? 137 : 143);
    },
    finish(code) {
      if (settled) return;
      settled = true;
      resolveExit(code);
    },
    fail(error) {
      if (settled) return;
      settled = true;
      rejectExit(error);
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("stopAll terminates and reaps only this player's exact concurrent children", async () => {
  const owned = [fakePlayer(101), fakePlayer(102)];
  const unrelated = fakePlayer(999);
  const spawned: string[][] = [];
  const player = new OwnedAudioPlayer(
    (path) => ["fixture-player", path],
    (command) => {
      spawned.push(command);
      return owned[spawned.length - 1]!;
    },
  );

  const first = player.play("first.wav");
  const second = player.play("second.wav");
  await Bun.sleep(0);
  await player.stopAll();

  await expect(first).resolves.toBeUndefined();
  await expect(second).resolves.toBeUndefined();
  expect(owned[0]!.signals).toEqual(["SIGTERM"]);
  expect(owned[1]!.signals).toEqual(["SIGTERM"]);
  expect(unrelated.signals).toEqual([]);
  expect(spawned).toEqual([
    ["fixture-player", "first.wav"],
    ["fixture-player", "second.wav"],
  ]);
});

test("stopAll invalidates a pre-stop asynchronous command resolution", async () => {
  const resolution = deferred<string[]>();
  let spawns = 0;
  const player = new OwnedAudioPlayer(
    () => resolution.promise,
    () => {
      spawns += 1;
      return fakePlayer(103);
    },
  );

  const playing = player.play("late.wav");
  await Bun.sleep(0);
  await player.stopAll();
  resolution.resolve(["fixture-player", "late.wav"]);

  await expect(playing).resolves.toBeUndefined();
  expect(spawns).toBe(0);
});

test("a natural nonzero player exit is reported", async () => {
  const child = fakePlayer(104);
  const player = new OwnedAudioPlayer(() => ["fixture-player", "bad.wav"], () => child);
  const playing = player.play("bad.wav");
  await Bun.sleep(0);
  child.finish(7);

  await expect(playing).rejects.toThrow("exited with 7");
});

test("concurrent stopAll calls coalesce one owned termination", async () => {
  const child = fakePlayer(105);
  const player = new OwnedAudioPlayer(() => ["fixture-player", "one.wav"], () => child);
  const playing = player.play("one.wav");
  await Bun.sleep(0);

  const firstStop = player.stopAll();
  const secondStop = player.stopAll();
  expect(secondStop).toBe(firstStop);
  await Promise.all([firstStop, secondStop, playing]);
  expect(child.signals).toEqual(["SIGTERM"]);
});

test("stopAll does not resolve until its exact child is reaped", async () => {
  const child = fakePlayer(106, false);
  const player = new OwnedAudioPlayer(() => ["fixture-player", "slow.wav"], () => child);
  const playing = player.play("slow.wav");
  await Bun.sleep(0);

  let stopped = false;
  const stopping = player.stopAll().then(() => { stopped = true; });
  await Bun.sleep(5);
  expect(stopped).toBe(false);
  expect(child.signals).toEqual(["SIGTERM"]);
  child.finish(0);

  await stopping;
  await playing;
  expect(stopped).toBe(true);
});

test("an unobservable child exit blocks later playback as unconfirmed", async () => {
  const child = fakePlayer(107);
  let spawns = 0;
  const player = new OwnedAudioPlayer(
    (path) => ["fixture-player", path],
    () => {
      spawns += 1;
      return child;
    },
  );
  const playing = player.play("uncertain.wav");
  await Bun.sleep(0);
  child.fail(new Error("waitpid failed"));

  await expect(playing).rejects.toBeInstanceOf(AudioReleaseUnconfirmedError);
  await expect(player.play("must-not-overlap.wav")).rejects
    .toBeInstanceOf(AudioReleaseUnconfirmedError);
  expect(spawns).toBe(1);
});

test("platform players contain no process-wide kill or external which command", () => {
  for (const file of ["audio-macos.ts", "audio-linux.ts", "audio-windows.ts"]) {
    const source = readFileSync(join(import.meta.dir, "../..", "src", "platform", file), "utf8");
    expect(source, file).not.toMatch(/\b(?:pkill|taskkill)\b/);
    expect(source, file).not.toMatch(/Bun\.spawn\(\["which"/);
  }
});
