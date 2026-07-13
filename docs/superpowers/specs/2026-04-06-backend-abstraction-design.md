# Backend Abstraction & Cross-Platform Support

> **Historical design record:** planned providers and configuration snippets here are not an operator reference. In particular, proposed cloud STT fields were never implemented and are rejected by the current strict schema.

**Date:** 2026-04-06
**Status:** Draft — updated with deep research findings
**Goal:** Decouple Cicero from MLX-only backends so it runs on macOS (MLX), Windows native (CUDA), Linux (CUDA/CPU), and cloud APIs — without breaking existing behavior.

---

## Principles

- **Zero breaking changes.** Existing Mac users with no config changes get identical behavior.
- **Providers own their lifecycle.** Each backend knows how to start, health-check, and stop itself.
- **Config-driven.** Backend selection via YAML. Tier presets for convenience, per-component overrides for power users.
- **Platform abstraction for OS-specific bits.** Audio playback, audio recording, and terminal control are abstracted per-OS.
- **MLX stays the Mac default.** Raw MLX is faster than Ollama on Apple Silicon for small models. Ollama is the cross-platform option where MLX isn't available.

---

## 1. Backend Provider Interfaces

Three interfaces, one per ML component. Each provider encapsulates API communication and optional server lifecycle.

### STTProvider

```typescript
// src/backends/stt/provider.ts
export interface STTProviderConfig {
  port?: number;
  model?: string;
  apiKey?: string;       // for cloud backends (Deepgram)
  [key: string]: unknown; // backend-specific options
}

export interface STTProvider {
  readonly name: string;
  /** File-based transcription — record to WAV, then transcribe. */
  transcribe(audioFile: string): Promise<string | null>;
  health(): Promise<boolean>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
```

**Note on streaming STT:** The `transcribe()` interface is file-based (record → transcribe), which is how Cicero works today. Nemotron Speech 0.6B achieves 24ms *because* it streams audio chunks — feeding it a completed WAV negates most of that advantage. A streaming interface (`transcribeStream(chunks)`) is a future enhancement that would require reworking the listen loop in `ConversationalListener`. For Phase 1, file-based is correct and faster-whisper is the better CUDA default since it's optimized for batch transcription with a mature HTTP server.

Implementations:
- `mlx-whisper.ts` — extracted from `ConversationalListener.transcribe()`. Posts FormData to `http://localhost:{port}/inference`. Current default on Mac.
- `faster-whisper.ts` — **Primary CUDA backend.** faster-whisper + Whisper Large-v3-Turbo: 60-150ms on 5090, mature ecosystem with existing HTTP server (`faster-whisper-server`), battle-tested. ~3GB VRAM.
- `nemotron.ts` — **Future streaming CUDA backend.** NVIDIA Nemotron Speech 0.6B: 24ms streaming on RTX 5090, purpose-built for voice agents, open weights. English-only. Requires NeMo or custom HTTP wrapper (no turnkey server). ~3GB VRAM. **Blocked until streaming STT interface is added in a future phase.**
- `moonshine.ts` — **CPU backend.** Moonshine v2: 250M params, 107ms on CPU, beats Whisper accuracy. Best for Mac Mini / edge / no-GPU deployments.
- `deepgram.ts` — **Cloud API.** Deepgram Nova-3: <300ms streaming, $0.0043/min (~$0.10/mo at terminal assistant volume). Best cloud fallback.

### TTSProvider

```typescript
// src/backends/tts/provider.ts
export interface TTSProviderConfig {
  port?: number;
  model?: string;
  voice?: string;
  refAudio?: string;     // voice cloning reference
  refText?: string;
  apiKey?: string;       // for cloud backends
  [key: string]: unknown;
}

export interface TTSProvider {
  readonly name: string;
  generateAudio(text: string): Promise<ArrayBuffer>;
  health(): Promise<boolean>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
```

