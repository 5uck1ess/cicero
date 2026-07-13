import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTTSProvider } from "../src/backends/registry";
import { DEFAULT_CONFIG, RuntimeConfig } from "../src/config";
import type { CiceroConfig, VoiceProvider } from "../src/types";
import { VoiceLibrary } from "../src/voice/library";
import { provisionVoice } from "../src/voice/provision";
import {
  SUPPORTED_VOICE_PROVIDERS,
  voiceProviderContract,
} from "../src/voice/provider-contract";
import { voiceToConfigFields } from "../src/voice/resolve";
import { writeWavFixture } from "./helpers/wav";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

const realFetch = globalThis.fetch;
const cleanupDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ELEVENLABS_API_KEY;
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function installProviderFetch(calls: FetchCall[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/v1/voices/add")) {
      return new Response(JSON.stringify({ voice_id: "eleven-voice-id" }), { status: 200 });
    }
    if (url.includes("api.elevenlabs.io/v1/text-to-speech/")) {
      return new Response(new Uint8Array([1, 0, 2, 0]), { status: 200 });
    }
    return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), { status: 200 });
  }) as typeof fetch;
}

function renderCall(calls: FetchCall[]): FetchCall {
  const call = calls.find(({ url }) =>
    url.includes("/v1/audio/speech") || url.includes("/v1/text-to-speech/"),
  );
  if (!call) throw new Error("expected a provider render request");
  return call;
}

function requestJson(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

test("the advertised provider set contains only complete runtime contracts", () => {
  expect(SUPPORTED_VOICE_PROVIDERS).toEqual([
    "audiocpp",
    "pocket-tts",
    "vibevoice",
    "elevenlabs",
  ]);
  for (const provider of SUPPORTED_VOICE_PROVIDERS) {
    const contract = voiceProviderContract(provider);
    expect(contract.provider).toBe(provider);
    expect(contract.ttsBackend).toBe(provider);
    expect(contract.supportsLibraryOverride).toBe(true);
  }
  expect(SUPPORTED_VOICE_PROVIDERS.map((provider) => {
    const contract = voiceProviderContract(provider);
    return [provider, contract.runtime, contract.defaultPort, contract.healthPath];
  })).toEqual([
    ["audiocpp", "local-binary", 8092, "/v1/models"],
    ["pocket-tts", "local-python", 8082, "/v1/models"],
    ["vibevoice", "local-python", 8082, "/v1/health"],
    ["elevenlabs", "cloud", null, null],
  ]);
});

test("ID and preset backends discard stale clone references from prior voice activation", () => {
  const config: CiceroConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    voice_ref_audio: "/stale/global.wav",
    voice_ref_text: "stale global transcript",
    tts: {
      backend: "elevenlabs",
      voice: "cloud-id",
      refAudio: "/stale/nested.wav",
      refText: "stale nested transcript",
    },
  };
  expect(new RuntimeConfig(config).ttsBackend).toEqual({
    backend: "elevenlabs",
    voice: "cloud-id",
  });
});

for (const provider of SUPPORTED_VOICE_PROVIDERS) {
  test.skipIf(Bun.which("ffmpeg") === null)(
    `${provider}: add -> use -> construct -> correct provider wire payload`,
    async () => {
      process.env.ELEVENLABS_API_KEY = "contract-test-key";
      const calls: FetchCall[] = [];
      installProviderFetch(calls);

      const root = mkdtempSync(join(tmpdir(), `cicero-${provider}-contract-`));
      cleanupDirs.push(root);
      const source = writeWavFixture();
      cleanupDirs.push(source.dir);
      const library = new VoiceLibrary(root);
      const name = `conformance-${provider}`;
      const manifest = await provisionVoice({
        name,
        provider,
        source_clip: source.path,
        targetDir: library.voiceDir(name),
        ref_text: "The contract fixture transcript.",
      });
      await library.add(manifest);
      expect((await library.get(name))?.provider).toBe(provider);

      const config: CiceroConfig = {
        ...structuredClone(DEFAULT_CONFIG),
        ...voiceToConfigFields(manifest),
      };
      const tts = createTTSProvider(new RuntimeConfig(config));
      expect(tts.name).toBe(voiceProviderContract(provider).ttsBackend);

      const output = new Uint8Array(await tts.generateAudio("contract hello", undefined, { speed: 1.1 }));
      expect(Array.from(output.slice(0, 4))).toEqual([0x52, 0x49, 0x46, 0x46]);
      const call = renderCall(calls);
      const payload = requestJson(call);
      assertWirePayload(provider, manifest.trimmed_clip ?? manifest.source_clip, call, payload);
    },
  );
}

function assertWirePayload(
  provider: VoiceProvider,
  reference: string,
  call: FetchCall,
  payload: Record<string, unknown>,
): void {
  expect(payload.text ?? payload.input).toBe("contract hello");
  switch (provider) {
    case "audiocpp":
      expect(call.url).toBe("http://localhost:8092/v1/audio/speech");
      expect(payload.voice_ref).not.toBe(reference);
      expect(readFileSync(String(payload.voice_ref))).toEqual(readFileSync(reference));
      expect(payload.voice).toBeUndefined();
      break;
    case "pocket-tts":
      expect(call.url).toBe("http://localhost:8082/v1/audio/speech");
      expect(payload.voice).toBe(reference);
      break;
    case "vibevoice":
      expect(call.url).toBe("http://localhost:8082/v1/audio/speech");
      expect(payload.voice_path).toBe(reference);
      expect(payload.ref_audio).toBeUndefined();
      expect(payload.ref_text).toBeUndefined();
      break;
    case "elevenlabs":
      expect(call.url).toBe(
        "https://api.elevenlabs.io/v1/text-to-speech/eleven-voice-id?output_format=pcm_24000",
      );
      expect(new Headers(call.init?.headers).get("xi-api-key")).toBe("contract-test-key");
      expect(payload.model_id).toBe("eleven_multilingual_v2");
      break;
    default: {
      const exhaustive: never = provider;
      throw new Error(`uncovered provider ${String(exhaustive)}`);
    }
  }
}
