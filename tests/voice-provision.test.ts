import { test, expect, describe, mock, afterEach } from "bun:test";
import { provisionVoice } from "../src/voice/provision";
import { mkdtempSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWavFixture } from "./helpers/wav";

const hasFfmpeg = Bun.which("ffmpeg") !== null;
const originalFetch = globalThis.fetch;
// Restore after every test so a mocked fetch never leaks to other test files.
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ELEVENLABS_API_KEY;
});

const writeFixtureWav = (): string => writeWavFixture().path;

describe("provisionVoice", () => {
  test("vibevoice path rejects a missing clip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-test-"));
    await expect(
      provisionVoice({
        name: "jarvis",
        provider: "vibevoice",
        source_clip: "/nonexistent/clip.wav",
        targetDir: dir,
      }),
    ).rejects.toThrow(/not found/);
  });

  test.skipIf(!hasFfmpeg)("vibevoice path trims, inspects, and completes the manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-test-"));
    const clip = writeFixtureWav();
    const m = await provisionVoice({
      name: "jarvis",
      provider: "vibevoice",
      source_clip: clip,
      targetDir: dir,
      ref_text: "hello there",
    });
    expect(m.provider).toBe("vibevoice");
    expect(m.trimmed_clip).toBe(join(dir, "trimmed-16k-mono.wav"));
    expect(existsSync(m.trimmed_clip!)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(m.source_clip).mode & 0o777).toBe(0o600);
      expect(statSync(m.trimmed_clip!).mode & 0o777).toBe(0o600);
    }
    expect(m.sample_rate).toBe(16000);
    expect(m.duration_s).toBeGreaterThan(0);
    expect(m.ref_text).toBe("hello there");
    expect(m.voice_id).toBeUndefined();
    expect(m.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test.skipIf(!hasFfmpeg)("elevenlabs path POSTs to /v1/voices/add and captures voice_id", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ voice_id: "abc123" }), { status: 200 });
    }) as unknown as typeof fetch;

    const dir = mkdtempSync(join(tmpdir(), "voice-test-"));
    const clip = writeFixtureWav();
    const m = await provisionVoice({
      name: "jarvis-cloud",
      provider: "elevenlabs",
      source_clip: clip,
      targetDir: dir,
    });
    expect(capturedUrl).toContain("/v1/voices/add");
    expect(m.voice_id).toBe("abc123");
    expect(m.provider).toBe("elevenlabs");
    expect(m.trimmed_clip).toBe(join(dir, "upload-16k-mono.wav"));
    const form = capturedInit?.body;
    expect(form).toBeInstanceOf(FormData);
    const uploaded = (form as FormData).get("files");
    expect(uploaded).toBeInstanceOf(File);
    expect((uploaded as File).name).toBe("upload-16k-mono.wav");
  });

  test.skipIf(!hasFfmpeg)("elevenlabs path errors without an API key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-test-"));
    const clip = writeFixtureWav();
    await expect(
      provisionVoice({ name: "x", provider: "elevenlabs", source_clip: clip, targetDir: dir }),
    ).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });

  test.skipIf(!hasFfmpeg)("elevenlabs rejects a successful upload without a voice_id", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    globalThis.fetch = mock(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "voice-test-"));
    await expect(
      provisionVoice({
        name: "missing-id",
        provider: "elevenlabs",
        source_clip: writeFixtureWav(),
        targetDir: dir,
      }),
    ).rejects.toThrow(/without returning a voice_id/);
  });

  test("unsupported providers fail before creating derived files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-test-"));
    const clip = writeFixtureWav();
    await expect(
      provisionVoice({ name: "x", provider: "voxtral", source_clip: clip, targetDir: dir }),
    ).rejects.toThrow(/unsupported voice provider/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
