# Cicero Positioning Design

**Date:** 2026-05-19 (revised after research into provider-native voice support)
**Status:** Pending user review.

## TL;DR

Cicero is a personal tool, MIT-licensed, shared publicly. No commercial framing, no paid layer, no startup ambition. The product has **two modes** sharing the same summarization + TTS core:

- **Sidecar mode** — hooks or scrapes any coding agent session (Claude Code, Codex, Gemini, OpenWebUI, Ollama, any CLI in a terminal), speaks a summarized version of the agent's response. Uses providers' own STT for input.
- **Daemon mode** — Cicero's full voice loop: STT → router → multi-brain dispatch → summarized TTS. For users who want one voice console that switches between agents, or whose preferred agent doesn't have native voice input.

Both modes ship in v1. Sidecar is the new primary onboarding path; daemon stays for users who want full ownership of the voice loop.

## Identity

**One-liner:**

> Cicero — Hear what your coding agent did. Voice output and summarization layer for Claude Code, Codex, Gemini, OpenWebUI, Ollama, and any CLI agent in a terminal. Optional full voice loop. Local-first, Bun/TS.

**What it is:**

A local-first TTS + summarization layer for coding agents. In **sidecar mode**, Cicero attaches to whatever agent you're already using (via the agent's native hooks where available, or terminal output scraping as a universal fallback), summarizes responses, and speaks them aloud. You keep using the agent's own voice input — Claude Code's `/voice`, ChatGPT's voice mode through Codex, whatever. In **daemon mode**, Cicero runs its own voice loop: mic in, intent classification, brain dispatch, summarized TTS out — useful when you want voice-driven multi-brain switching or when your agent doesn't have a native voice input.

**The competitive slot:**

Claude Code's `/voice` (and ChatGPT voice through Codex) handles input. Nothing on the market reliably handles **TTS-summarized output** for coding agents. That's the gap. A small third-party ecosystem already exists in this slot (`mckaywrigley/claude-code-voice`, `abracadabra50/claude-code-voice-skill`, ~10 others, all 1-165 stars) — mostly hacky single-agent integrations. Cicero's provider-agnostic SpeakAdapter pattern + multi-provider TTS support is meaningfully more useful than any individual hack.

## Posture

**Personal tool, OSS for visibility.**

- Built by the user, for the user, first.
- Open-sourced because the architecture is a genuine OSS contribution (Bun-native voice tooling in a Python-dominated ecosystem; agent-agnostic via SpeakAdapter pattern).
- No paid tier, no managed service, no enterprise plans. Public face stays pure-OSS.
- **License:** MIT.
- No commercial signaling anywhere in the repo.

## Audience

In priority order:

1. **The user (Tym Rabchuk).** Primary user, primary decider.
2. **Devs who use coding agents and want spoken summaries.** Specifically: hands-busy contexts (parents, drivers, RSI users, multitaskers) and anyone tired of reading 2000-token diff blobs.
3. **Voice-AI / agent-tooling hackers.** Fork the codebase, swap in their own backends, build adjacent tools.
4. **Home Assistant / self-hoster community.** Lower priority. Becomes relevant only if Wyoming support (Plan W) ships — explicitly add-on.

## Scope (v1)

**In scope:**

- **Existing sidecar foundation (already built):** `daemon.ts:400 summarizeForTTS`, full TTS provider registry (Kokoro / Qwen3-TTS / VibeVoice / mlx-audio).
- **New: SpeakAdapter pattern + registry.** Symmetric with existing `Brain` / `STTProvider` / `TTSProvider` registries. Captures agent response events and routes them to summarizer + TTS.
- **Sidecar adapters (v1):**
  - `ClaudeCodeHookAdapter` — native hook on `Stop` / `PostToolUse`. Easiest.
  - `TerminalScrapeAdapter` — universal fallback. Uses existing `TerminalAdapter` to capture-pane / pipe-pane. Detects response boundaries (idle prompt return, ANSI markers). Works for Codex CLI, Gemini CLI, Ollama, any CLI agent.
