import { expect, test } from "bun:test";
import { startWebVoiceServer } from "../../src/web-voice/server";
import {
  assertHeadlessWebVoiceConfigured,
  assertHeadlessWebVoiceStarted,
  resolveWebVoiceToken,
} from "../../src/web-voice/startup-policy";

test("missing and whitespace-only web tokens always become ephemeral credentials", () => {
  let generated = 0;
  const generate = () => `generated-${++generated}`;

  expect(resolveWebVoiceToken(undefined, generate)).toEqual({ token: "generated-1", ephemeral: true });
  expect(resolveWebVoiceToken(null, generate)).toEqual({ token: "generated-2", ephemeral: true });
  expect(resolveWebVoiceToken("", generate)).toEqual({ token: "generated-3", ephemeral: true });
  expect(resolveWebVoiceToken(" \t\n", generate)).toEqual({ token: "generated-4", ephemeral: true });
  expect(resolveWebVoiceToken("  stable-secret-at-least-16  ", generate)).toEqual({
    token: "stable-secret-at-least-16",
    ephemeral: false,
  });
  expect(generated).toBe(4);
});

test("documented token placeholders are rejected even when config validation is bypassed", () => {
  for (const token of ["<generate-a-secret>", "generate-a-secret", "paste-your-token-here"]) {
    expect(() => resolveWebVoiceToken(token)).toThrow(/documented placeholder/);
  }
  expect(() => resolveWebVoiceToken("short-secret")).toThrow(/at least 16/);
  expect(() => resolveWebVoiceToken(42)).toThrow(/must be a string/);
  expect(resolveWebVoiceToken("your-token-a91f4d68c2e740ba949aa8c56cb3f671")).toEqual({
    token: "your-token-a91f4d68c2e740ba949aa8c56cb3f671",
    ephemeral: false,
  });
});

test("headless mode requires web voice before allocating runtime components", () => {
  expect(() => assertHeadlessWebVoiceConfigured(true, false)).toThrow(/requires web_voice\.enabled/);
  expect(() => assertHeadlessWebVoiceConfigured(true, true)).not.toThrow();
  expect(() => assertHeadlessWebVoiceConfigured(false, false)).not.toThrow();
});

test("an occupied web port is fatal when it is the only headless surface", () => {
  const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
  try {
    const handle = startWebVoiceServer({
      host: "127.0.0.1",
      port: blocker.port,
      token: crypto.randomUUID(),
      tls: null,
      onTurn: () => Promise.resolve({ transcript: "", reply: "", audio: new ArrayBuffer(0) }),
    });
    expect(handle).toBeNull();
    expect(() => assertHeadlessWebVoiceStarted(true, handle !== null, "127.0.0.1", blocker.port)).toThrow(
      /refusing to report Cicero ready/,
    );
    expect(() => assertHeadlessWebVoiceStarted(false, handle !== null, "127.0.0.1", blocker.port)).not.toThrow();
  } finally {
    blocker.stop(true);
  }
});
