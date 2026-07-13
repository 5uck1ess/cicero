import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig as loadConfigRaw, type CLIFlags } from "../src/config";

// Isolate every test here from the developer's real ~/.cicero/config.yaml — point
// loadConfig at a directory with no config/actions file so we assert built-in
// defaults, not whatever the current machine happens to have configured.
const NO_CONFIG_HOME = join(tmpdir(), "cicero-test-no-config");
const loadConfig = (flags: CLIFlags = {}) => loadConfigRaw(flags, { home: NO_CONFIG_HOME });

function loadYaml(yaml: string) {
  const home = mkdtempSync(join(tmpdir(), "cicero-config-test-"));
  writeFileSync(join(home, "config.yaml"), yaml);
  return () => loadConfigRaw({}, { home });
}

describe("Config — default values", () => {
  const config = loadConfig();

  test("silenceDuration defaults to '1.0'", () => {
    expect(config.silenceDuration).toBe("1.0");
  });

  test("silenceThreshold defaults to '3%'", () => {
    expect(config.silenceThreshold).toBe("3%");
  });

  test("STT model defaults to large-v3-turbo", () => {
    expect(config.servers.stt.model).toContain("large-v3-turbo");
  });

  test("router model defaults to Qwen3.5", () => {
    expect(config.servers.router.model).toContain("Qwen3.5");
  });

  test("router port defaults to 8081", () => {
    expect(config.servers.router.port).toBe(8081);
  });

  test("TTS port defaults to 8082", () => {
    expect(config.servers.tts.port).toBe(8082);
  });

  test("STT port defaults to 8083", () => {
    expect(config.servers.stt.port).toBe(8083);
  });

  test("terminal defaults to auto", () => {
    expect(config.terminal).toBe("auto");
  });

  test("CLI --brain flag accepts qwen and ollama", () => {
    expect(loadConfig({ brain: "qwen" }).brain.backend).toBe("qwen");
    expect(loadConfig({ brain: "ollama" }).brain.backend).toBe("ollama");
  });

  test("CLI --brain flag rejects invalid backends", () => {
    expect(() => loadConfig({ brain: "gpt-4" })).toThrow();
  });

  test("brain backend defaults to claude-code", () => {
    expect(config.brain.backend).toBe("claude-code");
  });

  test("brain mode defaults to tab-inject", () => {
    expect(config.brain.mode).toBe("tab-inject");
  });

  test("brain confirm_retry defaults to enabled", () => {
    expect(config.brain.confirm_retry).toBe(true);
  });

  test("computer use defaults to local-only egress with bounded reads", () => {
    expect(config.compute).toEqual({
      allowCloud: false,
      root: undefined,
      maxReadBytes: 256 * 1024,
    });
  });

  test("hotkey defaults to ctrl+shift+space", () => {
    expect(config.hotkey).toBe("ctrl+shift+space");
  });

  test("TTS defaults to enabled", () => {
    expect(config.ttsEnabled).toBe(true);
  });

  test("barge-in defaults to disabled", () => {
    expect(config.bargeInEnabled).toBe(false);
  });

  test("full-duplex defaults to disabled", () => {
    expect(config.fullDuplex).toBe(false);
  });

  test("clap-to-activate defaults on; clap-to-deactivate defaults off", () => {
    expect(config.clap.enabled).toBe(true);
    expect(config.clap.deactivate).toBe(false);
  });

  test("ttsSummaryMaxTokens defaults to 100", () => {
    expect(config.ttsSummaryMaxTokens).toBe(100);
  });

  test("ttsLocalMaxTokens defaults to 150", () => {
    expect(config.ttsLocalMaxTokens).toBe(150);
  });
});

