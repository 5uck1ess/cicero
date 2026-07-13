import { test, expect, describe } from "bun:test";
import { voiceToConfigFields } from "../src/voice/resolve";

describe("voiceToConfigFields", () => {
  test("vibevoice resolves to reference clip fields", () => {
    const fields = voiceToConfigFields({
      name: "jarvis",
      provider: "vibevoice",
      source_clip: "/v/jarvis/sample.wav",
      trimmed_clip: "/v/jarvis/trimmed-16k-mono.wav",
      ref_text: "hello there",
      created_at: "2026-05-14T12:00:00Z",
    });
    expect(fields.voice).toBe("jarvis");
    expect(fields.voice_ref_audio).toBe("/v/jarvis/trimmed-16k-mono.wav");
    expect(fields.voice_ref_text).toBe("hello there");
    expect(fields.tts).toEqual({
      backend: "vibevoice",
      voice: "jarvis",
      refAudio: "/v/jarvis/trimmed-16k-mono.wav",
      refText: "hello there",
    });
  });

  test("vibevoice falls back to source clip when not trimmed", () => {
    const fields = voiceToConfigFields({
      name: "jarvis",
      provider: "vibevoice",
      source_clip: "/v/jarvis/sample.wav",
      created_at: "2026-05-14T12:00:00Z",
    });
    expect(fields.voice_ref_audio).toBe("/v/jarvis/sample.wav");
  });

  test("elevenlabs resolves to backend + voice_id", () => {
    const fields = voiceToConfigFields({
      name: "jarvis-cloud",
      provider: "elevenlabs",
      source_clip: "/v/jarvis-cloud/sample.wav",
      voice_id: "abc123",
      created_at: "2026-05-14T12:00:00Z",
    });
    expect(fields.voice).toBe("jarvis-cloud");
    expect(fields.tts?.backend).toBe("elevenlabs");
    expect(fields.tts?.voice).toBe("abc123");
    expect(fields.voice_ref_audio).toBeUndefined();
  });

  test("rejects an incomplete cloud manifest instead of activating a broken backend", () => {
    expect(() => voiceToConfigFields({
      name: "broken-cloud",
      provider: "elevenlabs",
      source_clip: "/v/broken/sample.wav",
      created_at: "2026-05-14T12:00:00Z",
    })).toThrow(/missing.*voice_id/);
  });
});
