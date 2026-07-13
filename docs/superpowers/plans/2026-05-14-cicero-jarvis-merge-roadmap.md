# Cicero × Jarvis Merge Roadmap

> **For agentic workers:** This is the master index for the Cicero expansion plan. Each linked sub-plan is independently executable and produces shippable code on its own. Pick a sub-plan, use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to run it.

**Goal:** Merge the best ideas from `isair/jarvis` (non-commercial, clean-room only) and `open-jarvis/OpenJarvis` (Apache 2.0) into Cicero without changing Cicero's core architecture (Bun/TS orchestrator + Python ML servers over HTTP).

**Architecture:** Cicero stays on its current shape — `src/listener/` → `src/router/` → `src/executor/` → `src/brain/` → `src/speaker/`, all in Bun/TS, talking to Python ML servers on ports 8081/8082/8083. New capabilities slot in as additional implementations of existing interfaces (`Brain`, `Listener`, `LLMProvider`, etc.) plus a few brand-new interfaces where Cicero has no equivalent today (`MemoryStore`, `MCPClient`).

**Tech Stack:** Bun ≥1.1, TypeScript 5.9, `bun:sqlite`, fetch, `Bun.spawn`. Python side stays MLX/faster-whisper/Ollama. New deps: `@modelcontextprotocol/sdk` (TS), optional `onnxruntime-node` for OpenWakeWord, optional `sentence-transformers` via Python server.

**License posture:**
- isair/jarvis is non-commercial. Treat its code as **read-only documentation**. Reimplement patterns from scratch in TS. Never paste, never vendor.
- OpenJarvis is Apache 2.0. Code-reuse is legally fine but their v0.1.1 abstractions will keep shifting; prefer clean-room reimplementation here too. If you do borrow code, attribute it in a comment header.

---

**Model choices:** Every plan that mentions a specific model (Whisper, Qwen3, Kokoro, VibeVoice, etc.) defers to [`../model-recommendations-may-2026.md`](../model-recommendations-may-2026.md) for the per-role rationale and current best options. Model versions are config (`~/.cicero/config.yaml`), not code — swap freely as new releases land.

**Scope note:** Cicero's job is the voice-pipeline layer — wake word, VAD, STT, intent routing, agent dispatch, response filtering, TTS (with voice cloning). The agent that does the actual work (Claude Code, Codex, Gemini, Qwen CLI, local Ollama, or Claude API) is pluggable via Plan 1. Plans 4 and 5 carry scope-decision banners — read those before executing them.

---

## Sub-plans

Listed in recommended execution order. Each is independently shippable.

### [Plan 0 — Paid backend providers](2026-05-14-paid-backend-providers.md)

Wire two paid HTTP-API providers so users can offload computation when local hardware is busy: `claude-api` LLM (for the per-turn router classification) and `elevenlabs` TTS (with voice cloning). Stubs for both already exist in `src/backends/registry.ts` — this plan flips them to real implementations. Deepgram STT is explicitly deferred (local `faster-whisper` is fast enough).

**Why zero:** Smallest scope (two providers + tests + config plumbing, no architectural change). Optional for pure-local users; required if you want to offload the router to a cloud API (e.g., when another local model is consuming VRAM) or use a managed cloned voice. Independent of Plans 1–5.

### [Plan A — Audio model upgrades (Moonshine + OmniVoice)](2026-05-19-audio-model-upgrades.md)

