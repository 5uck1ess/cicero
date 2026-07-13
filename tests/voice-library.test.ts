import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceLibrary } from "../src/voice/library";

describe("VoiceLibrary", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cicero-voices-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("list returns empty array on fresh dir", async () => {
    const lib = new VoiceLibrary(dir);
    expect(await lib.list()).toEqual([]);
  });

  test("add and list", async () => {
    const lib = new VoiceLibrary(dir);
    await lib.add({
      name: "jarvis",
      provider: "vibevoice",
      source_clip: "/tmp/fake.wav",
      created_at: "2026-05-14T12:00:00Z",
    });
    const all = await lib.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("jarvis");
  });

  test("get returns the manifest by name, null when absent", async () => {
    const lib = new VoiceLibrary(dir);
    await lib.add({ name: "jarvis", provider: "vibevoice", source_clip: "/tmp/x.wav", created_at: "2026-05-14T12:00:00Z" });
    const m = await lib.get("jarvis");
    expect(m?.provider).toBe("vibevoice");
    expect(await lib.get("nope")).toBeNull();
  });

  test("remove deletes the voice dir", async () => {
    const lib = new VoiceLibrary(dir);
    await lib.add({ name: "jarvis", provider: "vibevoice", source_clip: "/tmp/x.wav", created_at: "2026-05-14T12:00:00Z" });
    await lib.remove("jarvis");
    expect(await lib.list()).toEqual([]);
  });

  test("remove throws on unknown voice", async () => {
    const lib = new VoiceLibrary(dir);
    await expect(lib.remove("ghost")).rejects.toThrow(/not found/);
  });

  test("rejects duplicate names", async () => {
    const lib = new VoiceLibrary(dir);
    await lib.add({ name: "jarvis", provider: "vibevoice", source_clip: "/tmp/x.wav", created_at: "2026-05-14T12:00:00Z" });
    await expect(
      lib.add({ name: "jarvis", provider: "elevenlabs", source_clip: "/tmp/y.wav", created_at: "2026-05-14T12:00:00Z" }),
    ).rejects.toThrow(/exists/);
  });

  test("list is sorted by name", async () => {
    const lib = new VoiceLibrary(dir);
    await lib.add({ name: "zeta", provider: "vibevoice", source_clip: "/tmp/z.wav", created_at: "2026-05-14T12:00:00Z" });
    await lib.add({ name: "alpha", provider: "vibevoice", source_clip: "/tmp/a.wav", created_at: "2026-05-14T12:00:00Z" });
    const names = (await lib.list()).map((v) => v.name);
    expect(names).toEqual(["alpha", "zeta"]);
  });

  test.skipIf(process.platform === "win32")("write paths make root, voice directories, and manifests private", async () => {
    chmodSync(dir, 0o755);
    const lib = new VoiceLibrary(dir);
    await lib.add({ name: "jarvis", provider: "vibevoice", source_clip: "/tmp/x.wav", created_at: "2026-05-14T12:00:00Z" });
    const voiceDir = lib.voiceDir("jarvis");
    const manifest = join(voiceDir, "voice.yaml");

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(voiceDir).mode & 0o777).toBe(0o700);
    expect(statSync(manifest).mode & 0o777).toBe(0o600);
  });

  test.skipIf(process.platform === "win32")("list and get do not chmod voice or source directories", async () => {
    const lib = new VoiceLibrary(dir);
    await lib.add({ name: "jarvis", provider: "vibevoice", source_clip: "/tmp/x.wav", created_at: "2026-05-14T12:00:00Z" });
    const voiceDir = lib.voiceDir("jarvis");
    const manifest = join(voiceDir, "voice.yaml");
    const sources = join(dir, "_sources");
    mkdirSync(sources, { mode: 0o755 });

    chmodSync(voiceDir, 0o755);
    chmodSync(manifest, 0o644);
    expect((await lib.list()).map((voice) => voice.name)).toEqual(["jarvis"]);
    await lib.get("jarvis");
    expect(statSync(voiceDir).mode & 0o777).toBe(0o755);
    expect(statSync(manifest).mode & 0o777).toBe(0o644);
    expect(statSync(sources).mode & 0o777).toBe(0o755);
  });

  test("rejects traversal and absolute voice names", async () => {
    const lib = new VoiceLibrary(dir);
    const invalid = ["", ".", "..", "../outside", "nested/voice", "nested\\voice", join(tmpdir(), "outside")];
    for (const name of invalid) {
      expect(() => lib.voiceDir(name)).toThrow(/invalid voice name/);
      await expect(lib.get(name)).rejects.toThrow(/invalid voice name/);
      await expect(lib.remove(name)).rejects.toThrow(/invalid voice name/);
    }
  });

  test.skipIf(process.platform === "win32")("does not follow or recursively remove a voice-directory symlink", async () => {
    const lib = new VoiceLibrary(dir);
    const outside = mkdtempSync(join(tmpdir(), "cicero-voice-outside-"));
    const marker = join(outside, "keep.txt");
    writeFileSync(marker, "keep");
    symlinkSync(outside, join(dir, "escape"), "dir");

    try {
      await expect(lib.get("escape")).rejects.toThrow(/unsafe voice directory/);
      await expect(lib.remove("escape")).rejects.toThrow(/unsafe voice directory/);
      expect(await lib.list()).toEqual([]);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("rejects a manifest symlink that leaves the voice directory", async () => {
    const lib = new VoiceLibrary(dir);
    const voiceDir = lib.prepareVoiceDir("escape");
    const outside = join(dir, "outside.yaml");
    writeFileSync(outside, "name: escape\nprovider: vibevoice\nsource_clip: /tmp/x.wav\ncreated_at: 2026-05-14T12:00:00Z\n");
    symlinkSync(outside, join(voiceDir, "voice.yaml"), "file");

    await expect(lib.get("escape")).rejects.toThrow(/unsafe voice manifest/);
    expect(await lib.list()).toEqual([]);
  });
});