describe("Config — phonetic aliases defaults", () => {
  const config = loadConfig();
  const aliases = config.phoneticAliases;

  test("has tabs aliases", () => {
    expect(aliases.tabs).toBeDefined();
    expect(aliases.tabs).toContain("tubs");
    expect(aliases.tabs).toContain("hubs");
    expect(aliases.tabs).toContain("taps");
    expect(aliases.tabs).toContain("tops");
  });

  test("has tab aliases", () => {
    expect(aliases.tab).toBeDefined();
    expect(aliases.tab).toContain("tub");
    expect(aliases.tab).toContain("hub");
    expect(aliases.tab).toContain("tap");
    expect(aliases.tab).toContain("top");
    expect(aliases.tab).toContain("tam");
  });

  test("has switch aliases", () => {
    expect(aliases.switch).toBeDefined();
    expect(aliases.switch).toContain("swish");
    expect(aliases.switch).toContain("stitch");
  });

  test("has list aliases", () => {
    expect(aliases.list).toBeDefined();
    expect(aliases.list).toContain("least");
    expect(aliases.list).toContain("last");
  });
});

describe("Config — default actions", () => {
  const config = loadConfig();

  test("tab_switch action exists with terminal category", () => {
    expect(config.actions.tab_switch).toBeDefined();
    expect(config.actions.tab_switch.category).toBe("terminal");
  });

  test("tab_list action exists", () => {
    expect(config.actions.tab_list).toBeDefined();
    expect(config.actions.tab_list.category).toBe("terminal");
  });

  test("slack_check action exists with cli category", () => {
    expect(config.actions.slack_check).toBeDefined();
    expect(config.actions.slack_check.category).toBe("cli");
  });

  test("morning_checkin action exists with brain category", () => {
    expect(config.actions.morning_checkin).toBeDefined();
    expect(config.actions.morning_checkin.category).toBe("brain");
  });

  test("time_check action exists with local category", () => {
    expect(config.actions.time_check).toBeDefined();
    expect(config.actions.time_check.category).toBe("local");
  });

  test("greeting action has no command", () => {
    expect(config.actions.greeting).toBeDefined();
    expect(config.actions.greeting.command).toBe("");
  });

  test("help action has no command", () => {
    expect(config.actions.help).toBeDefined();
    expect(config.actions.help.command).toBe("");
  });

  test("text_inject action exists with brain category", () => {
    expect(config.actions.text_inject).toBeDefined();
    expect(config.actions.text_inject.category).toBe("brain");
    expect(config.actions.text_inject.examples.length).toBeGreaterThan(0);
  });

  test("runtime_mute action exists with local category", () => {
    expect(config.actions.runtime_mute).toBeDefined();
    expect(config.actions.runtime_mute.category).toBe("local");
  });

  test("runtime_unmute action exists with local category", () => {
    expect(config.actions.runtime_unmute).toBeDefined();
    expect(config.actions.runtime_unmute.category).toBe("local");
  });

  test("tab_command action exists with terminal category", () => {
    expect(config.actions.tab_command).toBeDefined();
    expect(config.actions.tab_command.category).toBe("terminal");
  });
});

describe("Config — CLI flags override", () => {
  test("tts flag overrides default", () => {
    const config = loadConfig({ tts: false });
    expect(config.ttsEnabled).toBe(false);
  });

  test("brain flag overrides default", () => {
    const config = loadConfig({ brain: "ollama" });
    expect(config.brain.backend).toBe("ollama");
  });

  test("brainMode flag overrides default", () => {
    const config = loadConfig({ brainMode: "subprocess" });
    expect(config.brain.mode).toBe("subprocess");
  });

  test("brainTab flag overrides default", () => {
    const config = loadConfig({ brainTab: "my-brain" });
    expect(config.brain.target_tab).toBe("my-brain");
  });
});

