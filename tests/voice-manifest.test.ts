import { test, expect, describe } from "bun:test";
import { parseManifest, serializeManifest } from "../src/voice/manifest";

describe("VoiceManifest", () => {
  test("round-trips through YAML", () => {
    const m = {
      name: "jarvis",
      provider: "vibevoice" as const,
      source_clip: "/tmp/jarvis.wav",
      created_at: "2026-05-14T12:00:00Z",
    };
    const yaml = serializeManifest(m);
    const parsed = parseManifest(yaml);
    expect(parsed.name).toBe("jarvis");
    expect(parsed.provider).toBe("vibevoice");
    expect(parsed.source_clip).toBe("/tmp/jarvis.wav");
  });

  test("rejects unknown provider", () => {
    const yaml =
      "name: bad\nprovider: nonexistent\nsource_clip: /tmp/x.wav\ncreated_at: 2026-05-14T12:00:00Z\n";
    expect(() => parseManifest(yaml)).toThrow(/provider/);
  });

  test("requires source_clip", () => {
    const yaml = "name: bad\nprovider: vibevoice\ncreated_at: 2026-05-14T12:00:00Z\n";
    expect(() => parseManifest(yaml)).toThrow(/source_clip/);
  });

  test("requires name", () => {
    const yaml = "provider: vibevoice\nsource_clip: /tmp/x.wav\ncreated_at: 2026-05-14T12:00:00Z\n";
    expect(() => parseManifest(yaml)).toThrow(/name/);
  });
});