- **Existing daemon mode** — kept as the alternative for users without provider-native voice. Plan 2 (FOLLOWUP_WINDOW, barge-in, Silero VAD) still applies here. Plan T (terminal-agnostic) still applies.

**Out of scope for v1 (add-ons / future):**

- Per-agent native adapters beyond Claude Code (Codex hook, Gemini plugin, OpenWebUI webhook). Ship terminal-scrape fallback first; add native adapters as needed when users complain.
- Plan A (audio model upgrades).
- Plan W (Wyoming protocol) — strategic add-on.
- Plan 6 (voice cloning UX).
- Plan 3 (router enhancements) — daemon-mode only.
- Plan 4 (MCP and tools), Plan 5 (memory + telemetry).
- Multi-device daemon — required for "drive away in car" use case; future plan.
- Smart-home control, GUI automation.

**Non-goals:**

- Not a dictation tool.
- Not a general voice assistant.
- Not a smart-home controller.
- Not a Claude Code / Codex / Gemini replacement. Cicero wraps them, sits beside them, or behind them.
- Not a commercial product. No paid layer, no SaaS, no enterprise features.

## Success criteria

1. **Daily use by the user.** Sidecar mode running against whatever agent the user is using today, summarizing responses through home speakers, while hands are occupied.
2. **Honest README.** A first-time visitor in 30 seconds understands: two modes, what each does, which to pick.
3. **Low onboarding friction in sidecar mode.** `cicero hook claude-code` (or equivalent) should be a one-line install + a config tweak in Claude Code, no GPU / mic / venv required.
4. **Daemon mode unchanged for existing users.** `cicero start --tts` keeps working exactly as today.
5. **Clean SpeakAdapter abstraction.** Adding a new agent integration is a single new adapter file, no orchestrator changes.

## Roadmap implications

**v1 plan stack (in scope):**

- **Plan H — Sidecar / SpeakAdapter pattern** *(new, highest priority)*. Adds the registry, the Claude Code hook adapter, and the terminal-scrape fallback. Both adapters reuse `summarizeForTTS` and the existing TTS provider registry.
- **Plan T — Terminal-agnostic refactor.** Required for both modes: terminal-scrape adapter relies on the cleaned-up `TerminalAdapter` interface.
- **Plan 2 — Listener upgrades** — *daemon-mode core only.* Lower priority than Plan H since sidecar mode bypasses Cicero's listener entirely.
- **Plan 1 — Multi-brain CLI** — *daemon-mode only.* Useful if users want voice-driven brain switching inside Cicero's loop; less critical now that sidecar handles "use whatever agent you want."

**Add-on / future:**

- Plans A, W, 6, 3, 4, 5 — unchanged status (all add-ons).
- Per-agent native sidecar adapters (Codex hook, Gemini plugin, OpenWebUI webhook) — incremental, add when there's user demand.
- Multi-device daemon — future, required for drive-away use case.

## What changes vs. what doesn't

**Changes:**

- README pivots to dual-mode framing. New tagline above.
- Master roadmap intro adds Plan H, regroups plans into v1 / daemon-mode-add-ons / future.
- License line: `Private — public release pending` → `MIT`.
- Plans 4 and 5 scope-decision banners stay.

**Does not change:**

- Existing plan files (T, A, W, 1, 2, 3, 4, 5, 6) — content unchanged.
- Existing codebase. Summarization is already built. The TTS providers are already there. Plan H reuses them; nothing currently in `src/` gets deprecated.

## Known risks accepted

- **Anthropic ships `/voice` with TTS.** Sidecar mode becomes redundant for Claude Code specifically. Cicero still has value for Codex / Gemini / OpenWebUI / generic terminal scenarios. Acceptable.
- **Provider hook APIs change.** Each native adapter is a maintenance burden. Mitigated by leaning on the terminal-scrape fallback as the universal path.
- **Terminal scraping is imprecise.** Response-boundary detection (ANSI markers, prompt detection) can misfire. Known v1 risk; iterate via user feedback.
- **Two modes = two mental models for users.** README and onboarding need to make the choice obvious. Mitigated by leading with sidecar mode as the default recommendation; daemon mode is "advanced."