describe("Config — backend getters (backward compat)", () => {
  test("sttBackend falls back to servers.stt config", () => {
    const config = loadConfig();
    const stt = config.sttBackend;
    expect(stt.backend).toBe("mlx-whisper");
    expect(stt.port).toBe(8083);
    expect(stt.model).toBe("mlx-community/whisper-large-v3-turbo");
  });

  test("sttFallbackBackend exposes an optional hot standby without changing the primary", () => {
    const config = loadYaml([
      "stt:",
      "  backend: faster-whisper",
      "  port: 8083",
      "stt_fallback:",
      "  backend: audiocpp",
      "  port: 8092",
      "  model: qwen3-asr",
    ].join("\n"))();

    expect(config.sttBackend.backend).toBe("faster-whisper");
    expect(config.sttFallbackBackend).toEqual({
      backend: "audiocpp",
      port: 8092,
      model: "qwen3-asr",
    });
  });

  test("rejects a fallback that resolves to the primary endpoint", () => {
    expect(loadYaml([
      "stt:",
      "  backend: faster-whisper",
      "  host: localhost",
      "stt_fallback:",
      "  backend: faster-whisper",
      "  host: 127.0.0.1",
      "  port: 8083",
    ].join("\n"))).toThrow(
      /stt_fallback resolves to the primary STT endpoint \(local:8083\); configure a distinct host or port/,
    );
  });

  test("allows the same STT backend on a genuinely distinct host or port", () => {
    const distinctPort = loadYaml([
      "stt:",
      "  backend: faster-whisper",
      "  port: 8083",
      "stt_fallback:",
      "  backend: faster-whisper",
      "  port: 8084",
    ].join("\n"))();
    expect(distinctPort.sttFallbackBackend?.port).toBe(8084);

    const distinctHost = loadYaml([
      "stt:",
      "  backend: faster-whisper",
      "  host: gpu-a.internal",
      "  port: 8083",
      "stt_fallback:",
      "  backend: faster-whisper",
      "  host: gpu-b.internal",
      "  port: 8083",
    ].join("\n"))();
    expect(distinctHost.sttFallbackBackend?.host).toBe("gpu-b.internal");
  });

  test("ttsBackend falls back to servers.tts config with voice", () => {
    const config = loadConfig();
    const tts = config.ttsBackend;
    expect(tts.backend).toBe("mlx-audio");
    expect(tts.port).toBe(8082);
    expect(tts.voice).toBe("Ryan");
  });

  test("llmBackend falls back to servers.router config", () => {
    const config = loadConfig();
    const llm = config.llmBackend;
    expect(llm.backend).toBe("mlx-lm");
    expect(llm.port).toBe(8081);
    expect(llm.model).toBe("mlx-community/Qwen3.5-0.8B-MLX-4bit");
  });
});

describe("Config — runtime toggles", () => {
  test("TTS can be toggled at runtime", () => {
    const config = loadConfig({ tts: true });
    expect(config.ttsEnabled).toBe(true);
    config.ttsEnabled = false;
    expect(config.ttsEnabled).toBe(false);
    config.ttsEnabled = true;
    expect(config.ttsEnabled).toBe(true);
  });
});

