import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const hasFfmpeg = Bun.which("ffmpeg") !== null;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");

function writeFixtureWav(path: string): void {
  const sampleRate = 16000;
  const samples = sampleRate * 2;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(dataSize + 36, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  writeFileSync(path, buf);
}

async function cli(home: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", INDEX, "voice", ...args], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out, err };
}

describe("cicero voice CLI", () => {
  let home: string;
  let clip: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cicero-home-"));
    clip = join(home, "sample.wav");
    writeFixtureWav(clip);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("list is empty on a fresh home", async () => {
    const { code, out } = await cli(home, "list");
    expect(code).toBe(0);
    expect(out).toContain("no voices yet");
  });

  test.skipIf(!hasFfmpeg)("add → list → use → inspect → remove full lifecycle", async () => {
    const add = await cli(home, "add", "tester", clip);
    expect(add.code).toBe(0);
    expect(add.out).toContain("Added voice 'tester'");

    const list = await cli(home, "list");
    expect(list.out).toContain("tester");
    expect(list.out).toContain("audiocpp"); // the default provider

    const use = await cli(home, "use", "tester");
    expect(use.code).toBe(0);
    expect(use.out).toContain("Active voice → tester");

    // `use` should have written the active voice into config.yaml
    const cfgPath = join(home, ".cicero", "config.yaml");
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = parseYaml(await Bun.file(cfgPath).text());
    expect(cfg.voice).toBe("tester");
    // audio.cpp always activates its provider-safe <=18-second derivative.
    expect(cfg.voice_ref_audio).toContain("trimmed-18s.wav");
    expect(cfg.tts.backend).toBe("audiocpp");
    expect(cfg.tts.refAudio).toBe(cfg.voice_ref_audio);

    const inspect = await cli(home, "inspect", "tester");
    expect(inspect.code).toBe(0);
    expect(inspect.out).toContain('"provider": "audiocpp"');

    const remove = await cli(home, "remove", "tester");
    expect(remove.code).toBe(0);

    const afterList = await cli(home, "list");
    expect(afterList.out).toContain("no voices yet");
  }, 30000);

  test("use on a missing voice exits non-zero", async () => {
    const { code, err } = await cli(home, "use", "ghost");
    expect(code).toBe(1);
    expect(err).toContain("not found");
  });

  test("switching providers replaces stale provider-specific config", async () => {
    try {
      const ciceroDir = join(home, ".cicero");
      const voiceDir = join(ciceroDir, "voices", "cloud");
      mkdirSync(voiceDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(ciceroDir, "config.yaml"), stringifyYaml({
        voice: "old-local",
        voice_ref_audio: "/stale/global.wav",
        voice_ref_text: "stale transcript",
        tts: {
          backend: "audiocpp",
          port: 8092,
          model: "pocket-tts",
          voice: "old-local",
          refAudio: "/stale/nested.wav",
        },
      }), { mode: 0o600 });
      writeFileSync(join(voiceDir, "voice.yaml"), stringifyYaml({
        name: "cloud",
        provider: "elevenlabs",
        source_clip: clip,
        voice_id: "cloud-voice-id",
        created_at: "2026-07-11T00:00:00.000Z",
      }), { mode: 0o600 });

      const result = await cli(home, "use", "cloud");
      expect(result.code).toBe(0);
      const cfg = parseYaml(await Bun.file(join(ciceroDir, "config.yaml")).text());
      expect(cfg.tts).toEqual({ backend: "elevenlabs", voice: "cloud-voice-id" });
      expect(cfg.voice).toBe("cloud");
      expect(cfg.voice_ref_audio).toBeUndefined();
      expect(cfg.voice_ref_text).toBeUndefined();
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("switching voices on one provider preserves transport and model tuning", async () => {
    try {
      const ciceroDir = join(home, ".cicero");
      const voiceDir = join(ciceroDir, "voices", "clone");
      mkdirSync(voiceDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(ciceroDir, "config.yaml"), stringifyYaml({
        voice: "anna",
        voice_ref_audio: "/stale/anna.wav",
        voice_ref_text: "old transcript",
        tts: {
          backend: "pocket-tts",
          host: "voice-box.local",
          port: 8095,
          model: "custom-pocket",
          voice: "anna",
          refAudio: "/stale/anna.wav",
          refText: "old transcript",
        },
        tts_fallback: { backend: "kokoro", port: 8082, voice: "af_heart" },
      }), { mode: 0o600 });
      writeFileSync(join(voiceDir, "voice.yaml"), stringifyYaml({
        name: "clone",
        provider: "pocket-tts",
        source_clip: clip,
        trimmed_clip: clip,
        created_at: "2026-07-11T00:00:00.000Z",
      }), { mode: 0o600 });

      const result = await cli(home, "use", "clone");
      expect(result.code).toBe(0);
      const cfg = parseYaml(await Bun.file(join(ciceroDir, "config.yaml")).text());
      expect(cfg.tts).toEqual({
        backend: "pocket-tts",
        host: "voice-box.local",
        port: 8095,
        model: "custom-pocket",
        voice: "clone",
        refAudio: clip,
      });
      expect(cfg.voice_ref_audio).toBe(clip);
      expect(cfg.voice_ref_text).toBeUndefined();
      expect(cfg.tts_fallback).toEqual({ backend: "kokoro", port: 8082, voice: "af_heart" });
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("unsupported providers fail before provisioning", async () => {
    const { code, err } = await cli(home, "add", "future", clip, "--provider", "voxtral");
    expect(code).toBe(1);
    expect(err).toContain("unknown provider 'voxtral'");
    expect(existsSync(join(home, ".cicero", "voices", "future"))).toBe(false);
  });
});
