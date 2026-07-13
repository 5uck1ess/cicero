import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioCppProvider } from "../src/backends/tts/audiocpp";
import { ElevenLabsProvider } from "../src/backends/tts/elevenlabs";
import { PocketTtsProvider } from "../src/backends/tts/pocket";
import type { TTSProvider, TTSProviderConfig } from "../src/backends/tts/provider";
import { VibeVoiceProvider } from "../src/backends/tts/vibevoice";
import type { VoiceManifest, VoiceProvider } from "../src/types";
import { VoiceLibrary } from "../src/voice/library";
import { SUPPORTED_VOICE_PROVIDERS } from "../src/voice/provider-contract";
import { writeWavFixture } from "./helpers/wav";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

const realFetch = globalThis.fetch;
const cleanupDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function captureFetch(): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(new Uint8Array([1, 0, 2, 0]), { status: 200 });
  }) as typeof fetch;
  return calls;
}

function makeProvider(provider: VoiceProvider, config: TTSProviderConfig): TTSProvider {
  switch (provider) {
    case "audiocpp": return new AudioCppProvider(config);
    case "pocket-tts": return new PocketTtsProvider(config);
    case "vibevoice": return new VibeVoiceProvider(config);
    case "elevenlabs": return new ElevenLabsProvider(config);
    default: {
      const exhaustive: never = provider;
      throw new Error(`uncovered provider ${String(exhaustive)}`);
    }
  }
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

for (const provider of SUPPORTED_VOICE_PROVIDERS) {
  test(`${provider}: a lane override resolves through its own provider capability`, async () => {
    const root = mkdtempSync(join(tmpdir(), `cicero-${provider}-override-`));
    cleanupDirs.push(root);
    const active = writeWavFixture();
    const alternate = writeWavFixture();
    cleanupDirs.push(active.dir, alternate.dir);
    const manifest: VoiceManifest = {
      name: "alternate",
      provider,
      source_clip: alternate.path,
      trimmed_clip: provider === "elevenlabs" ? undefined : alternate.path,
      voice_id: provider === "elevenlabs" ? "alternate-cloud-id" : undefined,
      ref_text: "alternate transcript",
      created_at: new Date(0).toISOString(),
    };
    await new VoiceLibrary(root).add(manifest);

    const calls = captureFetch();
    const tts = makeProvider(provider, {
      backend: provider,
      voice: provider === "elevenlabs" ? "configured-cloud-id" : "active",
      refAudio: active.path,
      refText: "active transcript",
      apiKey: "override-key",
      voiceLibraryRoot: root,
      referenceCacheRoot: join(root, ".audiocpp-cache"),
    });
    await tts.generateAudio("lane hello", "alternate");
    expect(calls).toHaveLength(1);

    const payload = bodyOf(calls[0]);
    switch (provider) {
      case "audiocpp":
        expect(payload.voice_ref).not.toBe(alternate.path);
        expect(payload.voice_ref).not.toBe(active.path);
        expect(readFileSync(String(payload.voice_ref))).toEqual(readFileSync(alternate.path));
        break;
      case "pocket-tts":
        expect(payload.voice).toBe(alternate.path);
        expect(payload.voice).not.toBe(active.path);
        break;
      case "vibevoice":
        expect(payload.voice).toBe("alternate");
        expect(payload.voice_path).toBe(alternate.path);
        expect(payload.ref_audio).toBeUndefined();
        expect(payload.ref_text).toBeUndefined();
        break;
      case "elevenlabs":
        expect(calls[0].url).toContain("/text-to-speech/alternate-cloud-id?");
        expect(calls[0].url).not.toContain("configured-cloud-id");
        break;
      default: {
        const exhaustive: never = provider;
        throw new Error(`uncovered provider ${String(exhaustive)}`);
      }
    }
  });
}

test("a lane override with the wrong provider fails before rendering the active voice", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-provider-mismatch-"));
  cleanupDirs.push(root);
  const active = writeWavFixture();
  const wrong = writeWavFixture();
  cleanupDirs.push(active.dir, wrong.dir);
  await new VoiceLibrary(root).add({
    name: "wrong-provider",
    provider: "pocket-tts",
    source_clip: wrong.path,
    trimmed_clip: wrong.path,
    created_at: new Date(0).toISOString(),
  });
  const calls = captureFetch();
  const tts = new AudioCppProvider({
    backend: "audiocpp",
    voice: "active",
    refAudio: active.path,
    voiceLibraryRoot: root,
    referenceCacheRoot: join(root, ".audiocpp-cache"),
  });

  await expect(tts.generateAudio("do not impersonate", "wrong-provider")).rejects.toThrow(
    /belongs to provider 'pocket-tts', not 'audiocpp'/,
  );
  expect(calls).toHaveLength(0);
});