describe("Config — fail-fast validation", () => {
  test("the checked-in configuration example satisfies the runtime schema", () => {
    const yaml = readFileSync(join(import.meta.dir, "..", "config.yaml.example"), "utf8");
    expect(() => loadYaml(yaml)()).not.toThrow();
  });

  test("rejects unknown built-in keys with actionable suggestions", () => {
    expect(loadYaml([
      "headles: true",
      "brain:",
      "  autoApproveTools: true",
      "web_voice:",
      "  max_clientz: 4",
      "",
    ].join("\n"))).toThrow(
      /config\.headles is not supported; did you mean config\.headless\?[\s\S]*brain\.autoApproveTools is not supported; did you mean brain\.auto_approve_tools\?[\s\S]*web_voice\.max_clientz is not supported/,
    );
  });

  test("rejects ignored legacy controls in every built-in server block", () => {
    for (const name of ["router", "tts", "stt"]) {
      expect(loadYaml([
        "servers:",
        `  ${name}:`,
        "    enabled: false",
        "    vad_model: /models/silero.onnx",
        "",
      ].join("\n"))).toThrow(
        new RegExp(`servers\\.${name}\\.enabled is not supported[\\s\\S]*servers\\.${name}\\.vad_model is not supported`),
      );
    }
  });

  test("keeps LLM request extensions inside the explicit extra mapping", () => {
    const config = loadYaml([
      "llm:",
      "  backend: ollama",
      "  extra:",
      "    vendor_future_flag: true",
      "",
    ].join("\n"))();
    expect(config.llmBackend.extra).toEqual({ vendor_future_flag: true });
    expect(loadYaml("llm:\n  backend: ollama\n  vendor_future_flag: true\n")).toThrow(
      /llm\.vendor_future_flag is not supported/,
    );
  });

  test("rejects provider fields that no built-in speech backend consumes", () => {
    expect(loadYaml([
      "stt:",
      "  backend: faster-whisper",
      "  apiKey: ignored-primary-key",
      "  extra: { ignored: primary-stt }",
      "stt_fallback:",
      "  backend: audiocpp",
      "  port: 8092",
      "  apiKey: ignored-fallback-key",
      "  extra: { ignored: fallback-stt }",
      "tts:",
      "  backend: pocket-tts",
      "  extra: { ignored: primary-tts }",
      "tts_fallback:",
      "  backend: kokoro",
      "  port: 8094",
      "  extra: { ignored: fallback-tts }",
      "",
    ].join("\n"))).toThrow(
      /stt\.apiKey is not supported[\s\S]*stt\.extra is not supported[\s\S]*stt_fallback\.apiKey is not supported[\s\S]*stt_fallback\.extra is not supported[\s\S]*tts\.extra is not supported[\s\S]*tts_fallback\.extra is not supported/,
    );
  });

  test("rejects malformed YAML instead of silently using defaults", () => {
    expect(loadYaml("brain: [unterminated" )).toThrow(/Could not load.*config\.yaml/);
  });

  test("rejects a non-mapping YAML document", () => {
    expect(loadYaml("- not\n- a\n- config\n")).toThrow(/document root must be a mapping/);
  });

  test("reports wrong operational types and out-of-range ports", () => {
    expect(loadYaml("tts_enabled: yes please\nweb_voice:\n  port: 70000\n")).toThrow(
      /tts_enabled must be a boolean[\s\S]*web_voice\.port must be an integer/,
    );
  });

  test("rejects unknown deployment tiers", () => {
    expect(loadYaml("deployment: fastest-ish\n")).toThrow(/deployment must be one of/);
  });

  test("rejects invalid provider and agent deadlines", () => {
    expect(loadYaml([
      "brain:",
      "  timeout_ms: never",
      "stt:",
      "  backend: faster-whisper",
      "  timeout_ms: 0",
      "stt_fallback:",
      "  backend: audiocpp",
      "  timeout_ms: 0",
      "tts:",
      "  backend: pocket-tts",
      "  timeout_ms: 900001",
      "turn:",
      "  timeout_ms: 1.5",
      "",
    ].join("\n"))).toThrow(
      /brain\.timeout_ms must be an integer[\s\S]*stt\.timeout_ms must be an integer[\s\S]*stt_fallback\.timeout_ms must be an integer[\s\S]*tts\.timeout_ms must be an integer[\s\S]*turn\.timeout_ms must be an integer/,
    );
  });

  test("rejects the ghost brain turn deadline instead of pretending to apply it", () => {
    expect(loadYaml("brain:\n  turn_timeout_ms: 30000\n")).toThrow(
      /brain\.turn_timeout_ms is not supported; use brain\.timeout_ms for HTTP-backed brains/,
    );
  });

  test("rejects an end-of-turn backend that the factory cannot select", () => {
    expect(loadYaml("turn:\n  enabled: true\n  backend: smartish-turn\n")).toThrow(
      /turn\.backend must be 'smart-turn'/,
    );
  });

  test("rejects removed no-op settings instead of pretending to apply them", () => {
    expect(loadYaml([
      "stt_model: /models/whisper.bin",
      "brain:",
      "  session_timeout: 4h",
      "  max_context_commands: 50",
      "",
    ].join("\n"))).toThrow(
      /config\.stt_model is not supported[\s\S]*brain\.session_timeout is not supported[\s\S]*brain\.max_context_commands is not supported/,
    );
  });

  test("rejects invalid ACP in-memory text limits", () => {
    expect(loadYaml([
      "brain:",
      "  backend: acp",
      "  max_queue_bytes: 0",
      "  max_response_bytes: 67108865",
      "  max_pending_turns: 1025",
      "",
    ].join("\n"))).toThrow(
      /brain\.max_queue_bytes must be an integer[\s\S]*brain\.max_response_bytes must be an integer[\s\S]*brain\.max_pending_turns must be an integer/,
    );
  });

  test("rejects a non-string inline provider API key before doctor can inspect it", () => {
    expect(loadYaml([
      "tts:",
      "  backend: elevenlabs",
      "  voice: cloud-id",
      "  apiKey: 123",
      "",
    ].join("\n"))).toThrow(/tts\.apiKey must be a non-empty string/);
  });

  test("rejects quoted security and lifecycle booleans", () => {
    expect(loadYaml([
      "brain:",
      "  auto_approve_tools: 'false'",
      "  confirm_retry: 'true'",
      "full_duplex: 'false'",
      "web_voice:",
      "  tls:",
      "    enabled: 'false'",
      "notify:",
      "  telegram:",
      "    voice_note: 'false'",
      "",
    ].join("\n"))).toThrow(
      /brain\.auto_approve_tools must be a boolean[\s\S]*brain\.confirm_retry must be a boolean[\s\S]*full_duplex must be a boolean[\s\S]*web_voice\.tls\.enabled must be a boolean[\s\S]*notify\.telegram\.voice_note must be a boolean/,
    );
  });

  test("accepts explicit false for auto approval", () => {
    expect(loadYaml("brain:\n  auto_approve_tools: false\n")().brain.auto_approve_tools).toBe(false);
  });

  test("treats empty and comment-only config documents as defaults", () => {
    for (const yaml of ["", "# all settings intentionally disabled\n"]) {
      const config = loadYaml(yaml)();
      expect(config.brain.backend).toBe("claude-code");
      expect(config.actions.tab_switch).toBeDefined();
    }
  });

  test("treats empty and comment-only actions documents as built-ins only", () => {
    for (const yaml of ["", "# custom actions intentionally removed\n", "{}\n"]) {
      const home = mkdtempSync(join(tmpdir(), "cicero-actions-empty-test-"));
      writeFileSync(join(home, "actions.yaml"), yaml);
      const config = loadConfigRaw({}, { home });
      expect(config.actions.tab_switch).toBeDefined();
      expect(Object.keys(config.actions).length).toBeGreaterThan(0);
    }
  });

  test("rejects compute settings that could bypass fail-closed egress", () => {
    expect(loadYaml([
      "compute:",
      "  allow_cloud: 'false'",
      "  root: 42",
      "  max_read_bytes: 0",
      "",
    ].join("\n"))).toThrow(
      /compute\.allow_cloud must be a boolean[\s\S]*compute\.root must be a non-empty string[\s\S]*compute\.max_read_bytes must be an integer/,
    );
  });

  test("validates action records loaded from actions.yaml", () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-actions-test-"));
    writeFileSync(join(home, "actions.yaml"), [
      "actions:",
      "  unsafe:",
      "    category: typo",
      "    command: 42",
      "    tts_mode: verbose",
      "    examples: nope",
      "    timeout_s: 0",
      "    output_limit: 999999999",
      "",
    ].join("\n"));
    expect(() => loadConfigRaw({}, { home })).toThrow(
      /actions\.unsafe\.category[\s\S]*actions\.unsafe\.timeout_s[\s\S]*actions\.unsafe\.output_limit/,
    );
  });

  test("accepts finite per-action command bounds", () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-actions-bounds-test-"));
    writeFileSync(join(home, "actions.yaml"), [
      "actions:",
      "  bounded:",
      "    category: cli",
      "    command: echo ready",
      "    tts_mode: full",
      "    examples: [run bounded]",
      "    timeout_s: 90.5",
      "    output_limit: 131072",
      "",
    ].join("\n"));

    const action = loadConfigRaw({}, { home }).actions.bounded;
    expect(action?.timeout_s).toBe(90.5);
    expect(action?.output_limit).toBe(131072);
  });

  test("rejects unsafe web tokens before the server starts", () => {
    for (const token of [
      "''",
      "[]",
      "42",
      "change-me-32-chars-of-randomness",
      "too-short",
      "<generate-a-secret>",
      "generate-a-secret",
      "paste-your-token-here",
      "example-token-value",
    ]) {
      expect(loadYaml(`web_voice:\n  token: ${token}\n`)).toThrow(/web_voice\.token/);
    }
    expect(loadYaml("web_voice:\n  token: a-unique-32-character-runtime-secret\n")().web_voice?.token).toBe(
      "a-unique-32-character-runtime-secret",
    );
    expect(loadYaml("web_voice:\n  token: your-token-a91f4d68c2e740ba949aa8c56cb3f671\n")().web_voice?.token).toBe(
      "your-token-a91f4d68c2e740ba949aa8c56cb3f671",
    );
    expect(() => loadYaml("web_voice:\n  token: too-short\n")()).toThrow(
      /openssl rand -hex 16/,
    );
  });

  test("rejects terminal adapters that are advertised but not implemented", () => {
    expect(loadYaml("terminal: iterm2\n")).toThrow(/terminal must be one of.*kitty.*wezterm.*tmux.*none/);
  });

  test("rejects non-finite and out-of-range web turn controls", () => {
    expect(loadYaml([
      "web_voice:",
      "  resume_turns: -1",
      "  speculative:",
      "    min_probability: 1.1",
      "  long_turn:",
      "    park_after_s: .nan",
      "    max_background_s: 0",
      "",
    ].join("\n"))).toThrow(
      /web_voice\.resume_turns[\s\S]*web_voice\.speculative\.min_probability[\s\S]*web_voice\.long_turn\.park_after_s[\s\S]*web_voice\.long_turn\.max_background_s/,
    );
  });

  test("requires complete TLS paths and HTTP summarizer URLs", () => {
    expect(loadYaml([
      "web_voice:",
      "  tls:",
      "    cert_file: /tmp/cert.pem",
      "  tldr:",
      "    summarizer_url: file:///tmp/prompt",
      "",
    ].join("\n"))).toThrow(
      /web_voice\.tls\.cert_file and web_voice\.tls\.key_file[\s\S]*web_voice\.tldr\.summarizer_url/,
    );
  });

  test("validates audio detector thresholds and timing relationships", () => {
    expect(loadYaml([
      "turn: { threshold: -0.1, grace_attempts: 1.5, grace_max_duration: 0 }",
      "tone: { min_score: 2, grace_ms: -1 }",
      "clap: { threshold: 1.2, min_gap_ms: 500, max_gap_ms: 100 }",
      "vad: { open_factor: 0, hangover_ms: -1 }",
      "",
    ].join("\n"))).toThrow(
      /clap\.threshold[\s\S]*clap\.max_gap_ms must be greater[\s\S]*turn\.threshold[\s\S]*tone\.min_score[\s\S]*vad\.hangover_ms/,
    );
  });

  test("validates configured regexes, aliases, and quick intents", () => {
    expect(loadYaml([
      "phonetic_aliases:",
      "  tab: [good, '']",
      "quick_intents:",
      "  - pattern: '[unterminated'",
      "    reply: ''",
      "  - reply: pong",
      "",
    ].join("\n"))).toThrow(
      /phonetic_aliases\.tab[\s\S]*quick_intents\.0\.reply[\s\S]*quick_intents\.0\.pattern[\s\S]*quick_intents\.1 must define/,
    );
  });

  test("requires an explicit endpoint for generic OpenAI-compatible brains", () => {
    expect(loadYaml("brain:\n  backend: openai-compatible\n")).toThrow(/brain\.base_url is required/);
    expect(loadYaml("brain:\n  backend: openai-compatible\n  base_url: not-a-url\n")).toThrow(/brain\.base_url/);
  });

  test("validates nested lane and fallback settings", () => {
    expect(loadYaml([
      "brain:",
      "  lanes:",
      "    coder:",
      "      backend: shell",
      "      env: { SAFE: 1 }",
      "      fallbacks: []",
      "",
    ].join("\n"))).toThrow(
      /brain\.lanes\.coder\.backend[\s\S]*brain\.lanes\.coder\.env[\s\S]*brain\.lanes\.coder\.fallbacks/,
    );
  });

  test("validates notification schedules and bounded polling settings", () => {
    expect(loadYaml([
      "notify:",
      "  timezone: Mars/Olympus",
      "  quiet_hours: { from: '25:00', to: noon }",
      "  briefing: { at: '8am' }",
      "  call_minutes: { min_minutes: -1 }",
      "  kanban:",
      "    interval_seconds: 0",
      "    command: []",
      "",
    ].join("\n"))).toThrow(
      /notify\.timezone[\s\S]*notify\.quiet_hours\.from[\s\S]*notify\.briefing\.at[\s\S]*notify\.kanban\.interval_seconds[\s\S]*notify\.kanban\.command[\s\S]*notify\.call_minutes\.min_minutes/,
    );
  });

  test("kanban watch has no built-in board CLI — enabling it requires an explicit command", () => {
    // No default harness: an enabled watch without a command is a config
    // error naming the fix, not a silent fallback to some vendor's CLI.
    expect(loadYaml([
      "notify:",
      "  kanban:",
      "    enabled: true",
      "",
    ].join("\n"))).toThrow(/notify\.kanban\.command is required/);
    // A present-but-disabled block needs no command…
    expect(loadYaml([
      "notify:",
      "  kanban:",
      "    enabled: false",
      "",
    ].join("\n"))).not.toThrow();
    // …and an explicit command satisfies the enabled watch; task_command is
    // validated like command when present.
    expect(loadYaml([
      "notify:",
      "  kanban:",
      "    enabled: true",
      "    command: [hermes, kanban, list, --json]",
      "    task_command: [hermes, kanban, show]",
      "",
    ].join("\n"))).not.toThrow();
    expect(loadYaml([
      "notify:",
      "  kanban:",
      "    command: [board-cli, list]",
      "    task_command: []",
      "",
    ].join("\n"))).toThrow(/notify\.kanban\.task_command/);
  });

  test("validates scheduled prompts: time format, prompt presence, and lane existence", () => {
    expect(loadYaml([
      "brain:",
      "  lanes:",
      "    coder: { backend: acp }",
      "notify:",
      "  schedules:",
      "    - name: ideas",
      "      at: '9am'",
      "      prompt: ''",
      "      lane: conductor",
      "",
    ].join("\n"))).toThrow(
      /notify\.schedules\[0\]\.at[\s\S]*notify\.schedules\[0\]\.prompt[\s\S]*notify\.schedules\[0\]\.lane "conductor" is not a configured brain lane \(have: coder\)/,
    );
  });

  test("accepts a well-formed scheduled prompt on a configured lane", () => {
    const config = loadYaml([
      "brain:",
      "  lanes:",
      "    conductor: { backend: acp }",
      "notify:",
      "  schedules:",
      "    - name: content ideas",
      "      at: '09:00'",
      "      prompt: Draft today's content ideas with sources.",
      "      lane: conductor",
      "",
    ].join("\n"))();
    expect(config.raw.notify?.schedules?.[0]?.lane).toBe("conductor");
  });

  test("validates terminal scrape sidecars and prompt regexes", () => {
    expect(loadYaml([
      "sidecar:",
      "  backend: terminal-scrape",
      "  targetTab: ''",
      "  pollIntervalMs: 0",
      "  quietWindowMs: -1",
      "  promptMarker: '[unterminated'",
      "",
    ].join("\n"))).toThrow(
      /sidecar\.targetTab[\s\S]*sidecar\.pollIntervalMs[\s\S]*sidecar\.quietWindowMs[\s\S]*sidecar\.promptMarker/,
    );
  });

  test("rejects actions files without an actions mapping", () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-actions-null-test-"));
    writeFileSync(join(home, "actions.yaml"), "actions:\n");
    expect(() => loadConfigRaw({}, { home })).toThrow(/actions\.yaml#actions[\s\S]*document root must be a mapping/);
  });

  test("rejects ignored actions document root keys", () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-actions-root-test-"));
    writeFileSync(join(home, "actions.yaml"), "actionz: {}\nactions: {}\n");
    expect(() => loadConfigRaw({}, { home })).toThrow(
      /actionz is not supported; actions\.yaml must contain only an actions mapping/,
    );
  });
});
