import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, RuntimeConfig } from "../../src/config";
import type { CiceroConfig, TerminalAdapter } from "../../src/types";
import {
  collectStatus,
  renderStatus,
  type StatusProbeRequest,
} from "../../src/cli/status";

function runtimeConfig(change: (raw: CiceroConfig) => void): RuntimeConfig {
  const raw = structuredClone(DEFAULT_CONFIG);
  change(raw);
  return new RuntimeConfig(raw);
}

function healthyTerminal(titles: string[]): TerminalAdapter {
  return {
    listTabs: () => Promise.resolve(titles.map((title, index) => ({
      id: String(index + 1),
      title,
      is_focused: index === 0,
    }))),
    focusTab: () => Promise.resolve(),
    sendText: () => Promise.resolve(),
    sendKey: () => Promise.resolve(),
    getText: () => Promise.resolve(""),
    spawnTab: (options) => Promise.resolve({ id: "new", title: options.title, is_focused: false }),
    closeTab: () => Promise.resolve(),
    health: () => Promise.resolve({ ok: true }),
  };
}

describe("configured CLI status", () => {
  test("renders published pairing state without ever surfacing a credential", async () => {
    const config = runtimeConfig((raw) => {
      raw.headless = true;
      raw.brain = { backend: "acp", mode: "subprocess", binary: "hermes" };
    });
    const lines = await collectStatus(config, {
      inspectDaemon: () => Promise.resolve({ kind: "absent" }),
      probe: () => Promise.resolve(true),
      which: () => "/mock/binary",
      readPairingState: () => ({
        scheme: "https",
        port: 8090,
        lanHost: "192.168.1.20",
        tunnelProvider: "cloudflared",
        tunnelUrl: "https://random.trycloudflare.com",
        startedAt: "2026-07-18T12:00:00.000Z",
        pid: 55,
      }),
    });
    const output = renderStatus(lines);
    expect(lines.find((line) => line.name === "Phone pairing")).toEqual({
      name: "Phone pairing",
      level: "ok",
      detail: "cloudflared tunnel · URL published",
    });
    expect(output).not.toContain("token");
    expect(output).not.toContain("random.trycloudflare.com");
  });

  test("omits phone pairing status when no live state is published", async () => {
    const config = runtimeConfig((raw) => {
      raw.headless = true;
      raw.brain = { backend: "acp", mode: "subprocess", binary: "hermes" };
    });
    const lines = await collectStatus(config, {
      inspectDaemon: () => Promise.resolve({ kind: "absent" }),
      probe: () => Promise.resolve(true),
      which: () => "/mock/binary",
      readPairingState: () => null,
    });
    expect(lines.some((line) => line.name === "Phone pairing")).toBe(false);
  });

  test("reports resolved remote backends and skips irrelevant terminal and hotkey checks", async () => {
    const config = runtimeConfig((raw) => {
      raw.headless = true;
      raw.terminal = "kitty";
      raw.stt = {
        backend: "faster-whisper",
        host: "gpu.example.test",
        port: 9101,
        model: "large-v3-turbo",
      };
      raw.stt_fallback = {
        backend: "wyoming",
        host: "192.168.50.20",
        port: 10300,
        model: "fallback-whisper",
      };
      raw.tts = {
        backend: "audiocpp",
        host: "voice.example.test",
        port: 9102,
        model: "qwen3-tts",
      };
      raw.llm = {
        backend: "openai-compatible",
        baseUrl: "http://192.168.50.8:9103/v1",
        model: "hermes-local",
      };
      raw.brain = {
        ...raw.brain,
        backend: "acp",
        mode: "subprocess",
        binary: "ssh",
        binary_args: ["gpu-box", "hermes", "acp"],
      };
    });
    const requests: StatusProbeRequest[] = [];
    let fileChecks = 0;
    let terminalCreates = 0;

    const lines = await collectStatus(config, {
      platform: "darwin",
      inspectDaemon: () => Promise.resolve({ kind: "absent" }),
      probe: (request) => {
        requests.push(request);
        return Promise.resolve(true);
      },
      which: (binary) => binary === "ssh" ? "/usr/bin/ssh" : null,
      isExecutable: () => {
        fileChecks += 1;
        return Promise.resolve(false);
      },
      createTerminal: () => {
        terminalCreates += 1;
        return healthyTerminal([]);
      },
    });

    expect(lines.map((line) => line.name)).toEqual([
      "Daemon",
      "STT",
      "STT fallback",
      "TTS",
      "LLM",
      "Brain",
    ]);
    expect(lines.find((line) => line.name === "STT")?.detail).toContain(
      "faster-whisper @ http://gpu.example.test:9101/health",
    );
    expect(lines.find((line) => line.name === "STT fallback")).toMatchObject({
      level: "info",
    });
    expect(lines.find((line) => line.name === "STT fallback")?.detail).toContain(
      "wyoming://192.168.50.20:10300",
    );
    expect(lines.find((line) => line.name === "TTS")?.detail).toContain(
      "audiocpp @ http://voice.example.test:9102/v1/models",
    );
    expect(lines.find((line) => line.name === "LLM")?.detail).toContain(
      "openai-compatible @ http://192.168.50.8:9103/v1/models",
    );
    expect(lines.find((line) => line.name === "Brain")?.detail).toBe(
      "acp ACP stdio via /usr/bin/ssh · 3 configured args",
    );
    expect(requests.map((request) => request.url).sort()).toEqual([
      "http://192.168.50.8:9103/v1/models",
      "http://gpu.example.test:9101/health",
      "http://voice.example.test:9102/v1/models",
    ].sort());
    expect(fileChecks).toBe(0);
    expect(terminalCreates).toBe(0);
  });

  test("checks terminal, target tab, and hotkey only for an interactive tab brain", async () => {
    const config = runtimeConfig((raw) => {
      raw.headless = false;
      raw.terminal = "tmux";
      raw.brain = {
        ...raw.brain,
        backend: "claude-code",
        mode: "tab-inject",
        target_tab: "Hermes Brain",
      };
    });
    let terminalCreates = 0;
    let hotkeyChecks = 0;

    const lines = await collectStatus(config, {
      platform: "darwin",
      inspectDaemon: () => Promise.resolve({ kind: "absent" }),
      probe: () => Promise.resolve(true),
      isExecutable: () => {
        hotkeyChecks += 1;
        return Promise.resolve(true);
      },
      createTerminal: () => {
        terminalCreates += 1;
        return healthyTerminal(["shell", "Hermes Brain — ready"]);
      },
    });

    expect(terminalCreates).toBe(1);
    expect(hotkeyChecks).toBe(1);
    expect(lines.find((line) => line.name === "Brain")).toMatchObject({ level: "info" });
    expect(lines.find((line) => line.name === "Terminal")).toEqual({
      name: "Terminal",
      level: "ok",
      detail: "tmux available",
    });
    expect(lines.find((line) => line.name === "Brain tab")).toEqual({
      name: "Brain tab",
      level: "ok",
      detail: "\"Hermes Brain\" found",
    });
    expect(lines.find((line) => line.name === "Hotkey")).toMatchObject({ level: "ok" });
  });

  test("bounds daemon and HTTP probes even when injected implementations never settle", async () => {
    const config = runtimeConfig((raw) => {
      raw.headless = true;
      raw.brain = {
        ...raw.brain,
        backend: "acp",
        mode: "subprocess",
        binary: "hermes",
      };
    });
    const signals: AbortSignal[] = [];
    const started = performance.now();

    const lines = await collectStatus(config, {
      timeoutMs: 20,
      inspectDaemon: () => new Promise(() => {}),
      probe: (request) => {
        signals.push(request.signal);
        return new Promise(() => {});
      },
      which: () => "/usr/local/bin/hermes",
    });

    expect(performance.now() - started).toBeLessThan(500);
    expect(lines.find((line) => line.name === "Daemon")).toMatchObject({ level: "warn" });
    expect(lines.find((line) => line.name === "STT")).toMatchObject({ level: "fail" });
    expect(lines.find((line) => line.name === "TTS")).toMatchObject({ level: "fail" });
    expect(lines.find((line) => line.name === "LLM")).toMatchObject({ level: "fail" });
    expect(signals.length).toBe(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  test("bounds terminal adapter calls and does not list tabs after a health timeout", async () => {
    const config = runtimeConfig((raw) => {
      raw.headless = true;
      raw.terminal = "kitty";
      raw.brain = {
        ...raw.brain,
        backend: "claude-code",
        mode: "tab-inject",
      };
    });
    let tabLists = 0;
    const hangingTerminal: TerminalAdapter = {
      ...healthyTerminal([]),
      health: () => new Promise(() => {}),
      listTabs: () => {
        tabLists += 1;
        return Promise.resolve([]);
      },
    };
    const started = performance.now();

    const lines = await collectStatus(config, {
      timeoutMs: 20,
      inspectDaemon: () => Promise.resolve({ kind: "absent" }),
      probe: () => Promise.resolve(true),
      createTerminal: () => hangingTerminal,
    });

    expect(performance.now() - started).toBeLessThan(500);
    expect(tabLists).toBe(0);
    expect(lines.find((line) => line.name === "Terminal")?.detail).toContain(
      "kitty health check timed out after 20ms",
    );
    expect(lines.find((line) => line.name === "Brain tab")?.detail).toContain(
      "not checked",
    );
  });

  test("does not probe or require credentials for disabled TTS", async () => {
    const config = runtimeConfig((raw) => {
      raw.headless = true;
      raw.tts_enabled = false;
      raw.tts = { backend: "elevenlabs", voice: "voice-123" };
      raw.brain = {
        ...raw.brain,
        backend: "acp",
        mode: "subprocess",
      };
    });
    const urls: string[] = [];

    const lines = await collectStatus(config, {
      env: {},
      inspectDaemon: () => Promise.resolve({ kind: "absent" }),
      probe: (request) => {
        urls.push(request.url);
        return Promise.resolve(true);
      },
      which: () => "/usr/bin/hermes",
    });

    expect(urls.some((url) => url.includes("elevenlabs"))).toBe(false);
    expect(lines.find((line) => line.name === "TTS")).toEqual({
      name: "TTS",
      level: "info",
      detail: "elevenlabs @ https://api.elevenlabs.io/v1/voices/voice-123 · disabled; health probe skipped",
    });
  });

  test("never prints credentials embedded in a configured endpoint", async () => {
    const config = runtimeConfig((raw) => {
      raw.headless = true;
      raw.llm = {
        backend: "openai-compatible",
        baseUrl: "https://operator:super-secret@api.example.test/v1",
        model: "remote",
        apiKey: "separate-secret",
      };
      raw.brain = { ...raw.brain, backend: "acp", mode: "subprocess" };
    });

    const lines = await collectStatus(config, {
      inspectDaemon: () => Promise.resolve({ kind: "absent" }),
      probe: () => Promise.resolve(true),
      which: () => "/usr/bin/hermes",
    });
    const rendered = renderStatus(lines);

    expect(rendered).toContain("https://api.example.test/v1/models");
    expect(rendered).not.toContain("operator");
    expect(rendered).not.toContain("super-secret");
    expect(rendered).not.toContain("separate-secret");
  });

  test("redacts query credentials from configured endpoints", async () => {
    const config = runtimeConfig((raw) => {
      raw.headless = true;
      raw.llm = {
        backend: "openai-compatible",
        baseUrl: "https://api.example.test/v1?api_key=query-secret",
        model: "remote",
        apiKey: "header-secret",
      };
      raw.brain = { ...raw.brain, backend: "acp", mode: "subprocess" };
    });

    const lines = await collectStatus(config, {
      inspectDaemon: () => Promise.resolve({ kind: "absent" }),
      probe: () => Promise.resolve(true),
      which: () => "/usr/bin/hermes",
    });
    const rendered = renderStatus(lines);

    expect(rendered).toContain("https://api.example.test/v1");
    expect(rendered).not.toContain("api_key");
    expect(rendered).not.toContain("query-secret");
    expect(rendered).not.toContain("header-secret");
  });

  test("fails closed instead of echoing a malformed credential-bearing endpoint", async () => {
    const config = runtimeConfig((raw) => {
      raw.headless = true;
      raw.llm = {
        backend: "openai-compatible",
        baseUrl: "https://operator:sup er-secret@api.example .test/v1",
        model: "remote",
        apiKey: "header-secret",
      };
      raw.brain = { ...raw.brain, backend: "acp", mode: "subprocess" };
    });

    const lines = await collectStatus(config, {
      inspectDaemon: () => Promise.resolve({ kind: "absent" }),
      probe: () => Promise.resolve(true),
      which: () => "/usr/bin/hermes",
    });
    const rendered = renderStatus(lines);

    expect(lines.find((line) => line.name === "LLM")).toMatchObject({ level: "fail" });
    expect(rendered).toContain("<unparseable endpoint>");
    expect(rendered).not.toContain("operator");
    expect(rendered).not.toContain("sup er-secret");
    expect(rendered).not.toContain("header-secret");
  });

  test("fails unsupported backends even when TTS is disabled", async () => {
    const config = runtimeConfig((raw) => {
      raw.headless = true;
      raw.tts_enabled = false;
      raw.stt = { backend: "typo-stt" };
      raw.tts = { backend: "typo-tts" };
      raw.llm = { backend: "typo-llm" };
      raw.brain = { ...raw.brain, backend: "typo-brain", mode: "subprocess" };
    });
    let probes = 0;

    const lines = await collectStatus(config, {
      inspectDaemon: () => Promise.resolve({ kind: "absent" }),
      probe: () => {
        probes += 1;
        return Promise.resolve(true);
      },
    });

    for (const name of ["STT", "TTS", "LLM", "Brain"]) {
      expect(lines.find((line) => line.name === name)?.level).toBe("fail");
      expect(lines.find((line) => line.name === name)?.detail).toContain("unsupported");
    }
    expect(probes).toBe(0);
  });

  test("does not mistake a non-executable file or cwd name for a brain binary", async () => {
    const explicit = runtimeConfig((raw) => {
      raw.headless = true;
      raw.brain = {
        ...raw.brain,
        backend: "acp",
        mode: "subprocess",
        binary: "/etc/hosts",
      };
    });
    const explicitLines = await collectStatus(explicit, {
      inspectDaemon: () => Promise.resolve({ kind: "absent" }),
      probe: () => Promise.resolve(true),
      which: () => null,
    });
    expect(explicitLines.find((line) => line.name === "Brain")).toMatchObject({ level: "fail" });
    expect(explicitLines.find((line) => line.name === "Brain")?.detail).toContain("not executable");

    const bare = runtimeConfig((raw) => {
      raw.headless = true;
      raw.brain = {
        ...raw.brain,
        backend: "acp",
        mode: "subprocess",
        binary: "not-on-path",
      };
    });
    let fileChecks = 0;
    const bareLines = await collectStatus(bare, {
      inspectDaemon: () => Promise.resolve({ kind: "absent" }),
      probe: () => Promise.resolve(true),
      which: () => null,
      isExecutable: () => {
        fileChecks += 1;
        return Promise.resolve(true);
      },
    });
    expect(fileChecks).toBe(0);
    expect(bareLines.find((line) => line.name === "Brain")).toMatchObject({ level: "fail" });
  });

  test("matches OpenAI brain health headers including a fresh session identity", async () => {
    const config = runtimeConfig((raw) => {
      raw.headless = true;
      raw.brain = {
        ...raw.brain,
        backend: "openai-compatible",
        mode: "subprocess",
        base_url: "http://127.0.0.1:8642/v1",
        model: "hermes",
        headers: { "X-Hermes-Session-Key": "local-profile" },
        session_header: "X-Hermes-Session-Id",
      };
    });
    const requests: StatusProbeRequest[] = [];

    await collectStatus(config, {
      inspectDaemon: () => Promise.resolve({ kind: "absent" }),
      probe: (request) => {
        requests.push(request);
        return Promise.resolve(true);
      },
    });

    const request = requests.find((candidate) => candidate.url.includes(":8642/"));
    expect(request?.headers?.["Content-Type"]).toBe("application/json");
    expect(request?.headers?.["X-Hermes-Session-Key"]).toBe("local-profile");
    expect(request?.headers?.["X-Hermes-Session-Id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test("warns when the built helper cannot honor the configured hotkey", async () => {
    const config = runtimeConfig((raw) => {
      raw.headless = false;
      raw.hotkey = "option+space";
      raw.brain = { ...raw.brain, backend: "acp", mode: "subprocess" };
    });

    const lines = await collectStatus(config, {
      platform: "darwin",
      inspectDaemon: () => Promise.resolve({ kind: "absent" }),
      probe: () => Promise.resolve(true),
      which: () => "/usr/bin/hermes",
      isExecutable: () => Promise.resolve(true),
    });

    expect(lines.find((line) => line.name === "Hotkey")).toEqual({
      name: "Hotkey",
      level: "warn",
      detail: "option+space · helper is executable but currently listens for ctrl+shift+space; typed/web voice remains available",
    });
  });

  test("does not claim the macOS hotkey helper works on another platform", async () => {
    const config = runtimeConfig((raw) => {
      raw.headless = false;
      raw.brain = { ...raw.brain, backend: "acp", mode: "subprocess" };
    });
    let executableChecks = 0;

    const lines = await collectStatus(config, {
      platform: "linux",
      inspectDaemon: () => Promise.resolve({ kind: "absent" }),
      probe: () => Promise.resolve(true),
      which: () => "/usr/bin/hermes",
      isExecutable: () => {
        executableChecks += 1;
        return Promise.resolve(true);
      },
    });

    expect(executableChecks).toBe(0);
    expect(lines.find((line) => line.name === "Hotkey")).toEqual({
      name: "Hotkey",
      level: "warn",
      detail: "ctrl+shift+space · native helper is macOS-only; typed/web voice remains available",
    });
  });

  test("renders stable status rows", () => {
    expect(renderStatus([
      { name: "Daemon", level: "ok", detail: "running (pid 42)" },
      { name: "TTS", level: "info", detail: "disabled" },
    ])).toBe([
      "",
      "  Cicero Status",
      "  ─────────────",
      "  Daemon                 ✓ running (pid 42)",
      "  TTS                    • disabled",
      "",
    ].join("\n"));
  });
});