Implementations:
- `mlx-audio.ts` — extracted from `TTSSpeaker.generateAudio()`. Posts JSON to `http://localhost:{port}/v1/audio/speech`. Current default on Mac.
- `kokoro.ts` — **Primary CUDA backend.** Kokoro-82M via Kokoro-FastAPI: 50-100ms TTFA, ~1GB VRAM, OpenAI-compatible `/v1/audio/speech` endpoint (drop-in), #1 open-source TTS Arena (Elo-based blind pairwise, independently verified). 21 preset voices including `am_onyx` (deep/authoritative — Jarvis-like). No voice cloning but voice blending supported. Best latency + proven quality.
- `vibevoice.ts` — **CUDA cloning option.** VibeVoice-Realtime-0.5B: ~150ms TTFA on 5090 (est.), ~2GB VRAM, zero-shot voice cloning from 10-60s ref, streaming architecture (first audio while generating rest). OpenAI-compat server exists (marhensa/vibevoice-realtime-openai-api). MIT license. Microsoft-backed, quality lineage proven (user has tested 7B/9B first-hand). Use when `voice_ref_audio` is configured.
- `omnivoice.ts` — **Future option.** OmniVoice: claimed SIM-o 0.741 but self-reported, repo is days old, has digit pronunciation bugs and accent bleed (confirmed unfixable by author). ~7GB+ VRAM (not 4-6GB as claimed). Community HTTP wrapper exists (pasadei/OmniVoice-local). Wait for maturity.
- `pocket-tts.ts` — **CPU backend.** Pocket-TTS (Kyutai Labs): 100M params, 6x RT on CPU, voice cloning from 5-20s ref, Apache-2.0. Best for Mac Mini / edge.
- `elevenlabs.ts` — **Cloud API.** ~75ms TTFA, best expressiveness (emotion/whisper/laugh), $22/mo.
- `voxtral.ts` — **Cloud API alternative.** Voxtral API: $0.016/1K chars, 70ms streaming, voice cloning from 3s. Self-hostable via vLLM-Omni but tooling is immature (March 2026 release).

### LLMProvider

```typescript
// src/backends/llm/provider.ts
export interface LLMProviderConfig {
  port?: number;
  model?: string;
  apiKey?: string;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMCompletionOpts {
  temperature?: number;
  max_tokens?: number;
  /** JSON schema constraint for structured output. Ollama uses XGrammar
   *  to enforce 100% compliance at <40µs/token overhead. MLX provider
   *  ignores this (relies on prompt-based JSON extraction). */
  responseFormat?: {
    type: "json_schema";
    json_schema: Record<string, unknown>;
  };
}

export interface LLMProvider {
  readonly name: string;
  chatCompletion(messages: ChatMessage[], opts?: LLMCompletionOpts): Promise<string>;
  health(): Promise<boolean>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
```

Implementations:
- `mlx-lm.ts` — extracted from `LLMRouter`'s direct fetch calls. Posts to `http://localhost:{port}/v1/chat/completions`. Current default on Mac. Uses Qwen3.5-0.8B.
- `ollama.ts` — **Cross-platform.** Same OpenAI-compatible endpoint on Ollama's port (default 11434). Uses CUDA on NVIDIA, CPU elsewhere. 15-30ms overhead vs raw inference — negligible in full voice pipeline. **Default model: Qwen3-1.7B** (better instruction following than Qwen2.5-0.8B, ~1.1GB VRAM). **Must use structured output** (`format: { type: "json_schema", json_schema: {...} }`) — Ollama's XGrammar gives 100% JSON compliance at <40µs/token overhead. This is the single biggest reliability win.
- `claude-api.ts` — cloud API. For complex tasks / brain escalation.

### Design note: LLMProvider vs Router

`LLMProvider` is lower-level than `Router`. It's "send messages, get text." The `LLMRouter` class keeps its prompt-building logic (`buildSystemPrompt`) and response parsing (`parseResponse`) — it just calls `this.provider.chatCompletion()` instead of `fetch()` directly. The `summarizeForTTS` method in `daemon.ts` also uses the same `LLMProvider`, eliminating a second hard-coded endpoint.

---

## 2. Registry & Tier Presets

### Registry

A factory module that reads config and returns concrete providers. Deterministic switch statements, no dynamic loading.

```typescript
// src/backends/registry.ts
export interface BackendProviders {
  stt: STTProvider;
  tts: TTSProvider;
  llm: LLMProvider;
}

export function createProviders(config: RuntimeConfig): BackendProviders {
  return {
    stt: createSTTProvider(config),
    tts: createTTSProvider(config),
    llm: createLLMProvider(config),
  };
}

function createSTTProvider(config: RuntimeConfig): STTProvider {
  const sttConfig = config.stt;
  switch (sttConfig.backend) {
    case "mlx-whisper":     return new MlxWhisperProvider(sttConfig);
    case "faster-whisper":  return new FasterWhisperProvider(sttConfig);
    case "deepgram":        return new DeepgramProvider(sttConfig);
    default:                return new MlxWhisperProvider(sttConfig);
  }
}
// Same pattern for createTTSProvider, createLLMProvider
```