Wire two SOTA audio models identified in `model-recommendations-may-2026.md` as **alternative** providers: Moonshine v2 for STT (100× faster than Whisper Large v3, MIT) and OmniVoice for TTS (#1 on SeedTTS-eval). Both have registry stubs already at `src/backends/registry.ts:36, 54`. Includes a manual A/B validation harness (`scripts/validate-{stt,tts}.ts`) so the user can decide whether to promote either to default based on Cicero-realistic vocab (wake word, technical tokens, file paths) rather than benchmark numbers alone.

**Why included:** Benchmarks favor both upgrades convincingly, but STT performance on Cicero's specific vocabulary and TTS voice personality are subjective signals that need hands-on validation. Defaults stay unchanged until validation says otherwise. Independent of all other plans.

### [Plan H — Sidecar / SpeakAdapter pattern](2026-05-19-sidecar-speak-adapter.md)

Adds a sidecar mode: Cicero speaks summarized agent responses regardless of which coding agent the user runs (Claude Code, Codex CLI, Gemini CLI, OpenWebUI, Ollama, any CLI in a terminal). Implements a `SpeakAdapter` pattern symmetric with the existing `Brain` / `STTProvider` / `TTSProvider` registries. Ships two adapters: `ClaudeCodeHookAdapter` (native Claude Code `Stop` hook → HTTP POST → speak) and `TerminalScrapeAdapter` (poll-and-detect universal fallback via the existing terminal adapter). Reuses the existing summarizer (`daemon.ts:400`) by extracting it into a standalone module.

**Why included (load-bearing for v1):** Resolves the "don't reinvent STT — providers already have it" critique by repositioning Cicero as a voice **output** layer that complements provider-native voice **input**. Sidecar mode is the new primary user experience; daemon mode stays as the alternative for users who want the full voice loop. See [`../specs/2026-05-19-positioning-design.md`](../specs/2026-05-19-positioning-design.md).

### [Plan W — Wyoming protocol support](2026-05-19-wyoming-protocol.md)

Add Wyoming protocol support to Cicero's backend layer (TCP wire format used by the Home Assistant voice ecosystem). Implement `WyomingSTTProvider`, `WyomingTTSProvider`, and `WyomingWakeWordProvider` as alternative backends alongside the existing bespoke HTTP providers. Unlocks: drop-in `wyoming-faster-whisper` / `wyoming-piper` / `wyoming-openwakeword` servers, ESP32 hardware reuse (Willow-firmware mics), and bidirectional Home Assistant integration once the optional Cicero-as-Wyoming-server follow-up lands.

**Why included:** Strategic interop. Wyoming is the wire format the Home Assistant voice ecosystem standardized on; supporting it positions Cicero to ride on existing IoT voice hardware and become consumable by HA without writing custom integrations. Independent of all other plans. ~2-day plan (client + STT + TTS); wake-word task gated on Plan 2.

### [Plan T — Terminal-agnostic refactor](2026-05-19-terminal-agnostic.md)

Remove kitty hardcoding from non-adapter code so Cicero runs on tmux, WezTerm, or headless. The `TerminalAdapter` abstraction already exists; this plan generalizes the `Tab` shape, extends the interface with `spawnTab`/`closeTab`/`health`, refactors `src/brain/tab-inject.ts` to stop shelling out to `kitty` directly, adds `terminal: "auto"` detection (reads `$TMUX` / `$KITTY_WINDOW_ID` / `$WEZTERM_PANE`), and introduces a `NullTerminalAdapter` for headless deployments. WezTerm stub becomes real along the way.

**Why before Plan 1:** Plan 1 modifies `tab-inject.ts` for multi-brain support. Doing this refactor first means Plan 1 inherits a clean adapter contract instead of having to navigate kitty literals. Acceptance test: `grep -rn "kitty" src/` returns matches only inside `src/terminal/kitty.ts`. Independent of all other plans; ~1 day of work.

### [Plan 1 — Multi-brain CLI support](2026-05-14-multi-brain-cli-support.md)

Refactor `src/brain/` into a provider pattern matching `src/backends/llm/`. Add brain implementations for Codex CLI, Gemini CLI, Qwen CLI, and a generic Ollama brain. Config-driven selection via `brain.backend`.

**Why first:** `types.ts` already declares `BrainConfig.backend: "claude-code" | "codex" | "gemini" | "ollama"` but the factory only handles `claude-code`. This finishes work that's already half-spec'd. Unlocks running Cicero with no Claude Code dependency.

### [Plan 2 — Listener upgrades](2026-05-14-listener-upgrades.md)

Three additions to `src/listener/`: wake-word-anywhere transcript scanner (steal idea from isair), mid-reply "stop" interrupt extending existing barge-in, and dictation mode (hold-hotkey-to-paste — free WisprFlow alternative).

**Why second:** Independent of brain refactor. Improves UX dramatically with small surface-area changes. Existing `ConversationalListener` is already sophisticated and ready to extend.

### [Plan 3 — Router enhancements](2026-05-14-router-enhancements.md)

Three additions to `src/router/`: embedding-based action filter (prevents context rot as MCPs are added in Plan 4), adaptive tone classification, gemma4:e2b option as a faster intent model than current Qwen3-0.6B.

**Why third:** Plan 4 will add a lot of MCP tools. Embedding filter must exist before that flood or the router's system prompt blows up.

### [Plan 4 — MCP and tools](2026-05-14-mcp-and-tools.md)

Add an MCP client to `src/executor/`. Cicero gains the entire MCP ecosystem (Home Assistant, GitHub, Slack, browser control, filesystem, etc.) without writing custom actions for each. Web search fallback chain (DDG → Brave → Wikipedia) as a built-in action. Align action format with the agentskills.io spec for future skill catalog compatibility.

**Why fourth:** Biggest capability unlock but depends on Plan 3's filter to scale. Brain refactor in Plan 1 is helpful but not strictly required. **⚠ Scope decision required — see banner on the plan.** Most brain CLIs (Claude Code, Codex, Gemini) speak MCP natively, so the cockpit may only need a narrow set of system-control MCPs (Home Assistant, volume, brightness) rather than a general tool layer.

### [Plan 5 — Memory and telemetry](2026-05-14-memory-and-telemetry.md)

Knowledge graph memory layer using `bun:sqlite` + sentence-transformers embeddings (Python side). Topic auto-splitting. PII redaction filter pre-write. Per-turn telemetry log (latency, tokens, backend, success). Telemetry feeds future cost/quality tuning.

**Why last:** Memory is additive — Cicero works today without it. Best built once the other systems are in place so the memory schema can capture the right signals from each. **⚠ Scope decision required — see banner on the plan.** Brains already maintain their own context across turns, so a cockpit-side knowledge graph may be redundant. The telemetry recorder is useful regardless — keep that piece.

### [Plan 6 — Voice cloning UX](2026-05-14-voice-cloning-ux.md)

User-facing voice library: `cicero voice {add, list, use, remove, inspect}` CLI commands manage a `~/.cicero/voices/<name>/` library. Drop a 30-second clip → trim + inspect → provision per provider (VibeVoice local, ElevenLabs cloud) → one command to switch active voice. Pocket-TTS / LuxTTS / Voxtral slot in later via the same library.

**Why included:** VibeVoice is already wired and Plan 0 wires ElevenLabs, but the *workflow* — drop audio → provision → use — doesn't exist yet. This plan builds that.

**When to do it:** After Plan 0 (so ElevenLabs is available) but otherwise independent.

---

## Recommended execution cadence

Suggested order for weekend-scale time slots:

- **v1 core — Plan H (sidecar / SpeakAdapter).** Highest priority under the dual-mode positioning. ~2-3 days.
- **v1 infrastructure — Plan T (terminal-agnostic).** Required for Plan H's terminal-scrape adapter (and for daemon mode quality-of-life). One day.
- **Half-weekend (optional):** Plan 0 (paid providers). Skip if you're committed to a fully local stack.
- **Half-weekend (optional):** Plan A (audio upgrades). Wire as alternatives; validate before promoting.
- **Two-day strategic add-on:** Plan W (Wyoming protocol). Independent; unlocks HA interop + IoT hardware reuse.
- **Weekend 1:** Plan 1 (multi-brain refactor). Highest-leverage piece — unlocks every other brain backend.
- **Weekend 2:** Plan 6 (voice cloning UX). Independent of Plans 1–5; safe to do anytime after Plan 0.
- **Weekend 3:** Plan 2 (listener upgrades). Wake-word-anywhere + Silero VAD + dictation + barge-in.
- **Weekend 4:** Plan 3 (router enhancements). Embedding filter + tone + constrained-decoding JSON. Required before Plan 4.
- **Plan 4 (MCP):** Resolve the scope decision in the plan banner before starting. May land as cockpit-only system control rather than a general tool layer.
- **Plan 5 (memory + telemetry):** Resolve the scope decision in the plan banner. Telemetry half is the high-value piece.

Under the dual-mode positioning (see [`../specs/2026-05-19-positioning-design.md`](../specs/2026-05-19-positioning-design.md)): **Plan H is v1 core**, **Plan T is v1 infrastructure**, **Plans 1 and 2 are daemon-mode-only** (lower priority since sidecar mode bypasses Cicero's listener entirely). **Plans 0, A, W, 6, 3, 4, 5 are independent add-ons.**

---

## What's deliberately NOT in this roadmap

These were considered and dropped. Don't add them without a specific user request:

- **Local-only voice cloning workflow (VibeVoice reference clip + config).** Already wired in `src/backends/tts/vibevoice.ts`; the broader UX is covered by Plan 6. The ElevenLabs paid voice-cloning path is covered by Plan 0.
- **Migration to Python or Rust.** Cicero's Bun/TS orchestrator is fast enough. Bottleneck is model inference (50-300ms), not orchestrator overhead (1-10ms). OpenJarvis's Rust core is impressive but reimplementing it would burn weeks for invisible perf gains.
- **Channel layer (Telegram/Discord/Slack inputs).** Out of scope for a local voice assistant.
- **Energy metrics (pynvml/amdsmi/zeus-ml).** Track once telemetry exists if it ever matters.
- **DSPy/GEPA learning loop.** Interesting research, not load-bearing for product use.
- **Forking either reference repo.** Read both, reimplement ideas cleanly in Cicero.

---

## Reference repos for clean-room idea extraction

- [`isair/jarvis`](https://github.com/isair/jarvis) (Python, non-commercial license) — wake-word UX, dictation mode, embedding tool router, knowledge graph memory, sensitive-info redaction, adaptive tone, MCP integration patterns
- [`open-jarvis/OpenJarvis`](https://github.com/open-jarvis/OpenJarvis) (Rust + Python, Apache 2.0) — multi-provider inference abstraction, MCP protocol implementation reference, agentskills.io tool format, eval/telemetry framework, memory tier menu (FAISS/BM25/ColBERT)

Read for patterns. Implement fresh in Cicero's TS. Attribute inspiration in commit messages, not code.
