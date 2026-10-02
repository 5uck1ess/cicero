import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCloudSpeechKey, cloudSpeechBackend, CLOUD_SPEECH_KEY_VARIABLES } from "../src/backends/cloud-speech";
import { privacyChecks } from "../src/setup/privacy-checks";
import { envSecrets } from "../src/setup/server";
import { DEFAULT_CONFIG, loadConfig as loadConfigRaw, RuntimeConfig } from "../src/config";
import { collectChecks } from "../src/cli/doctor";
import { CiceroDaemon } from "../src/daemon";
import type { CiceroConfig } from "../src/types";

const KEY = "SyntheticCloudSpeechKeyForSurfaces";

afterEach(() => {
  for (const name of CLOUD_SPEECH_KEY_VARIABLES) delete process.env[name];
});

const cfg = (extra: Record<string, unknown>) => ({ brain: { backend: "ollama", mode: "subprocess" }, ...extra }) as unknown as CiceroConfig;
const names = (config: CiceroConfig) => privacyChecks(config).map((check) => check.name);

test("privacy: every cloud speech seat, fallbacks included, needs allow: [speech]", () => {
  for (const mode of ["local", "cloud"]) {
    expect(names(cfg({ privacy: { mode }, stt: { backend: "soniox" } }))).toEqual(["privacy: speech"]);
    expect(names(cfg({ privacy: { mode }, stt_fallback: { backend: "deepgram" } }))).toEqual(["privacy: speech"]);
    expect(names(cfg({ privacy: { mode }, tts_fallback: { backend: "soniox" } }))).toEqual(["privacy: speech"]);
    expect(names(cfg({ privacy: { mode, allow: ["speech"] }, stt: { backend: "soniox" }, tts: { backend: "elevenlabs" } }))).toEqual([]);
    expect(names(cfg({ privacy: { mode }, stt: { backend: "faster-whisper" }, tts: { backend: "kokoro" } }))).toEqual([]);
  }
});

test("config: a cloud recognizer takes an inline key; a local one still refuses it", () => {
  const home = mkdtempSync(join(tmpdir(), "cicero-cloud-config-"));
  writeFileSync(join(home, "config.yaml"), "stt: { backend: soniox, apiKey: inline-key, language: en }\ntts: { backend: soniox, language: uk-UA, voice: Iris }\nprivacy: { mode: local, allow: [speech] }\n");
  const loaded = loadConfigRaw({}, { home });
  expect(loaded.sttBackend.apiKey).toBe("inline-key");
  expect(loaded.ttsBackend.language).toBe("uk-UA");
  writeFileSync(join(home, "config.yaml"), "tts: { backend: soniox, language: not a tag }\n");
  expect(() => loadConfigRaw({}, { home })).toThrow(/tts\.language must be a language tag/);
});

test("setup output redacts every cloud speech key variable it might read", () => {
  const env = Object.fromEntries(CLOUD_SPEECH_KEY_VARIABLES.map((name, index) => [name, `${KEY}${index}`]));
  expect(envSecrets(env).sort()).toEqual(Object.values(env).sort());
});

test("daemon secret inventory mirrors env-resolved keys for STT and fallback seats", () => {
  process.env.SONIOX_API_KEY = `${KEY}Soniox`;
  process.env.DEEPGRAM_API_KEY = `${KEY}Deepgram`;
  process.env.GROQ_API_KEY = `${KEY}Unused`;
  const config = new RuntimeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    headless: true,
    brain: { backend: "ollama" },
    stt: { backend: "soniox" },
    stt_fallback: { backend: "deepgram", apiKey: `${KEY}Inline` },
  } as CiceroConfig);
  const daemon = new CiceroDaemon(config) as unknown as { snapshotKnownSecrets(): string[] };
  const secrets = daemon.snapshotKnownSecrets();
  expect(secrets).toContain(`${KEY}Soniox`);
  expect(secrets).toContain(`${KEY}Deepgram`);
  expect(secrets).toContain(`${KEY}Inline`);
  // A provider that is not configured contributes nothing.
  expect(secrets).not.toContain(`${KEY}Unused`);
});

test("doctor proves a cloud speech key with the free probe and never claims a local port", async () => {
  const calls: string[] = [];
  const config = new RuntimeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    headless: true,
    brain: { backend: "ollama" },
    stt: { backend: "soniox", apiKey: KEY },
    tts: { backend: "soniox" },
  } as CiceroConfig);
  const checks = await collectChecks(config, {
    env: {},
    cloudFetcher: (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  const stt = checks.find((check) => check.name === "stt (soniox)");
  const tts = checks.find((check) => check.name === "tts (soniox)");
  expect(stt).toMatchObject({ level: "ok", detail: "Soniox key accepted; audio is sent to stt-rt.soniox.com" });
  expect(tts).toMatchObject({ level: "fail", detail: expect.stringContaining("SONIOX_API_KEY is not set") });
  expect(JSON.stringify(checks)).not.toContain(KEY);
  expect(JSON.stringify(checks)).not.toContain("undefined");
  expect(calls).toEqual(["https://api.soniox.com/v1/models"]);
});

test("a key probe stays bounded when fetch ignores its abort signal", async () => {
  const hung = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const started = performance.now();
  const result = await checkCloudSpeechKey(cloudSpeechBackend("stt", "deepgram")!, KEY, { fetcher: hung, timeoutMs: 50 });
  expect(result).toEqual({ ok: false, reason: "Deepgram did not answer in time" });
  expect(performance.now() - started).toBeLessThan(1_000);
});
