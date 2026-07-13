import { test, expect, describe } from "bun:test";
import { SilentSpeaker } from "../src/speaker/silent-speaker";
import { SystemSpeaker } from "../src/platform/system-tts";

describe("SilentSpeaker", () => {
  test("speak does nothing", async () => {
    const speaker = new SilentSpeaker();
    await speaker.speak("hello");
    expect(await speaker.health()).toBe(true);
  });
});

describe("SystemSpeaker", () => {
  test("health returns true", async () => {
    const speaker = new SystemSpeaker();
    expect(await speaker.health()).toBe(true);
  });
});
