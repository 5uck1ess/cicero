import { test, expect, describe } from "bun:test";
import { createAudioPlayer, createAudioRecorder, getPlayCommand } from "../../src/platform/audio";
import type { AudioPlayer, AudioRecorder } from "../../src/platform/audio";

describe("createAudioPlayer", () => {
  test("returns a player with play and stopAll methods", () => {
    const player = createAudioPlayer();
    expect(typeof player.play).toBe("function");
    expect(typeof player.stopAll).toBe("function");
  });
});

describe("createAudioRecorder", () => {
  test("returns a recorder with record method", () => {
    const recorder = createAudioRecorder();
    expect(typeof recorder.record).toBe("function");
  });
});

describe("getPlayCommand", () => {
  test("uses aplay when available on Linux", () => {
    expect(getPlayCommand("voice.wav", "linux", binary => binary === "aplay" ? "/usr/bin/aplay" : null))
      .toEqual(["aplay", "voice.wav"]);
  });

  test("falls back to paplay on PulseAudio-only Linux systems", () => {
    expect(getPlayCommand("voice.wav", "linux", () => null))
      .toEqual(["paplay", "voice.wav"]);
  });
});