### Tier Presets

Named presets that expand to per-component config. A lookup table, not a framework.

```typescript
// src/backends/tiers.ts
export const TIER_PRESETS: Record<string, TierConfig> = {
  "local-mlx": {
    stt:      { backend: "mlx-whisper" },
    tts:      { backend: "mlx-audio" },
    llm:      { backend: "mlx-lm" },
    terminal: "kitty",
  },
  "local-cuda": {
    stt:      { backend: "faster-whisper", port: 8083, model: "Systran/faster-whisper-large-v3-turbo" },
    tts:      { backend: "kokoro", port: 8082 },
    llm:      { backend: "ollama", port: 11434, model: "qwen3:1.7b" },
    terminal: "tmux",
  },
  "local-cpu": {
    stt:      { backend: "moonshine", model: "moonshine-v2-medium" },
    tts:      { backend: "kokoro" },
    llm:      { backend: "ollama", port: 11434, model: "qwen3:1.7b" },
    terminal: "tmux",
  },
  "hybrid": {
    stt:      { backend: "deepgram" },
    tts:      { backend: "kokoro", port: 8082 },  // local even in hybrid (only 1GB VRAM)
    llm:      { backend: "ollama", port: 11434, model: "qwen3:1.7b" },
    terminal: "tmux",
  },
  "cloud": {
    stt:      { backend: "deepgram" },
    tts:      { backend: "elevenlabs" },
    llm:      { backend: "claude-api" },
    terminal: "tmux",
  },
};
```

### Config Resolution Order

1. Tier preset expands (if `deployment` key is set) — this populates both backend fields (`stt`/`tts`/`llm`) AND the `terminal` field in `CiceroConfig`
2. Per-component `stt`/`tts`/`llm`/`terminal` fields override tier values
3. Legacy `servers.*` config used as fallback if no `stt`/`tts`/`llm` fields present (backward compat)
4. Built-in defaults (MLX on everything, kitty on Mac/Linux, tmux on Windows)

Note: `BackendProviders` is `{ stt, tts, llm }` only. Terminal is resolved separately by the config system and passed to `createTerminalAdapter()`. Tier presets set both, but they flow through different paths.

### Example Configs

```yaml
# Existing config (works unchanged, resolves to MLX everything):
servers:
  router:
    port: 8081
    model: mlx-community/Qwen3.5-0.8B-MLX-4bit
  tts:
    port: 8082
    model: mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16
  stt:
    port: 8083
    model: mlx-community/whisper-large-v3-turbo

# 5090 workstation (one line switches everything):
deployment: local-cuda

# 5090 with cloud TTS override:
deployment: local-cuda
tts:
  backend: elevenlabs
  api_key_env: ELEVENLABS_API_KEY

# Mac Mini client appliance:
deployment: hybrid
```

---

## 3. Server Lifecycle

### Managed Server Utility

Extracted from `ServerManager.startServer()`. Reusable by any provider that needs to spawn and health-check a process.

```typescript
// src/backends/managed-server.ts
export interface ManagedProcess {
  proc: ReturnType<typeof Bun.spawn> | null;
  containerId?: string;  // for Docker-managed servers
  port: number;
  managed: boolean; // true = we spawned it, false = was already running
  mode: "process" | "docker";
}

export async function startManagedServer(opts: {
  name: string;
  port: number;
  command: string[];
  healthUrl: string;
  timeoutMs?: number;   // default 60000
  intervalMs?: number;  // default 1000
  mode?: "process" | "docker";  // default "process"
}): Promise<ManagedProcess | null>
```

Logic (extended from current `ServerManager.startServer()`):
1. Check if something is already healthy on the port → return `{ managed: false }`
2. Check if the binary/module exists → warn and return null if missing
3. Spawn the process:
   - `mode: "process"` (default) — `Bun.spawn(command)`, same as current behavior
   - `mode: "docker"` — `Bun.spawn(["docker", "run", "-d", "-p", ...])`, capture container ID
