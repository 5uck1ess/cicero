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

  // Round 4 (Codex): the classifier block ships COMMENTED OUT, so schema
  // validation never saw it — and it shipped on web_voice's port, which any
  // operator following the instructions would have copied verbatim.
  test("every commented example block is valid once uncommented in place", () => {
    const yaml = readFileSync(join(import.meta.dir, "..", "config.yaml.example"), "utf8");
    const lines = yaml.split("\n");
    // Find each commented-out top-level block: a "# key:" line plus the
    // indented "#   ..." lines under it.
    const blocks: Array<{ start: number; end: number; key: string }> = [];
    let current: { start: number; end: number; key: string } | null = null;
    for (const [index, line] of lines.entries()) {
      const opener = /^# {0,2}([a-z_]+):\s*$/.exec(line);
      if (opener) {
        current = { start: index, end: index, key: opener[1]! };
        blocks.push(current);
        continue;
      }
      if (current && /^# {3,}\S/.test(line)) {
        current.end = index;
        continue;
      }
      current = null;
    }
    expect(blocks.map((block) => block.key)).toContain("classifier");

    // Uncommenting one IN PLACE is what an operator actually does, so validate
    // it against the rest of the shipped file — a block that is fine alone can
    // still collide with an active listener's port.
    for (const block of blocks) {
      const merged = lines.map((line, index) =>
        index >= block.start && index <= block.end ? line.replace(/^# ?/, "") : line);
      expect(() => loadYaml(merged.join("\n"))(), `uncommenting ${block.key}:`).not.toThrow();
    }
  });

  // Round 4 (Codex): startManagedServer() adopts a server already healthy on a
  // port instead of starting one, and a chat request's `model` is informational
  // to llama-server — so a classifier pointed at another listener's port never
  // loads its model, classifies on whatever is there, and reports healthy.
  test("a classifier sharing the reply model's endpoint with a different model is refused", () => {
    expect(loadYaml([
      "llm:",
      "  backend: llama-cpp",
      "  port: 8080",
      "  model: big-reply-model",
      "classifier:",
      "  backend: llama-cpp",
      "  port: 8080",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/classifier resolves to the same endpoint as llm \(127\.0\.0\.1:8080\) but names a different model/);
  });

  test("deliberately sharing one server for both roles stays allowed", () => {
    expect(() => loadYaml([
      "llm:",
      "  backend: llama-cpp",
      "  port: 8080",
      "  model: one-model-for-both",
      "classifier:",
      "  backend: llama-cpp",
      "  port: 8080",
      "  model: one-model-for-both",
      "",
    ].join("\n"))()).not.toThrow();
  });

  // The refusal tells the operator to drop classifier.model; that has to be a
  // config this check then accepts.
  test("the remediation the error names is itself accepted", () => {
    expect(() => loadYaml([
      "llm:",
      "  backend: llama-cpp",
      "  port: 8080",
      "  model: big-reply-model",
      "classifier:",
      "  backend: llama-cpp",
      "  port: 8080",
      "",
    ].join("\n"))()).not.toThrow();
  });

  test("a classifier port already used by another local listener is refused", () => {
    expect(loadYaml([
      "web_voice:",
      "  enabled: true",
      "  port: 8090",
      "  token: a-token-that-is-long-enough",
      "classifier:",
      "  backend: llama-cpp",
      "  host: 127.0.0.1",
      "  port: 8090",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/classifier\.port 8090 is already used by web_voice/);
  });

  // Round 10 (Codex): a wildcard bind takes the port on every interface, so it
  // contends with an interface-specific listener even though neither host
  // string matches the other. The classifier wins the race (providers start
  // before the web server), web voice then fails its bind and startup aborts.
  test("a wildcard classifier collides with an interface-specific web bind", () => {
    expect(loadYaml([
      "web_voice:",
      "  enabled: true",
      "  host: 192.168.1.5",
      "  port: 8090",
      "  token: a-token-that-is-long-enough",
      "classifier:",
      "  backend: ollama",
      "  host: 0.0.0.0",
      "  port: 8090",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/classifier\.port 8090 is already used by web_voice/);
  });

  // The mirror image: an interface-specific classifier against the wildcard
  // bind web voice takes by default.
  test("an interface-specific classifier collides with a wildcard web bind", () => {
    expect(loadYaml([
      "web_voice:",
      "  enabled: true",
      "  host: 0.0.0.0",
      "  port: 8090",
      "  token: a-token-that-is-long-enough",
      "classifier:",
      "  backend: ollama",
      "  host: 127.0.0.1",
      "  port: 8090",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/classifier\.port 8090 is already used by web_voice/);
  });

  test("a remote classifier is not compared against local ports", () => {
    expect(() => loadYaml([
      "web_voice:",
      "  enabled: true",
      "  port: 8090",
      "  token: a-token-that-is-long-enough",
      "classifier:",
      "  backend: openai-compatible",
      "  host: classifier.example",
      "  port: 8090",
      "  model: small-classifier-model",
      "",
    ].join("\n"))()).not.toThrow();
  });

  // Round 5 (Codex): every one of these roles binds a DEFAULT when its port —
  // or its whole section — is omitted, and validation was comparing only the
  // literal config values. So the collisions it caught were exactly the ones an
  // operator had already written down, and the silent ones went through.
  test("an omitted llm section still occupies the reply model's default seat", () => {
    // No `llm:` at all — RuntimeConfig synthesizes mlx-lm on servers.router.port.
    expect(loadYaml([
      "classifier:",
      "  backend: mlx-lm",
      "  port: 8081",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/same endpoint as llm \(127\.0\.0\.1:8081\)/);
  });

  test("an omitted port still occupies its backend's default seat", () => {
    // Neither role names a port; both llama-cpp providers bind 8080.
    expect(loadYaml([
      "llm:",
      "  backend: llama-cpp",
      "  model: big-reply-model",
      "classifier:",
      "  backend: llama-cpp",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/same endpoint as llm \(127\.0\.0\.1:8080\)/);

    // ...and the mixed case: one spelled out, one defaulted.
    expect(loadYaml([
      "llm:",
      "  backend: llama-cpp",
      "  port: 8080",
      "  model: big-reply-model",
      "classifier:",
      "  backend: llama-cpp",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/same endpoint as llm/);
  });

  test("an enabled listener with no port still holds its default port", () => {
    expect(loadYaml([
      "web_voice:",
      "  enabled: true",
      "  token: a-token-that-is-long-enough",
      "classifier:",
      "  backend: llama-cpp",
      "  port: 8090",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/classifier\.port 8090 is already used by web_voice/);
  });

  // Round 6 (Codex): the dashboard is default-ON and starts BEFORE any
  // provider, so it holds 8086 in every config that does not switch it off —
  // and it answers 404 on /health, so the classifier's probe does not adopt it
  // either; llama-server then cannot bind and the role is silently unavailable.
  test("the default-on dashboard holds its port against a classifier", () => {
    expect(loadYaml([
      "classifier:",
      "  backend: llama-cpp",
      "  port: 8086",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/classifier\.port 8086 is already used by dashboard/);

    // Explicitly on, non-default port: still held.
    expect(loadYaml([
      "dashboard:",
      "  enabled: true",
      "  port: 8099",
      "classifier:",
      "  backend: llama-cpp",
      "  port: 8099",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/classifier\.port 8099 is already used by dashboard/);
  });

  test("a dashboard switched off frees its port", () => {
    expect(() => loadYaml([
      "dashboard:",
      "  enabled: false",
      "classifier:",
      "  backend: llama-cpp",
      "  port: 8086",
      "  model: small-classifier-model",
      "",
    ].join("\n"))()).not.toThrow();
  });

  // Round 7 (Codex): an OpenAI-compatible backend addresses a URL and has no
  // default port, so a classifier configured only with baseUrl resolved to no
  // port at all and skipped every comparison — while pointing at the reply
  // server's socket and adopting the reply model, exactly as a bare port would.
  test("a classifier baseUrl aimed at the reply server is refused", () => {
    expect(loadYaml([
      "llm:",
      "  backend: llama-cpp",
      "  port: 8080",
      "  model: big-reply-model",
      "classifier:",
      "  backend: openai-compatible",
      "  baseUrl: http://127.0.0.1:8080/v1",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/same endpoint as llm \(127\.0\.0\.1:8080\)/);
  });

  test("a classifier baseUrl colliding with another local listener is refused", () => {
    expect(loadYaml([
      "web_voice:",
      "  enabled: true",
      "  port: 8090",
      "  token: a-token-that-is-long-enough",
      "classifier:",
      "  backend: openai-compatible",
      "  baseUrl: http://localhost:8090/v1",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/classifier\.port 8090 is already used by web_voice/);
  });

  // The reverse pairing too: the reply model behind a URL, the classifier on a
  // bare port. One seat, named two ways.
  test("an llm baseUrl is resolved to the same seat as a classifier port", () => {
    expect(loadYaml([
      "llm:",
      "  backend: openai-compatible",
      "  baseUrl: http://127.0.0.1:8080/v1",
      "  model: big-reply-model",
      "classifier:",
      "  backend: llama-cpp",
      "  port: 8080",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/same endpoint as llm \(127\.0\.0\.1:8080\)/);
  });

  // A genuinely remote URL still binds nothing here.
  test("a remote classifier baseUrl is not compared against local ports", () => {
    expect(() => loadYaml([
      "web_voice:",
      "  enabled: true",
      "  port: 8090",
      "  token: a-token-that-is-long-enough",
      "classifier:",
      "  backend: openai-compatible",
      "  baseUrl: https://classifier.example/v1",
      "  model: small-classifier-model",
      "",
    ].join("\n"))()).not.toThrow();
  });

  // Round 8 (Codex): only the OpenAI-compatible family reads baseUrl. LlamaCpp
  // selects host/port and ignores it, so a classifier carrying baseUrl was
  // validated against an endpoint the runtime never contacts — it actually
  // targeted 8080 and adopted the reply server. Refusing the key beats
  // mirroring a setting that silently does nothing.
  test("a baseUrl on a backend that ignores it is refused, not silently honoured", () => {
    expect(loadYaml([
      "classifier:",
      "  backend: llama-cpp",
      "  baseUrl: http://127.0.0.1:8093/v1",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/classifier\.baseUrl is set but the 'llama-cpp' backend ignores it/);
  });

  test("the same key on an OpenAI-compatible backend stays valid", () => {
    expect(() => loadYaml([
      "classifier:",
      "  backend: openai-compatible",
      "  baseUrl: http://127.0.0.1:8093/v1",
      "  model: small-classifier-model",
      "",
    ].join("\n"))()).not.toThrow();
  });

  // Round 8 (Codex): a shared endpoint only forces one model when it is one
  // model server. A cloud API multiplexes, and a cheap classifier beside an
  // expensive reply model on the same API is the ordinary way to run this.
  test("two cloud roles on one API with different models is allowed", () => {
    expect(() => loadYaml([
      "llm:",
      "  backend: openai",
      "  baseUrl: https://api.openai.com/v1",
      "  model: gpt-4.1",
      "classifier:",
      "  backend: openai",
      "  baseUrl: https://api.openai.com/v1",
      "  model: gpt-4.1-mini",
      "",
    ].join("\n"))()).not.toThrow();

    // And with the URLs left implicit, which resolves to the same endpoint.
    expect(() => loadYaml([
      "llm:",
      "  backend: openai",
      "  model: gpt-4.1",
      "classifier:",
      "  backend: openai",
      "  model: gpt-4.1-mini",
      "",
    ].join("\n"))()).not.toThrow();
  });

  // Round 10 (Codex): an ollama server SELECTS a model per request, so two
  // roles sharing one is not a conflict at all -- it is how you run a small
  // classifier beside a large reply model on one server. Refusing it was wrong,
  // including the plainest case of all: neither role naming a model, both
  // resolving to the same default.
  test("sharing an ollama server without naming the classifier model is accepted", () => {
    expect(() => loadYaml([
      "llm:",
      "  backend: ollama",
      "  port: 11434",
      "  model: big-reply-model",
      "classifier:",
      "  backend: ollama",
      "  port: 11434",
      "",
    ].join("\n"))()).not.toThrow();
  });

  test("two ollama roles that both take the default model are accepted", () => {
    expect(() => loadYaml([
      "llm:",
      "  backend: ollama",
      "  port: 11434",
      "classifier:",
      "  backend: ollama",
      "  port: 11434",
      "",
    ].join("\n"))()).not.toThrow();
  });

  // A local vLLM or llama-swap multiplexes by model exactly like a cloud API
  // does. Treating loopback as single-model on its own rejected a setup this
  // repo explicitly supports.
  test("a local OpenAI-compatible server may serve both roles with different models", () => {
    expect(() => loadYaml([
      "llm:",
      "  backend: openai-compatible",
      "  baseUrl: http://127.0.0.1:8000/v1",
      "  model: big-reply-model",
      "classifier:",
      "  backend: openai-compatible",
      "  baseUrl: http://127.0.0.1:8000/v1",
      "  model: small-classifier-model",
      "",
    ].join("\n"))()).not.toThrow();
  });

  // Round 12 (Codex): sharedEndpoint compared host strings literally, so
  // localhost:8080 and 127.0.0.1:8080 read as two different endpoints -- the
  // deliberate share went unrecognised and the collision check then reported
  // the config as clashing with llm. They are one seat: the classifier's health
  // probe adopts the server llama.cpp already launched there.
  test("loopback aliases are one endpoint, not a collision", () => {
    expect(() => loadYaml([
      "llm:",
      "  backend: llama-cpp",
      "  host: localhost",
      "  port: 8080",
      "  model: one-model-for-both",
      "classifier:",
      "  backend: llama-cpp",
      "  host: 127.0.0.1",
      "  port: 8080",
      "  model: one-model-for-both",
      "",
    ].join("\n"))()).not.toThrow();
  });

  // The alias must be recognised for refusals too, not just for permission.
  test("a loopback-alias share still refuses a second model", () => {
    expect(loadYaml([
      "llm:",
      "  backend: llama-cpp",
      "  host: localhost",
      "  port: 8080",
      "  model: big-reply-model",
      "classifier:",
      "  backend: llama-cpp",
      "  host: 127.0.0.1",
      "  port: 8080",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/it serves one model/);
  });

  // Round 12 (Codex): sharing an endpoint with no classifier model is harmless
  // on ollama, whose default is a small model it loads locally. It is NOT
  // harmless on an OpenAI-compatible backend, whose default is a hosted name a
  // local server has never heard of -- every classification then fails, and the
  // judge fails OPEN, so the classifier reports healthy and vetoes nothing.
  test("a shared OpenAI-compatible endpoint with no classifier model is refused", () => {
    const failure = loadYaml([
      "llm:",
      "  backend: openai-compatible",
      "  baseUrl: http://127.0.0.1:8000/v1",
      "  model: reply-model",
      "classifier:",
      "  backend: openai-compatible",
      "  baseUrl: http://127.0.0.1:8000/v1",
      "",
    ].join("\n"));
    expect(failure).toThrow(/would request 'gpt-4o-mini'/);
    // It names the model that endpoint actually serves, so the fix is obvious.
    expect(failure).toThrow(/reply-model/);
  });

  test("naming the shared OpenAI-compatible model is accepted", () => {
    expect(() => loadYaml([
      "llm:",
      "  backend: openai-compatible",
      "  baseUrl: http://127.0.0.1:8000/v1",
      "  model: reply-model",
      "classifier:",
      "  backend: openai-compatible",
      "  baseUrl: http://127.0.0.1:8000/v1",
      "  model: reply-model",
      "",
    ].join("\n"))()).not.toThrow();
  });

  // The refusal is about a PROVABLE mismatch, which only the shared case gives.
  // A standalone endpoint may be a proxy that does serve the default.
  test("a standalone OpenAI-compatible classifier with no model is left alone", () => {
    expect(() => loadYaml([
      "llm:",
      "  backend: llama-cpp",
      "  port: 8080",
      "classifier:",
      "  backend: openai-compatible",
      "  baseUrl: http://127.0.0.1:8000/v1",
      "",
    ].join("\n"))()).not.toThrow();
  });

  // A single-model server is still a single-model server: llama-server loads
  // one model and the request's `model` field is informational.
  test("a shared llama-cpp server naming a second model is still refused", () => {
    expect(loadYaml([
      "llm:",
      "  backend: llama-cpp",
      "  port: 8080",
      "  model: big-reply-model",
      "classifier:",
      "  backend: llama-cpp",
      "  port: 8080",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/it serves one model/);
  });

  // One port, two DIFFERENT servers this daemon launches: whichever loses the
  // race is adopted by the other, which then speaks the wrong protocol to it.
  test("a shared port with a launched server on one side and a different backend is refused", () => {
    expect(loadYaml([
      "llm:",
      "  backend: llama-cpp",
      "  port: 11434",
      "  model: big-reply-model",
      "classifier:",
      "  backend: ollama",
      "  port: 11434",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/names a different backend/);
  });

  test("naming the shared ollama model explicitly is accepted", () => {
    expect(() => loadYaml([
      "llm:",
      "  backend: ollama",
      "  port: 11434",
      "  model: big-reply-model",
      "classifier:",
      "  backend: ollama",
      "  port: 11434",
      "  model: big-reply-model",
      "",
    ].join("\n"))()).not.toThrow();
  });

  // llama-cpp serves the one model it loaded and treats the field as
  // informational, so dropping it there really does share — that remediation is
  // unchanged, and the message must not start recommending the ollama one.
  test("the llama-cpp remediation still says to drop the model", () => {
    expect(loadYaml([
      "llm:",
      "  backend: llama-cpp",
      "  port: 8080",
      "  model: big-reply-model",
      "classifier:",
      "  backend: llama-cpp",
      "  port: 8080",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/drop classifier\.model to share the reply model/);
  });

  // A listener that is off binds nothing, so it is not in the way.
  test("a disabled listener does not reserve its default port", () => {
    expect(() => loadYaml([
      "tone:",
      "  enabled: false",
      "classifier:",
      "  backend: llama-cpp",
      "  port: 8091",
      "  model: small-classifier-model",
      "",
    ].join("\n"))()).not.toThrow();
  });

  // Round 5 (Codex): a REMOTE peer starts no local process, so its port is not
  // occupied on this box — refusing that config blocked a legitimate setup.
  test("a local classifier may reuse the port number of a remote llm", () => {
    expect(() => loadYaml([
      "llm:",
      "  backend: llama-cpp",
      "  host: 192.0.2.10",
      "  port: 8080",
      "  model: big-reply-model",
      "classifier:",
      "  backend: llama-cpp",
      "  host: 127.0.0.1",
      "  port: 8080",
      "  model: small-classifier-model",
      "",
    ].join("\n"))()).not.toThrow();
  });

  // But the same REMOTE seat shared by both roles is still one server with one
  // model loaded, wherever it runs.
  test("two roles sharing one remote server with different models is refused", () => {
    expect(loadYaml([
      "llm:",
      "  backend: llama-cpp",
      "  host: 192.0.2.10",
      "  port: 8080",
      "  model: big-reply-model",
      "classifier:",
      "  backend: llama-cpp",
      "  host: 192.0.2.10",
      "  port: 8080",
      "  model: small-classifier-model",
      "",
    ].join("\n"))).toThrow(/same endpoint as llm \(192\.0\.2\.10:8080\)/);
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

  test("rejects a non-boolean speculative side-effect opt-in", () => {
    // A mistyped value fails closed (speculation stays off), so report it
    // rather than let the operator believe the opt-in took effect.
    expect(loadYaml([
      "web_voice:",
      "  speculative:",
      "    allow_tool_brains: yes-please",
      "",
    ].join("\n"))).toThrow(/allow_tool_brains/);
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

  // Codex: every consumer appends a path to a base URL by concatenation, so
  // `https://api.example/v1?token=abc` became
  // `https://api.example/v1?token=abc/chat/completions` — real path `/v1`, token
  // `abc/chat/completions`. The intended endpoint was never requested, and it
  // read like a broken provider rather than a mis-set URL.
  test("rejects a base URL carrying a query string or fragment", () => {
    expect(loadYaml([
      "brain:",
      "  backend: openai-compatible",
      "  base_url: https://api.example/v1?token=abc",
      "",
    ].join("\n"))).toThrow(/brain\.base_url must not carry a query string/);

    expect(loadYaml([
      "brain:",
      "  backend: openai-compatible",
      "  base_url: https://api.example/v1#frag",
      "",
    ].join("\n"))).toThrow(/brain\.base_url must not carry a fragment/);
  });

  // The same validator guards every base URL, so the fix holds for all of them
  // rather than only the summarizer the finding happened to cite.
  test("the query rejection covers every configured base URL", () => {
    expect(loadYaml([
      "brain:",
      "  history_compaction:",
      "    summarizer_url: http://x:1/v1?token=abc",
      "web_voice:",
      "  tldr:",
      "    summarizer_url: http://x:1/v1?key=abc",
      "",
    ].join("\n"))).toThrow(
      /brain\.history_compaction\.summarizer_url must not carry a query string[\s\S]*web_voice\.tldr\.summarizer_url must not carry a query string/,
    );
  });

  // The offending value is exactly the kind of URL that carries a credential.
  test("the rejection never echoes the URL it refused", () => {
    const failure = loadYaml([
      "brain:",
      "  backend: openai-compatible",
      "  base_url: https://api.example/v1?token=SYNTHETIC_SECRET_VALUE",
      "",
    ].join("\n"));
    expect(failure).toThrow(/must not carry a query string/);
    expect(failure).not.toThrow(/SYNTHETIC_SECRET_VALUE/);
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
      "  briefing: { at: '8am', catch_up_minutes: 721 }",
      "  call_minutes: { min_minutes: -1 }",
      "  kanban:",
      "    interval_seconds: 0",
      "    command: []",
      "",
    ].join("\n"))).toThrow(
      /notify\.timezone[\s\S]*notify\.quiet_hours\.from[\s\S]*notify\.briefing\.at[\s\S]*notify\.briefing\.catch_up_minutes[\s\S]*notify\.kanban\.interval_seconds[\s\S]*notify\.kanban\.command[\s\S]*notify\.call_minutes\.min_minutes/,
    );
    expect(loadYaml("notify:\n  briefing: { at: '08:30', catch_up_minutes: 0 }\n")).not.toThrow();
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

describe("Config — dictation", () => {
  test("accepts the documented shape", () => {
    expect(loadYaml([
      "dictation:",
      "  enabled: true",
      "  target: cicero",
      "  max_recording_seconds: 300",
    ].join("\n"))).not.toThrow();
  });

  test("rejects a mistyped target rather than silently dropping every transcript", () => {
    expect(loadYaml("dictation:\n  target: ciceroo")).toThrow(/dictation.target must be/);
  });

  test("rejects an unknown dictation key", () => {
    expect(loadYaml("dictation:\n  enbaled: true")).toThrow(/dictation.enbaled is not supported/);
  });

  test("rejects a nonsensical recording ceiling", () => {
    expect(loadYaml("dictation:\n  max_recording_seconds: 0")).toThrow(/max_recording_seconds/);
  });

  // Removing config keys must not stop an existing operator's daemon from booting.
  test("tolerates the retired wispr keys so an existing config still starts", () => {
    expect(loadYaml('wake_word_enabled: false\nwispr_hotkey: "option+space"')).not.toThrow();
  });
});
