# Configuration

Config lives at `~/.cicero/config.yaml`. CLI flags override config file values. Start from [`config.yaml.example`](../config.yaml.example) — it documents every block — and run `cicero doctor` after editing to verify the whole chain.

## Deployment tier (one line, everything else inferred)

```yaml
# Mac (default — no config needed, MLX everywhere)

deployment: local-cuda    # RTX 30/40/50 series
deployment: local-cpu     # CPU only
```

## Full example

```yaml
tts_enabled: true
wake_word_enabled: false # legacy name: enables the macOS Wispr Flow listener, not acoustic wake-word detection
hotkey: "ctrl+shift+space" # the current macOS helper supports only this fixed chord
terminal: auto            # auto-detect; or kitty | tmux | wezterm | none
voice: default
barge_in_enabled: false

brain:
  backend: claude-code
  mode: tab-inject
  target_tab: "cicero-brain"

# Explicit backend config (overrides tier defaults):
stt:
  backend: faster-whisper
  port: 8083
  model: Systran/faster-whisper-large-v3-turbo
  timeout_ms: 90000
tts:
  backend: kokoro
  port: 8082
  voice: am_onyx
  timeout_ms: 60000
llm:
  backend: ollama
  port: 11434
  model: qwen3.5:0.8b
  timeout_ms: 120000
```

Computer-use file tools default to the daemon's working directory, and public
LLMs are refused unless data egress is explicitly enabled:

```yaml
compute:
  root: /path/to/allowed/workspace
  max_read_bytes: 262144
  allow_cloud: false
```

`timeout_ms` is an absolute request lifetime, including upload, response headers,
and body consumption. Defaults are 90 seconds for STT, 60 seconds for TTS, 120
seconds for LLM completions, 10 seconds for Smart-Turn, and 5 seconds for tone.
Configured deadlines must be whole milliseconds from 1 through 900000 (15 minutes).
Health probes use a fixed 5-second deadline. Successful JSON is capped at 8 MiB,
audio at 64 MiB, and diagnostic error prefixes at 16 KiB; streamed LLM tokens
remain incremental rather than being buffered into the JSON cap.

## Default model stack

### macOS 14+ on Apple Silicon (MLX, default)

| Component | Model | Size |
|---|---|---|
| Router | Qwen3.5-0.8B-MLX-4bit | 0.8B |
| TTS | Qwen3-TTS-12Hz-0.6B-Base | 0.6B |
| STT | Whisper large-v3-turbo (MLX) | 809M |
| Brain | Claude Code | n/a |

### CUDA (`deployment: local-cuda`)

| Component | Model | VRAM |
|---|---|---|
| Router | Qwen3.5-4B GGUF via llama.cpp `llama-server` | ~2.5 GB |
| TTS | Kokoro-82M via Kokoro-FastAPI (`am_onyx` voice) | ~1 GB |
| STT | Whisper large-v3-turbo via faster-whisper | ~3 GB |
| Brain | Claude Code | n/a |
| **Total** |  | **~6.5 GB** |

All models run locally. No API keys are required. The `local-cuda` preset keeps
the configured backend as `llama-cpp`: Cicero launches `llama-server` with its
Hugging Face GGUF model ID (or an explicit `.gguf` path), and does not route
through Ollama. Install llama.cpp's `llama-server` on `PATH`; repository models
download on first launch. TTS alternatives (cloning engines, fallback chains)
are in [voice cloning](voice-cloning.md); brain backends in [brains](brains.md).

## Quick intents — your own zero-latency phrases

Switchboard transfers, think-lane triggers, and "details" expansion are all zero-latency *lexical fast-paths*: pattern-matched before the brain ever sees the turn, so the response starts in microseconds. That layer is open to you — map your own phrases (or regexes) to instant spoken answers, with misses always falling through to the model (the pattern layer accelerates, never blocks). `{time}` and `{date}` expand at match time:

```yaml
quick_intents:
  - phrases: ["what time is it", "time check"]
    reply: "It's {time}."
  - pattern: "^ping\\b"
    reply: "Pong. All systems up."
```

It's also the natural place to encode phrasings for your language, accent, or STT's quirks as pure YAML edits — contributions welcome.

## Custom voice actions

**User-configurable via `~/.cicero/actions.yaml`:** custom voice actions that map an utterance pattern to a shell command. Example stubs ship in `src/config.ts` for "check slack" and "calendar today" — wire these up to your own `slack-cli` / `calendar-cli` scripts to make them work. They're documentation-by-example, not built-in features.

```yaml
actions:
  search_notes:
    category: cli
    command: "notes search {query} | head -20"
    tts_mode: summary
    examples: ["search notes for {query}"]
    timeout_s: 90        # optional; default 30, maximum 3600
    output_limit: 131072 # optional bytes per stream; default 65536, max 1048576
```

Commands are operator-authored shell programs, so trusted syntax such as pipelines and redirects works normally. Values captured from speech or a router use `{name}` placeholders. Cicero passes each value as a quoted positional argument rather than inserting it into shell source, so spaces, quotes, newlines, command substitutions, and separators remain literal data. Placeholders can be unquoted as above; existing single- or double-quoted placeholders are also supported. Use `\{name}` when the command needs a literal placeholder-like string. Run logs and brain context show the template plus escaped bindings for debuggability; bindings whose names look like credentials, passwords, secrets, or tokens are redacted.

Every command has an absolute wall-clock deadline and bounded stdout/stderr.
Use `timeout_s` for a legitimately long-running custom action and
`output_limit` when it needs more retained diagnostic or result bytes. Both
values are validated at startup and on hot reload; unsafe, non-finite, or
out-of-range limits are rejected instead of weakening the process boundary.

Built-in actions: focus tab, list tabs.

## Validation and startup failures

Cicero validates configuration before it starts providers, subprocesses, listeners, or network servers. Malformed YAML, wrong value types, invalid ports, unknown deployment tiers, and malformed actions stop startup with the config path and every detected issue. Unknown STT, TTS, and LLM backend names also fail closed; Cicero never substitutes a different provider for a misspelled name.