4. Poll health URL until healthy or timeout
5. Return `{ managed: true }` or warn "continuing in degraded mode"

Stop behavior varies by mode:
- `process` → `proc.kill()` (current behavior)
- `docker` → `Bun.spawn(["docker", "stop", containerId])`

**Preferred approach:** Run backends via native Python where possible (Kokoro-FastAPI, LuxTTS both support `pip install` + direct run). Docker is the fallback for backends with complex dependency chains. Each provider decides its own mode — the managed server utility supports both.

### Provider Lifecycle

Each provider's optional `start()` method calls `startManagedServer()` with its own command:

- `MlxWhisperProvider.start()` → spawns `python3 servers/stt_server.py --port 8083 --model ...`
- `MlxLmProvider.start()` → spawns `python3 -m mlx_lm.server --port 8081 --model ...`
- `FasterWhisperProvider.start()` → spawns `faster-whisper-server --port 8083 --model ...` (pip install, native Python)
- `NemotronProvider.start()` → **Future phase.** Requires custom HTTP wrapper around NeMo RNNT decoder — more build work than other providers
- `OllamaProvider.start()` → spawns `ollama serve` (or detects it's already running as a system service)
- `LuxTTSProvider.start()` → spawns native Python server (pip install), or Docker fallback
- `KokoroProvider.start()` → spawns native Python server (pip install), or Docker fallback
- `PocketTTSProvider.start()` → spawns Python HTTP wrapper (no official server yet)
- `DeepgramProvider` → no `start()` method (cloud API, nothing to spawn)
- `ElevenLabsProvider` → no `start()` method (cloud API)

### ServerManager Refactor

Becomes a thin coordinator that iterates providers:

```typescript
export class ServerManager {
  async start(providers: BackendProviders): Promise<void> {
    for (const provider of [providers.llm, providers.tts, providers.stt]) {
      if (provider.start) await provider.start();
    }
  }

  async stop(providers: BackendProviders): Promise<void> {
    for (const provider of [providers.stt, providers.tts, providers.llm]) {
      if (provider.stop) await provider.stop();
    }
  }
}
```

Pre-warming moves into each provider's `start()` — `MlxAudioProvider` sends its warm-up request, `MlxWhisperProvider` sends its silent WAV, other providers warm up differently or not at all.

---

## 4. Platform Abstraction

### Audio Playback

```typescript
// src/platform/audio.ts
export interface AudioPlayer {
  play(filePath: string): Promise<void>;
  stopAll(): void;
}

export interface AudioRecorder {
  record(outPath: string, opts: RecordOpts): ReturnType<typeof Bun.spawn>;
}

export interface RecordOpts {
  sampleRate?: number;       // default 16000
  silenceDuration?: string;  // default "1.5"
  silenceThreshold?: string; // default "3%"
  maxDuration?: number;      // default 30
}

export function createAudioPlayer(): AudioPlayer {
  switch (process.platform) {
    case "darwin": return new MacAudioPlayer();     // afplay
    case "linux":  return new LinuxAudioPlayer();   // paplay / aplay
    case "win32":  return new WindowsAudioPlayer(); // ffplay (NOT PowerShell SoundPlayer)
    default:       return new LinuxAudioPlayer();
  }
}

export function createAudioRecorder(): AudioRecorder {
  // sox `rec` works on all platforms (available via brew, apt, scoop/choco)
  // Windows fallback: ffmpeg -f dshow for audio capture
  switch (process.platform) {
    case "win32":  return new WindowsAudioRecorder();
    default:       return new SoxAudioRecorder(); // mac + linux
  }
}
```

Implementations:
- `audio-macos.ts` — `afplay` for playback (~50-150ms to first sound), `pkill -f afplay` for stop. Extracted from current `TTSSpeaker`.
- `audio-linux.ts` — `aplay` preferred for lowest latency (~45ms direct ALSA), `paplay` as PulseAudio fallback (~70-90ms). `pkill` for stop.
- `audio-windows.ts` — `ffplay -nodisp -autoexit -audio_buffer_size 64` for playback (~100-200ms). NOT PowerShell SoundPlayer (200-500ms startup due to PS init overhead).
- `recorder-sox.ts` — Current sox `rec` command. Works on Mac and Linux unchanged. On Linux, `arecord` is lower latency (~45ms vs ~70ms) but sox provides silence detection which Cicero relies on.
- `recorder-windows.ts` — sox via `winget install ChrisBagwell.SoX` (note: no `rec` symlink on Windows, use `sox -d` instead). Fallback: `ffmpeg -f dshow -audio_buffer_size 64` for capture.

**Future option:** `micstream` npm package wraps PortAudio as N-API addon with pre-built binaries for Windows/Mac/Linux. If it works in Bun (N-API is documented as supported), it eliminates subprocess overhead entirely (~10-20ms native capture vs ~50-200ms subprocess). Worth testing but not blocking.

### Injection Points

- `TTSSpeaker` constructor takes `AudioPlayer` instead of calling `afplay` directly
- `StreamingTTSSpeaker` same
- `ConversationalListener` constructor takes `AudioRecorder` and `AudioPlayer` (for earcons)

---

## 5. Terminal Abstraction

### Platform Defaults

```
macOS:   kitty (existing) → tmux fallback
Linux:   kitty → tmux fallback
Windows: tmux (primary)
```

WezTerm available via explicit `terminal: wezterm` config but not a default (stalled project, nightly-only releases since Feb 2024).

### Implementations

```
src/terminal/
  index.ts          — factory with platform-aware defaults
  kitty.ts          — existing, unchanged
  tmux.ts           — new, universal fallback
  wezterm.ts        — new, opt-in for users who want it
```

### tmux Adapter API Mapping

| TerminalAdapter method | tmux command |
|----------------------|-------------|
| `listTabs()` | `tmux list-windows -F '#{window_id}\t#{window_name}\t#{window_active}\t#{pane_current_path}'` |
| `focusTab(name)` | `tmux select-window -t :{name}` |
| `sendText(tab, text)` | `tmux send-keys -t :{tab} '{text}' Enter` |
| `sendKey(tab, key)` | `tmux send-keys -t :{tab} {key}` |
| `getText(tab)` | `tmux capture-pane -t :{tab} -p` |

### Config

```yaml
terminal: kitty    # explicit choice
# or
terminal: tmux     # cross-platform
# or
terminal: wezterm  # opt-in
# or omit — platform default applies
```

Tier presets set terminal per platform:
- `local-mlx` → kitty
- `local-cuda` → tmux (Windows-friendly default)
- `hybrid` → tmux
- `cloud` → tmux

---

## 6. Modified Files (Surgical Changes)

### `src/types.ts`
- Add `STTBackendConfig`, `TTSBackendConfig`, `LLMBackendConfig` types
- Extend `CiceroConfig` with optional `deployment`, `stt`, `tts`, `llm` fields
- Extend terminal type union: `"kitty" | "iterm2" | "wezterm" | "tmux"`

### `src/config.ts`
- Add tier expansion in `loadConfig()`: if `deployment` key exists, expand preset then merge overrides
- Backward compat: if no `stt`/`tts`/`llm` fields, derive them from existing `servers.*` config
- No changes to existing config parsing logic

### `src/router/llm-router.ts`
- Constructor takes `LLMProvider` instead of `port` + `model`
- `classify()` calls `this.provider.chatCompletion(messages, opts)` instead of `fetch()`
- `health()` calls `this.provider.health()`
- `buildSystemPrompt()` and `parseResponse()` unchanged

### `src/router/index.ts`
- `createRouter()` receives `LLMProvider` from registry, passes to `LLMRouter`

### `src/speaker/tts-speaker.ts`
- Constructor takes `TTSProvider` + `AudioPlayer` + fallback `Speaker`
- `generateAudio()` calls `this.provider.generateAudio(text)` instead of `fetch()`
- `playAudio()` calls `this.audioPlayer.play(tmpFile)` instead of `afplay`
- `stop()` calls `this.audioPlayer.stopAll()` instead of `pkill`
- Chunking logic, sentence splitting unchanged

### `src/speaker/streaming-tts.ts`
- Same pattern as `tts-speaker.ts`

### `src/speaker/index.ts`
- `createSpeaker()` gets `TTSProvider` from registry, `AudioPlayer` from platform factory

### `src/listener/conversational.ts`
- Constructor takes `STTProvider` + `AudioRecorder` + `AudioPlayer`
- `transcribe()` calls `this.sttProvider.transcribe(audioFile)` instead of `fetch()`
- `recordUntilSilence()` uses `this.recorder.record()` instead of inline sox command
- `playSound()` uses `this.audioPlayer.play()` instead of `afplay`
- Listen loop logic, barge-in detection, deactivation phrases unchanged

### `src/listener/index.ts`
- `createConversationalListener()` gets providers from registry

### `src/servers/index.ts`
- `ServerManager` simplified to iterate `provider.start()`/`provider.stop()`
- Existing `startServer()`, `startSTT()`, `prewarmTTS()`, `prewarmSTT()` removed (moved into providers)

### `src/daemon.ts`
- Creates providers via `createProviders(config)` from registry
- Passes providers to `ServerManager`, component factories
- `summarizeForTTS()` uses `LLMProvider` instead of direct fetch

---

## 7. Untouched Files

```
src/brain/*                    — Brain interface, Claude Code, context store
src/executor/*                 — ActionExecutor, action registry
src/tab-parser.ts              — phonetic alias expansion
src/text-utils.ts              — filler stripping
src/router/fallback-router.ts  — keyword matcher (wraps LLMRouter as before)
src/speaker/say-speaker.ts     — macOS say (becomes mac-specific platform fallback)
src/speaker/silent-speaker.ts  — no-op speaker
src/listener/stdin.ts          — stdin listener
src/listener/wispr-flow.ts     — Wispr Flow listener
helpers/cicero-hotkey.swift    — macOS hotkey helper
servers/stt_server.py          — MLX Whisper server (used by mlx-whisper provider)
```

---

## 8. Testing Strategy

**Phase 1 — Refactor validation (Mac):**
Run Cicero with zero config changes. The MLX providers are literal extractions of existing code. Every server spawn, API call, and audio playback should be identical to pre-refactor behavior.

**Phase 2 — New backend validation (5090/Windows):**
Set `deployment: local-cuda` and test faster-whisper + LuxTTS + Ollama/Qwen3-1.7B with CUDA.

**Phase 3 — Cross-platform terminal:**
Test tmux adapter on Mac first (tmux runs on Mac), then Windows.

**Unit tests:** Each provider can be tested in isolation against a mock HTTP server. The interfaces make this straightforward.

---

## 9. New Files Summary

```
src/backends/
  stt/
    provider.ts              — STTProvider interface + config type
    mlx-whisper.ts           — extracted from ConversationalListener
    faster-whisper.ts        — CUDA STT (primary, 60-150ms, mature HTTP server)
    nemotron.ts              — CUDA STT (future: 24ms streaming, blocked on streaming interface)
    moonshine.ts             — CPU STT (107ms, edge/no-GPU)
    deepgram.ts              — cloud STT
  tts/
    provider.ts              — TTSProvider interface + config type
    mlx-audio.ts             — extracted from TTSSpeaker
    kokoro.ts                — CUDA TTS default (50-100ms, 1GB, #1 TTS Arena, OpenAI-compat)
    vibevoice.ts             — CUDA TTS cloning option (VibeVoice-RT-0.5B, ~150ms, 2GB, zero-shot)
    omnivoice.ts             — CUDA TTS future option (wait for maturity)
    pocket-tts.ts            — CPU TTS (100M, 6x RT, cloning)
    elevenlabs.ts            — cloud TTS
    voxtral.ts               — cloud TTS (cloning, streaming)
  llm/
    provider.ts              — LLMProvider interface + config type
    mlx-lm.ts                — extracted from LLMRouter fetch calls
    ollama.ts                — cross-platform (Qwen3-1.7B + JSON schema constraint)
    claude-api.ts            — cloud LLM
  registry.ts                — factory: config → concrete providers
  tiers.ts                   — tier preset definitions
  managed-server.ts          — extracted from ServerManager.startServer()
src/platform/
  audio.ts                   — AudioPlayer/AudioRecorder interfaces + factories
  audio-macos.ts             — afplay playback
  audio-linux.ts             — aplay/paplay playback
  audio-windows.ts           — ffplay playback
  recorder-sox.ts            — sox rec (mac + linux)
  recorder-windows.ts        — sox/ffmpeg recording on Windows
src/terminal/
  tmux.ts                    — tmux adapter (new, universal)
  wezterm.ts                 — WezTerm adapter (new, opt-in)
helpers/
  cicero-hotkey/             — Rust binary (future: replaces Swift helper)
    Cargo.toml               — uses livesplit-hotkey crate
    src/main.rs              — register hotkey, println!("HOTKEY") on trigger
```

---

## 10. Cross-Platform Hotkey (Future)

Current Swift helper (`helpers/cicero-hotkey.swift`) is macOS-only. Replace with a single Rust binary using the `livesplit-hotkey` crate:

- **macOS:** CGEvent (same approach as current Swift)
- **Windows:** `WH_KEYBOARD_LL` low-level keyboard hook (no GUI, no AHK dependency)
- **Linux:** evdev input subsystem (works on X11 + Wayland, no display server dependency)

One source tree, three compile targets (`x86_64-apple-darwin`, `x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`). Sub-1MB binary per platform. Same stdout interface: prints `HOTKEY\n` on trigger.

Linux requires user in `input` group (`sudo usermod -aG input $USER`).

**Not blocking for Phase 1** — stdin listener + typing "voice" works everywhere. Hotkey is a UX polish for Phase 2+.

---

## 11. Per-Platform Pipeline Summary

### macOS (current, unchanged)

```
Hotkey (Swift) → sox rec → MLX Whisper (:8083) → MLX Qwen 0.8B (:8081)
  → ActionExecutor / Brain (Claude Code in Kitty)
  → MLX Qwen3-TTS (:8082) → afplay
```

### Windows (5090 / CUDA)

```
Hotkey (Rust/livesplit) → sox rec → faster-whisper/Large-v3-Turbo (:8083, CUDA)
  → Ollama/Qwen3-1.7B (:11434, CUDA, JSON schema)
  → ActionExecutor / Brain (Claude Code in tmux)
  → Kokoro-82M (:8082, CUDA) → ffplay
```

### Linux (CUDA or CPU)

```
Hotkey (Rust/livesplit evdev) → sox rec → faster-whisper (:8083, CUDA) or Moonshine (CPU)
  → Ollama/Qwen3-1.7B (:11434)
  → ActionExecutor / Brain (Claude Code in Kitty or tmux)
  → Kokoro (:8082, CUDA) or Pocket-TTS (CPU) → aplay
```

### Cloud / Hybrid (any OS)

```
Hotkey → sox/ffmpeg → Deepgram Nova-3 API (<300ms)
  → Ollama local (routing) or Claude API (complex)
  → ActionExecutor / Brain
  → ElevenLabs or Voxtral API → platform player
```

### VRAM Budget — RTX 5090 (32GB)

```
faster-whisper/Large-v3-Turbo (STT)  ~3GB
Ollama/Qwen3-1.7B (Router)          ~1.1GB
Kokoro-82M (TTS)                     ~1GB
                              Total: ~5.1GB  (27GB headroom)

With VibeVoice-RT cloning instead of Kokoro: ~6.1GB total (26GB headroom)
```

Note: All latency estimates are from third-party benchmarks on other hardware (4090, 3090, etc.), not tested on RTX 5090. Actual numbers will differ — benchmark on target hardware during Phase 2.

---

## 12. Research Sources & Alternatives Considered

### STT — Why faster-whisper now, Nemotron later

| Model | Latency (5090) | WER | VRAM | Verdict |
|-------|---------------|-----|------|---------|
| **faster-whisper + Large-v3-Turbo** | **60-150ms** | ~3-5% | ~3GB | **Phase 1 primary** — mature HTTP server, file-based, battle-tested |
| Nemotron Speech 0.6B | 24ms streaming | ~7.5% | ~3GB | **Future primary** — needs streaming STT interface + custom HTTP wrapper |
| Moonshine v2 | 107ms (CPU) | ~Whisper-level | Minimal | **CPU option** — edge/no-GPU |
| Parakeet TDT 0.6B | ~100ms | Best accuracy | ~3GB | **Not recommended** — batch-optimized, CUDA graph bugs |
| SenseVoice-Small (234M) | 70ms/10s on CPU | Good | Minimal | Worth knowing — 50+ langs, emotion detection |
| Deepgram Nova-3 | <300ms | ~5-18% | Cloud | **Best cloud** — $0.0043/min |

Sources: NVIDIA Nemotron HuggingFace, Tom's Hardware GPU benchmarks, Northflank 2026 STT benchmarks

### TTS — Why Kokoro default, VibeVoice-RT for cloning

| Model | TTFA (est.) | VRAM | Clone | HTTP Server | Quality Validation | Verdict |
|-------|-------------|------|-------|-------------|-------------------|---------|
| **Kokoro-82M** | **50-100ms** | **~1GB** | No | Kokoro-FastAPI (OpenAI-compat) | #1 TTS Arena (Elo blind pairwise) | **Default** — fastest, proven, Jarvis presets |
| **VibeVoice-RT-0.5B** | ~150ms | ~2GB | **Yes** | vibevoice-realtime-openai-api | MOS 4.3, user-tested quality lineage | **Cloning option** — streaming arch, zero-shot |
| LuxTTS | ~50ms claimed | ~1GB | Yes | Third-party side project | **Zero independent validation** | **Eliminated** — vaporware-adjacent |
| OmniVoice | ~160ms batch | ~7GB+ | Yes | pasadei/OmniVoice-local | Self-reported, 4 days old, digit/accent bugs | **Future** — wait for maturity |
| OmniVoice | ~160ms batch | ~4-6GB | Yes | Gradio only (no HTTP) | **Quality option** — SIM-o 0.741 but needs wrapper |
| Pocket-TTS | ~170ms | CPU | Yes | None (needs wrapper) | **CPU option** — Kyutai Labs, Apache-2.0 |
| Qwen3-TTS 1.7B | ~160ms (w/ CUDA graphs) | ~4-6GB | Yes | faster-qwen3-tts | Highest naturalness (UTMOS 4.41) |
| Voxtral-4B | 70ms model | 16GB/3GB q | Yes | vLLM-Omni (immature) | **Watch** — ElevenLabs quality, too new |
| F5-TTS | RTF 0.03 | ~4GB | Yes | Yes | Best batch cloning, no streaming |

Kokoro is the default because: (1) fastest proven TTFA at 50-100ms, (2) #1 TTS Arena via independent blind pairwise evaluation, (3) `am_onyx` preset is deep/authoritative — ideal Jarvis voice, (4) 1GB VRAM, (5) Kokoro-FastAPI is actively maintained and production-ready. Voice cloning is handled by VibeVoice-Realtime-0.5B when `voice_ref_audio` is configured — user has first-hand experience with VibeVoice quality (tested 7B/9B models), and the 0.5B Realtime variant was purpose-built for streaming low-latency use. LuxTTS was eliminated — zero independent quality validation, "150x RT" claim is likely forward-pass only, Docker API is a third-party side project. OmniVoice deferred — repo is days old, digit pronunciation and accent bleed bugs confirmed unfixable by author.

Sources: BentoML TTS comparison, Kokoro-FastAPI GitHub, LuxTTS HackerNoon

### LLM Router — Why Qwen3-1.7B + Ollama + JSON schema

| Finding | Impact |
|---------|--------|
| Ollama overhead: 15-30ms vs raw llama.cpp | Negligible in full voice pipeline |
| Qwen3-1.7B > Qwen2.5-0.8B | Better instruction following, ~1.1GB VRAM |
| XGrammar constrained decoding | **100% JSON compliance at <40µs/token** — biggest reliability win |
| llama.cpp server: ~27% faster | Escape hatch if latency becomes a bottleneck |
| SmolLM2/Gemma/Phi-4/Hermes | All overkill or unreliable for pure 20-intent routing |

Sources: Ollama structured outputs blog, llama.cpp GBNF grammar docs, Qwen3 release benchmarks, ArXiv Nov 2025 inference framework comparison

### Audio — Platform-specific findings

| Platform | Capture | Playback | Latency |
|----------|---------|----------|---------|
| macOS | sox `rec` (~50ms) | `afplay` (~50-150ms) | Unchanged from current |
| Linux | sox `rec` (~70ms) or `arecord` (~45ms) | `aplay` (~45ms) | Lower than Mac for ALSA direct |
| Windows | sox `sox -d` (~100-200ms) | `ffplay` (~100-200ms) | Avoid PowerShell SoundPlayer (300ms+) |

sox last released 2015 but still functional. `micstream` npm (PortAudio N-API) is a future native option if Bun N-API compatibility holds.

### Hotkey — Why livesplit-hotkey Rust crate

Single cross-platform crate, battle-tested in LiveSplit (speedrunning tool). macOS: CGEvent, Windows: WH_KEYBOARD_LL, Linux: evdev. Compiles to sub-1MB binary per platform. Replaces maintaining separate Swift/AutoHotkey/evdev solutions.
