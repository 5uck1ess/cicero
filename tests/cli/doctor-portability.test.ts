import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DEFAULT_CONFIG, RuntimeConfig } from "../../src/config";
import type { CiceroConfig } from "../../src/types";
import { audioCppLocalRuntimePaths } from "../../src/backends/tts/audiocpp";
import type {
  BoundedCommandOptions,
  BoundedCommandResult,
} from "../../src/process/bounded-command";
import {
  buildConfigCopyHint,
  buildVenvHint,
  collectChecks,
  opensslInstallHint,
  quoteDoctorPath,
} from "../../src/cli/doctor";

const realFetch = globalThis.fetch;
const realElevenLabsKey = process.env.ELEVENLABS_API_KEY;
const cleanupDirs: string[] = [];

function configWithLlm(llm: NonNullable<CiceroConfig["llm"]>): RuntimeConfig {
  return new RuntimeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    headless: true,
    llm,
  });
}

function commandResult(
  command: readonly string[],
  stdout = "",
  exitCode = 0,
): BoundedCommandResult {
  const stdoutBytes = new TextEncoder().encode(stdout).byteLength;
  return {
    command,
    exitCode,
    durationMs: 1,
    stdout: {
      text: stdout,
      receivedBytes: stdoutBytes,
      capturedBytes: stdoutBytes,
      limitBytes: 8 * 1024,
      truncated: false,
    },
    stderr: { text: "", receivedBytes: 0, capturedBytes: 0, limitBytes: 1024, truncated: false },
    combined: {
      receivedBytes: stdoutBytes,
      capturedBytes: stdoutBytes,
      limitBytes: 9 * 1024,
      truncated: false,
    },
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realElevenLabsKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = realElevenLabsKey;
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("doctor setup hints", () => {
  test("use absolute venv and manifest paths independent of cwd", () => {
    const root = join(process.cwd(), "project with spaces");
    const hint = buildVenvHint(".venv-turn", "3.11", "turn.txt", root);
    const venv = join(root, ".venv-turn");
    const manifest = join(root, "requirements", "turn.txt");

    expect(isAbsolute(venv)).toBe(true);
    expect(isAbsolute(manifest)).toBe(true);
    expect(hint).toContain(quoteDoctorPath(venv));
    expect(hint).toContain(quoteDoctorPath(manifest));
    expect(hint).not.toContain("-r requirements/turn.txt");
  });

  test("default hints still point into the project when invoked from another cwd", () => {
    const originalCwd = process.cwd();
    const root = dirname(dirname(import.meta.dir));
    try {
      process.chdir(tmpdir());
      const hint = buildVenvHint(".venv-vibevoice", "3.11", "vibevoice.txt");
      expect(hint).toContain(quoteDoctorPath(join(root, ".venv-vibevoice")));
      expect(hint).toContain(quoteDoctorPath(join(root, "requirements", "vibevoice.txt")));
      expect(buildConfigCopyHint("/tmp/config.yaml")).toContain(
        quoteDoctorPath(join(root, "config.yaml.example")),
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("quotes POSIX metacharacters and Windows paths for their native shells", () => {
    expect(quoteDoctorPath("/tmp/a path/$models", "linux")).toBe("'/tmp/a path/$models'");
    expect(quoteDoctorPath(String.raw`C:\Program Files\cicero`, "win32")).toBe(String.raw`"C:\Program Files\cicero"`);
    expect(opensslInstallHint("win32")).toBe("scoop install openssl");
    expect(opensslInstallHint("darwin")).toBe("brew install openssl");
  });

  test("reports the real Claude binary and rejects tab injection without a terminal", async () => {
    try {
      globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
      const requested: string[] = [];
      const config = new RuntimeConfig({
        ...structuredClone(DEFAULT_CONFIG),
        headless: true,
        terminal: "auto",
        brain: { ...structuredClone(DEFAULT_CONFIG.brain), backend: "claude-code", mode: "tab-inject" },
      });

      const checks = await collectChecks(config, {
        detectedTerminal: "none",
        which: (binary) => { requested.push(binary); return `/mock/${binary}`; },
      });

      expect(requested).toContain("claude");
      expect(requested).not.toContain("claude-code");
      const mode = checks.find((check) => check.name === "brain mode (tab-inject)");
      expect(mode?.level).toBe("fail");
      expect(mode?.hint).toContain("brain.mode: subprocess");
    } catch (error: unknown) {
      throw new Error(`Claude doctor contract test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });

  test("probes HTTP brains and recognizes every documented token placeholder", async () => {
    try {
      globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
      const config = new RuntimeConfig({
        ...structuredClone(DEFAULT_CONFIG),
        headless: true,
        terminal: "none",
        brain: { ...structuredClone(DEFAULT_CONFIG.brain), backend: "ollama", mode: "subprocess" },
        web_voice: {
          enabled: true,
          token: "<generate-a-secret>",
          tls: { enabled: false },
        },
      });

      const checks = await collectChecks(config, { which: (binary) => `/mock/${binary}` });
      expect(checks.find((check) => check.name === "brain (ollama)")?.level).toBe("fail");
      expect(checks.find((check) => check.name === "web_voice token")?.level).toBe("fail");
    } catch (error: unknown) {
      throw new Error(`HTTP brain/token doctor test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });

  test("reports missing OpenSSL only when automatic web TLS still needs generation", async () => {
    const home = await mkdtemp(join(tmpdir(), "cicero-doctor-tls-test-"));
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const config = new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      headless: true,
      brain: { backend: "ollama" },
      web_voice: {
        enabled: true,
        token: "doctor-test-token-long-enough",
      },
    });
    const withoutBinaries = (_binary: string): null => null;

    try {
      const missingChecks = await collectChecks(config, {
        platform: "win32",
        osRelease: "10.0.26100",
        ciceroHome: home,
        which: withoutBinaries,
      });
      const missing = missingChecks.find((check) => check.name === "web_voice TLS");
      expect(missing?.level).toBe("fail");
      expect(missing?.detail).toContain("'openssl'");
      expect(missing?.hint).toBe("scoop install openssl");

      const tlsDir = join(home, "web-voice");
      await mkdir(tlsDir);
      await Promise.all([
        writeFile(join(tlsDir, "cert.pem"), "stored certificate\n"),
        writeFile(join(tlsDir, "key.pem"), "stored private key\n"),
      ]);
      const storedChecks = await collectChecks(config, {
        platform: "win32",
        osRelease: "10.0.26100",
        ciceroHome: home,
        which: withoutBinaries,
      });
      const stored = storedChecks.find((check) => check.name === "web_voice TLS");
      expect(stored?.level).toBe("ok");
      expect(stored?.detail).toContain("generated certificate material found");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("checks configured tunnel providers through the injected binary resolver", async () => {
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const base = {
      ...structuredClone(DEFAULT_CONFIG),
      headless: true,
      brain: { backend: "ollama" as const },
      web_voice: {
        enabled: true,
        token: "doctor-test-token-long-enough",
        tls: { enabled: false },
        tunnel: { provider: "auto" as const },
      },
    };
    const requested: string[] = [];
    const found = await collectChecks(new RuntimeConfig(base), {
      platform: "linux",
      which: (binary) => {
        requested.push(binary);
        return binary === "cloudflared" ? "/usr/bin/cloudflared" : null;
      },
    });
    expect(requested).toContain("tailscale");
    expect(requested).toContain("cloudflared");
    expect(found.find((check) => check.name === "web_voice tunnel")?.level).toBe("ok");

    const missing = await collectChecks(new RuntimeConfig({
      ...base,
      web_voice: { ...base.web_voice, tunnel: { provider: "tailscale" } },
    }), { platform: "win32", which: () => null });
    expect(missing.find((check) => check.name === "web_voice tunnel")).toMatchObject({
      level: "fail",
      hint: "winget install Tailscale.Tailscale",
    });
  });

  test("requires ffmpeg when the configured TTS graph supports voice provisioning", async () => {
    try {
      globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
      const config = new RuntimeConfig({
        ...structuredClone(DEFAULT_CONFIG),
        headless: true,
        brain: { ...structuredClone(DEFAULT_CONFIG.brain), backend: "qwen", mode: "subprocess" },
        tts: { backend: "pocket-tts", host: "voice-box.internal", voice: "alba" },
      });
      const checks = await collectChecks(config, {
        which: (binary) => binary === "ffmpeg" ? null : `/mock/${binary}`,
      });

      const ffmpeg = checks.find((check) => check.name === "ffmpeg (voice provisioning)");
      expect(ffmpeg?.level).toBe("fail");
      expect(ffmpeg?.hint).toContain("brew install ffmpeg");
    } catch (error: unknown) {
      throw new Error(`voice-provisioning doctor test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });

  test("reports missing dedicated VibeVoice and Smart-Turn environments", async () => {
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    // An empty project root: the developer's real checkout may hold a legacy
    // turn-capable venv (.venv-stt qualifies), which downgrades the missing-env
    // "fail" to a deprecation "warn" and makes the test probe the host machine.
    const emptyRoot = await mkdtemp(join(tmpdir(), "cicero-doctor-envs-test-"));
    const config = new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      headless: true,
      brain: { backend: "ollama" },
      tts: { backend: "vibevoice", port: 18082 },
      turn: { enabled: true, backend: "smart-turn", port: 18087 },
    });

    try {
      const checks = await collectChecks(config, { projectRoot: emptyRoot });
      const vibevoice = checks.find((check) => check.name === "tts (vibevoice)");
      const turn = checks.find((check) => check.name === "turn (smart-turn)");
      expect(vibevoice?.level).toBe("fail");
      expect(vibevoice?.hint).toContain("requirements/vibevoice.txt");
      expect(turn?.level).toBe("fail");
      expect(turn?.hint).toContain("requirements/turn.txt");
    } catch (err: unknown) {
      throw new Error("doctor failed while checking isolated Python environments", { cause: err });
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  test("warns once per platform-impossible implicit MLX default off macOS", async () => {
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const config = new RuntimeConfig(structuredClone(DEFAULT_CONFIG));

    try {
      const checks = await collectChecks(config, { platform: "linux", osRelease: "6.8.0" });
      for (const name of ["stt (mlx-whisper)", "tts (mlx-audio)"]) {
        const check = checks.find((candidate) => candidate.name === name);
        expect(check?.level).toBe("warn");
        expect(check?.detail).toContain(`implicit ${name.startsWith("stt") ? "stt.backend='mlx-whisper'" : "tts.backend='mlx-audio'"}`);
        expect(check?.detail).toContain("require macOS 14 or newer");
        expect(check?.hint).toContain("valid values for");
      }
      const llm = checks.find((candidate) => candidate.name === "llm (mlx-lm)");
      expect(llm?.level).toBe("warn");
      expect(llm?.detail).toContain("implicit mlx-lm default is unavailable");
      expect(llm?.hint).toContain("configure an explicit non-MLX/remote llm backend");
    } catch (err: unknown) {
      throw new Error("doctor failed while checking resolved default backends", { cause: err });
    }
  });

  test("rejects an explicitly configured local MLX LLM off macOS", async () => {
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const config = new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      llm: { backend: "mlx-lm", port: 18081 },
    });

    try {
      const checks = await collectChecks(config, { platform: "linux", osRelease: "6.8.0" });
      const llm = checks.find((candidate) => candidate.name === "llm (mlx-lm)");
      expect(llm?.level).toBe("fail");
      expect(llm?.detail).toContain("require macOS 14 or newer");
    } catch (err: unknown) {
      throw new Error("doctor failed while checking an explicit MLX LLM", { cause: err });
    }
  });

  test("reports unsupported STT and TTS values with exact config keys and implemented choices", async () => {
    try {
      globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
      const config = new RuntimeConfig({
        ...structuredClone(DEFAULT_CONFIG),
        stt: { backend: "faster-whispr" },
        tts: { backend: "pocket-ttz" },
        brain: { backend: "ollama" },
      });

      const checks = await collectChecks(config);
      const stt = checks.find((candidate) => candidate.name === "stt (faster-whispr)");
      const tts = checks.find((candidate) => candidate.name === "tts (pocket-ttz)");

      expect(stt?.level).toBe("fail");
      expect(stt?.detail).toContain("stt.backend='faster-whispr'");
      expect(stt?.hint).toContain(
        "valid values for stt.backend: mlx-whisper, faster-whisper, audiocpp, wyoming",
      );
      expect(stt?.hint).not.toContain("deepgram");
      expect(tts?.level).toBe("fail");
      expect(tts?.detail).toContain("tts.backend='pocket-ttz'");
      expect(tts?.hint).toContain("valid values for tts.backend:");
      expect(tts?.hint).toContain("pocket-tts");
      expect(tts?.hint).not.toContain("voxtral");
    } catch (error) {
      throw new Error(`unsupported backend doctor test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });

  test("verifies Ollama reachability and the configured model without a false green", async () => {
    let advertisedModels = ["qwen3.5:4b"];
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === "http://127.0.0.1:11434/api/tags") {
        return Promise.resolve(new Response(JSON.stringify({
          models: advertisedModels.map((name) => ({ name })),
        }), { status: 200 }));
      }
      return Promise.resolve(new Response("down", { status: 503 }));
    }) as typeof fetch;
    const config = configWithLlm({
      backend: "ollama",
      model: "  qwen3.5:4b  ",
    });

    try {
      const ready = await collectChecks(config, {
        env: {},
        which: (binary) => binary === "ollama" ? "/mock/bin/ollama" : null,
      });
      expect(ready.find((check) => check.name === "llm (ollama)")).toEqual({
        name: "llm (ollama)",
        level: "ok",
        detail: "local Ollama is healthy; model 'qwen3.5:4b' is installed and CLI is at /mock/bin/ollama",
      });

      advertisedModels = [];
      const missingModel = await collectChecks(config, {
        env: {},
        which: (binary) => binary === "ollama" ? "/mock/bin/ollama" : null,
      });
      const llm = missingModel.find((check) => check.name === "llm (ollama)");
      expect(llm?.level).toBe("fail");
      expect(llm?.detail).toContain("model 'qwen3.5:4b' is not installed");
      expect(llm?.hint).toContain("ollama pull qwen3.5:4b");
      expect(llm?.detail).not.toContain("venv");
      expect(llm?.detail).not.toContain("undefined");
      expect(urls).toContain("http://127.0.0.1:11434/api/tags");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("requires llama-server and a launchable local model while allowing a stopped managed server", async () => {
    const root = mkdtempSync(join(tmpdir(), "cicero-doctor-llama-cpp-"));
    cleanupDirs.push(root);
    const model = join(root, "router.gguf");
    writeFileSync(model, "fixture");
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(new Response("down", { status: 503 }));
    }) as typeof fetch;

    try {
      const ready = await collectChecks(configWithLlm({
        backend: "llama-cpp",
        port: 18080,
        model: `  ${model}  `,
      }), {
        env: {},
        which: (binary) => binary === "llama-server" ? "/mock/bin/llama-server" : null,
      });
      const llmReady = ready.find((check) => check.name === "llm (llama-cpp)");
      expect(llmReady?.level).toBe("ok");
      expect(llmReady?.detail).toContain("Cicero will launch it on :18080");
      expect(urls).toContain("http://127.0.0.1:18080/health");

      const missing = await collectChecks(configWithLlm({
        backend: "llama-cpp",
        port: 18081,
        model: join(root, "missing.gguf"),
      }), { env: {}, which: () => null });
      const llmMissing = missing.find((check) => check.name === "llm (llama-cpp)");
      expect(llmMissing?.level).toBe("fail");
      expect(llmMissing?.detail).toContain("'llama-server' is not on PATH");
      expect(llmMissing?.detail).toContain("GGUF model file does not exist");
      expect(llmMissing?.detail).not.toContain("venv");
      expect(llmMissing?.detail).not.toContain("undefined");

      const directoryModel = join(root, "directory.gguf");
      mkdirSync(directoryModel);
      const invalidPath = await collectChecks(configWithLlm({
        backend: "llama-cpp",
        model: directoryModel,
      }), {
        env: {},
        which: (binary) => binary === "llama-server" ? "/mock/bin/llama-server" : null,
      });
      expect(invalidPath.find((check) => check.name === "llm (llama-cpp)")?.detail)
        .toContain("GGUF model path is not a regular file");

      const invalidRepo = await collectChecks(configWithLlm({
        backend: "llama-cpp",
        model: "not-a-repository",
      }), {
        env: {},
        which: (binary) => binary === "llama-server" ? "/mock/bin/llama-server" : null,
      });
      expect(invalidRepo.find((check) => check.name === "llm (llama-cpp)")?.detail)
        .toContain("expected owner/repo[:quant]");

      for (const model of ["owner/repo-", "owner/repo..name", "owner/repo--name"]) {
        const invalid = await collectChecks(configWithLlm({
          backend: "llama-cpp",
          model,
        }), {
          env: {},
          which: (binary) => binary === "llama-server" ? "/mock/bin/llama-server" : null,
        });
        expect(invalid.find((check) => check.name === "llm (llama-cpp)")?.detail)
          .toContain("expected owner/repo[:quant]");
      }
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("checks OpenAI preset credentials before probing and authenticates the real models endpoint", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      return Promise.resolve(new Response(url.includes("openrouter.ai") ? "ok" : "down", {
        status: url.includes("openrouter.ai") ? 200 : 503,
      }));
    }) as typeof fetch;
    const config = configWithLlm({
      backend: "openrouter",
      model: "provider/model",
    });

    try {
      const missing = await collectChecks(config, { env: {}, which: () => null });
      const missingKey = missing.find((check) => check.name === "llm (openrouter)");
      expect(missingKey?.level).toBe("fail");
      expect(missingKey?.detail).toContain("OPENROUTER_API_KEY is not set");
      expect(calls.some((call) => call.url.includes("openrouter.ai"))).toBe(false);

      const ready = await collectChecks(config, {
        env: { OPENROUTER_API_KEY: "doctor-secret" },
        which: () => null,
      });
      expect(ready.find((check) => check.name === "llm (openrouter)")).toEqual({
        name: "llm (openrouter)",
        level: "ok",
        detail: "openrouter endpoint https://openrouter.ai/api/v1/models is reachable; model 'provider/model' configured",
      });
      const request = calls.find((call) => call.url.includes("openrouter.ai"));
      expect(request?.url).toBe("https://openrouter.ai/api/v1/models");
      expect(request?.headers.get("Authorization")).toBe("Bearer doctor-secret");

      const explicit = await collectChecks(configWithLlm({
        backend: "openrouter",
        apiKey: "configured-secret",
      }), {
        env: { OPENROUTER_API_KEY: "environment-secret" },
        which: () => null,
      });
      expect(explicit.find((check) => check.name === "llm (openrouter)")?.level).toBe("ok");
      expect(calls.at(-1)?.headers.get("Authorization")).toBe("Bearer configured-secret");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("allows keyless private OpenAI-compatible endpoints and forwards configured headers", async () => {
    let requestHeaders = new Headers();
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "http://192.168.50.8:9000/v1/models") {
        requestHeaders = new Headers(init?.headers);
        return Promise.resolve(new Response("ok", { status: 200 }));
      }
      return Promise.resolve(new Response("down", { status: 503 }));
    }) as typeof fetch;
    const config = configWithLlm({
      backend: "openai-compatible",
      baseUrl: "http://192.168.50.8:9000/v1",
      model: "hermes-local",
      extraHeaders: { "X-Doctor-Test": "present" },
    });

    try {
      const checks = await collectChecks(config, { env: {}, which: () => null });
      expect(checks.find((check) => check.name === "llm (openai-compatible)")?.level).toBe("ok");
      expect(requestHeaders.get("Authorization")).toBeNull();
      expect(requestHeaders.get("X-Doctor-Test")).toBe("present");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("never prints credentials from malformed or unsupported OpenAI-compatible base URLs", async () => {
    const requested: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      requested.push(String(input));
      return Promise.resolve(new Response("down", { status: 503 }));
    }) as typeof fetch;

    const cases = [
      {
        baseUrl: "https://doctor-user:url-password-secret@example.com/v1",
        omitted: ["doctor-user", "url-password-secret"],
        expected: "embeds URL credentials",
      },
      {
        baseUrl: "https://example.com/v1?api_key=query-secret#fragment-secret",
        omitted: ["api_key", "query-secret", "fragment-secret"],
        expected: "contains a query string or fragment",
      },
      {
        baseUrl: "not a URL malformed-secret",
        omitted: ["malformed-secret"],
        expected: "base URL is invalid",
      },
    ] as const;

    try {
      for (const testCase of cases) {
        const checks = await collectChecks(configWithLlm({
          backend: "openai-compatible",
          baseUrl: testCase.baseUrl,
          apiKey: "header-secret",
        }), { env: {}, which: () => null });
        const llm = checks.find((check) => check.name === "llm (openai-compatible)");
        expect(llm?.level).toBe("fail");
        expect(llm?.detail).toContain(testCase.expected);
        for (const secret of [...testCase.omitted, "header-secret"]) {
          expect(llm?.detail).not.toContain(secret);
          expect(llm?.hint).not.toContain(secret);
        }
      }
      expect(requested.some((url) => (
        url.includes("url-password-secret")
        || url.includes("query-secret")
        || url.includes("malformed-secret")
      ))).toBe(false);
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("bounds OpenAI-compatible diagnostics even when fetch ignores abort", async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      if (String(input).includes("openrouter.ai")) return new Promise<Response>(() => {});
      return Promise.resolve(new Response("down", { status: 503 }));
    }) as typeof fetch;
    const started = performance.now();

    try {
      const checks = await collectChecks(configWithLlm({ backend: "openrouter" }), {
        cloudProbeTimeoutMs: 25,
        env: { OPENROUTER_API_KEY: "doctor-secret" },
        which: () => null,
      });
      expect(performance.now() - started).toBeLessThan(500);
      const llm = checks.find((check) => check.name === "llm (openrouter)");
      expect(llm?.level).toBe("fail");
      expect(llm?.detail).toContain("https://openrouter.ai/api/v1/models is not responding");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("reports unsupported LLM backends instead of claiming a generic runtime is ready", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("down", { status: 503 }))) as typeof fetch;

    try {
      const checks = await collectChecks(configWithLlm({ backend: "ollamaa" }), {
        env: {},
        which: () => null,
      });
      const llm = checks.find((check) => check.name === "llm (ollamaa)");
      expect(llm?.level).toBe("fail");
      expect(llm?.detail).toContain("llm.backend='ollamaa'");
      expect(llm?.hint).toContain("valid values for llm.backend");
      expect(llm?.detail).not.toContain("venv");
      expect(llm?.detail).not.toContain("undefined");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("fails ElevenLabs explicitly when its API key is missing", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    globalThis.fetch = (() => Promise.resolve(new Response("down", { status: 503 }))) as typeof fetch;
    const config = new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      headless: true,
      brain: { backend: "ollama" },
      tts: { backend: "elevenlabs", voice: "cloud-id" },
    });

    try {
      const checks = await collectChecks(config);
      const tts = checks.find((check) => check.name === "tts (elevenlabs)");
      expect(tts?.level).toBe("fail");
      expect(tts?.detail).toContain("ELEVENLABS_API_KEY is not set");
      expect(tts?.detail).not.toContain("venv");
      expect(tts?.detail).not.toContain("undefined");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("verifies a configured ElevenLabs cloud voice instead of claiming a local daemon", async () => {
    process.env.ELEVENLABS_API_KEY = "doctor-key";
    const calls: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as typeof fetch;
    const config = new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      headless: true,
      brain: { backend: "ollama" },
      tts: { backend: "elevenlabs", voice: "voice/id" },
    });

    try {
      const checks = await collectChecks(config);
      const tts = checks.find((check) => check.name === "tts (elevenlabs)");
      expect(tts).toEqual({
        name: "tts (elevenlabs)",
        level: "ok",
        detail: "cloud voice 'voice/id' is reachable",
      });
      const cloudCall = calls.find((call) => call.url.includes("api.elevenlabs.io"));
      expect(cloudCall?.url).toContain("/voices/voice%2Fid");
      expect(cloudCall?.headers.get("xi-api-key")).toBe("doctor-key");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("bounds an ElevenLabs doctor probe even when fetch ignores abort", async () => {
    process.env.ELEVENLABS_API_KEY = "doctor-key";
    globalThis.fetch = ((input: RequestInfo | URL) => {
      if (String(input).includes("api.elevenlabs.io")) return new Promise<Response>(() => {});
      return Promise.resolve(new Response("down", { status: 503 }));
    }) as typeof fetch;
    const config = new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      headless: true,
      brain: { backend: "ollama" },
      tts: { backend: "elevenlabs", voice: "cloud-id" },
    });
    const started = performance.now();

    try {
      const checks = await collectChecks(config, { cloudProbeTimeoutMs: 25 });
      const elapsed = performance.now() - started;
      const tts = checks.find((check) => check.name === "tts (elevenlabs)");
      expect(elapsed).toBeLessThan(500);
      expect(tts?.level).toBe("fail");
      expect(tts?.detail).toContain("could not be verified");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("uses audio.cpp's default port and fails when its local binary contract is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "cicero-doctor-audiocpp-missing-"));
    cleanupDirs.push(root);
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(new Response("down", { status: 503 }));
    }) as typeof fetch;
    const config = new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      headless: true,
      brain: { backend: "ollama" },
      tts: { backend: "audiocpp", voice: "operator" },
    });

    try {
      const checks = await collectChecks(config, { projectRoot: root });
      const tts = checks.find((check) => check.name === "tts (audiocpp)");
      expect(tts?.level).toBe("fail");
      expect(tts?.detail).toContain("local audio.cpp runtime is incomplete");
      expect(tts?.detail).not.toContain("venv");
      expect(tts?.detail).not.toContain("undefined");
      expect(urls).toContain("http://127.0.0.1:8092/v1/models");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("checks audio.cpp STT fallback with its real default port, health path, and binary contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "cicero-doctor-stt-audiocpp-missing-"));
    cleanupDirs.push(root);
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(new Response("down", { status: 503 }));
    }) as typeof fetch;
    const config = new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      headless: true,
      brain: { backend: "ollama" },
      stt: { backend: "faster-whisper", host: "gpu.internal", port: 18083 },
      stt_fallback: { backend: "audiocpp" },
    });

    try {
      const checks = await collectChecks(config, { projectRoot: root });
      const fallback = checks.find((check) => check.name === "stt_fallback (audiocpp)");
      expect(fallback?.level).toBe("fail");
      expect(fallback?.detail).toContain("local audio.cpp runtime is incomplete");
      expect(fallback?.detail).not.toContain("venv");
      expect(fallback?.detail).not.toContain("undefined");
      expect(urls).toContain("http://127.0.0.1:8092/v1/models");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("probes a remote MLX STT fallback on the provider's real root health route", async () => {
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(new Response('{"status":"ok"}', { status: 200 }));
    }) as typeof fetch;
    const config = new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      headless: true,
      brain: { backend: "ollama" },
      stt: { backend: "faster-whisper", host: "gpu-a.internal", port: 18083 },
      stt_fallback: { backend: "mlx-whisper", host: "gpu-b.internal" },
    });

    try {
      const checks = await collectChecks(config);
      const fallback = checks.find((check) => check.name === "stt_fallback (mlx-whisper)");
      expect(fallback?.level).toBe("ok");
      expect(urls).toContain("http://gpu-b.internal:8083/");
      expect(urls).not.toContain("http://gpu-b.internal:8083/health");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("reports Wyoming fallback diagnostics honestly without pretending it has an HTTP health route", async () => {
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(new Response('{"status":"ok"}', { status: 200 }));
    }) as typeof fetch;
    const config = new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      headless: true,
      brain: { backend: "ollama" },
      stt: { backend: "faster-whisper", host: "gpu-a.internal", port: 18083 },
      stt_fallback: { backend: "wyoming", host: "2001:db8::5" },
    });

    try {
      const checks = await collectChecks(config);
      const fallback = checks.find((check) => check.name === "stt_fallback (wyoming)");
      expect(fallback?.level).toBe("warn");
      expect(fallback?.detail).toContain("[2001:db8::5]:10300");
      expect(fallback?.detail).toContain("not HTTP-probed");
      expect(urls.some((url) => url.includes("2001:db8::5"))).toBe(false);
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("reports TTS Wyoming on its native default port instead of inventing a local daemon", async () => {
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(new Response('{"status":"ok"}', { status: 200 }));
    }) as typeof fetch;
    const config = new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      headless: true,
      brain: { backend: "ollama" },
      tts: { backend: "wyoming", host: "speech.internal" },
    });

    try {
      const checks = await collectChecks(config);
      const tts = checks.find((check) => check.name === "tts (wyoming)");
      expect(tts?.level).toBe("warn");
      expect(tts?.detail).toContain("tts.backend='wyoming'");
      expect(tts?.detail).toContain("speech.internal:10200");
      expect(tts?.detail).toContain("not HTTP-probed");
      expect(urls.some((url) => url.includes("speech.internal"))).toBe(false);
    } catch (error) {
      throw new Error(`TTS Wyoming doctor test failed: ${(error as Error).message}`, { cause: error });
    }
  });

  test("recognizes a complete local audio.cpp runtime at its provider default", async () => {
    const root = mkdtempSync(join(tmpdir(), "cicero-doctor-audiocpp-ready-"));
    cleanupDirs.push(root);
    const runtime = audioCppLocalRuntimePaths(root);
    mkdirSync(dirname(runtime.binary), { recursive: true });
    mkdirSync(dirname(runtime.serverConfig), { recursive: true });
    writeFileSync(runtime.binary, "fixture");
    writeFileSync(runtime.serverConfig, "{}");
    globalThis.fetch = (() => Promise.resolve(new Response("down", { status: 503 }))) as typeof fetch;
    const config = new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      headless: true,
      brain: { backend: "ollama" },
      tts: { backend: "audiocpp", voice: "operator" },
    });

    try {
      const checks = await collectChecks(config, { projectRoot: root });
      const tts = checks.find((check) => check.name === "tts (audiocpp)");
      expect(tts?.level).toBe("ok");
      expect(tts?.detail).toContain("daemon will launch it on :8092");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("runs nvidia-smi with a bounded diagnostic contract", async () => {
    const config = new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      headless: true,
      brain: { backend: "ollama" },
    });
    let command: readonly string[] = [];
    let commandOptions: BoundedCommandOptions | undefined;

    const checks = await collectChecks(config, {
      platform: "linux",
      osRelease: "6.8.0",
      which: (binary) => binary === "nvidia-smi" ? "/fixture/nvidia-smi" : null,
      runCommand: async (nextCommand, nextOptions) => {
        command = nextCommand;
        commandOptions = nextOptions;
        return commandResult(nextCommand, "Fixture GPU, 8192 MiB\n");
      },
    });

    expect(command).toEqual([
      "/fixture/nvidia-smi",
      "--query-gpu=name,memory.free",
      "--format=csv,noheader",
    ]);
    expect(commandOptions?.timeoutMs).toBe(3_000);
    expect(commandOptions?.stdoutLimitBytes).toBe(8 * 1024);
    expect(commandOptions?.outputLimitBehavior).toBe("error");
    expect(checks.find((check) => check.name === "gpu")).toEqual({
      name: "gpu",
      level: "ok",
      detail: "Fixture GPU, 8192 MiB",
    });
  });

  test("bounds Python import probes and uses the requested project root", async () => {
    const root = mkdtempSync(join(tmpdir(), "cicero-doctor-import-"));
    cleanupDirs.push(root);
    const python = join(root, ".venv-vibevoice", "bin", "python");
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, "fixture");
    globalThis.fetch = (() => Promise.resolve(new Response("down", { status: 503 }))) as typeof fetch;
    const config = new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      headless: true,
      brain: { backend: "ollama" },
      tts: { backend: "vibevoice", port: 18082 },
    });
    let command: readonly string[] = [];
    let commandOptions: BoundedCommandOptions | undefined;

    const checks = await collectChecks(config, {
      platform: "linux",
      osRelease: "6.8.0",
      projectRoot: root,
      ciceroHome: join(root, "state"),
      which: () => null,
      runCommand: async (nextCommand, nextOptions) => {
        command = nextCommand;
        commandOptions = nextOptions;
        return commandResult(nextCommand, "", 1);
      },
    });

    expect(command[0]).toBe(python);
    expect(command).toContain("vibevoice_api.server");
    expect(commandOptions?.timeoutMs).toBe(10_000);
    expect(commandOptions?.stdoutLimitBytes).toBe(0);
    expect(commandOptions?.stderrLimitBytes).toBe(0);
    const tts = checks.find((check) => check.name === "tts (vibevoice)");
    expect(tts?.level).toBe("fail");
    expect(tts?.detail).toContain("cannot import");
    expect(tts?.hint).toContain(root);
    expect(checks.find((check) => check.name === "config")?.hint).toContain(join(root, "config.yaml.example"));
  });
});
