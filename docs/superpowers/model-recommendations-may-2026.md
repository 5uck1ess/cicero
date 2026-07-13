# Cicero Model Recommendations (May 2026)

> **Snapshot date:** 2026-05-14. Distilled from an external ecosystem and TTS voice-cloning benchmark review. Update this doc when newer models ship.

This is the single source of truth for "which model should we use for each role." Plans reference this doc; they don't re-cite benchmarks individually.

**Operating principles:**
- **Defaults stay stable.** `DEFAULT_CONFIG.servers.*` and the hard-coded fallbacks inside `MlxLmProvider` / `MlxAudioProvider` / `MlxWhisperProvider` are not changed by this doc — the working MacBook keeps working.
- **Model versions are config, not code.** Swap via `~/.cicero/config.yaml` (`llm.model`, `stt.model`, `tts.model`). When Ollama publishes `qwen3.6:1.7b` or whatever ships next, you change one line, not the codebase.
- **The provider abstraction is the substrate.** New model = new provider class only if the API shape changes (e.g., Moonshine v2 has its own REST shape). Swapping a model on the *same* runtime (Ollama, mlx-lm, kokoro-fastapi) is a config change.

---

## STT

| Role | Current Cicero | Recommended (May 2026) | Notes |
|---|---|---|---|
| Mac default | `mlx-community/whisper-large-v3-turbo` (port 8083, MLX) | Same. Reasonable until Moonshine v2 provider lands. | — |
| CUDA default | `Systran/faster-whisper-large-v3-turbo` (port 8083, faster-whisper) | Same. | — |
| **Strong upgrade candidate** | — | **Moonshine v2** (250M params, MIT, Feb 2026) | Beats Whisper Large v3 (1.5B params) on WER; Moonshine Medium = **107 ms** on MacBook Pro vs Whisper's 11,286 ms — 100× faster. Streaming-optimized, edge-friendly. Registry already has `case "moonshine":` stub. Adding it is a small standalone task — follow the `MlxWhisperProvider` template. |
| Linux-only best-in-class | — | **NVIDIA Parakeet TDT 0.6B v2** | 1.69% WER on LibriSpeech vs Whisper's 2.7%. RTFx > 2000. NVIDIA-centric. Only worth wiring if WER becomes the bottleneck on a 5090. |
| CUDA streaming best-in-class | — | **Nemotron Speech 0.6B** | **24 ms** streaming latency on GPU — fastest local STT in the May 2026 research. 100× faster than current Whisper. Good fit for the CUDA tier when conversational latency is the bottleneck. |
| Cloud (paid) | — | Deepgram | Explicitly deferred (Plan 0). Local STT is fast enough — offloading STT to the cloud frees negligible VRAM. |

**Citations:** [Moonshine v2](https://github.com/moonshine-ai/moonshine), [Parakeet](https://www.ionio.ai/blog/2025-edge-speech-to-text-model-benchmark-whisper-vs-competitors).

---

## TTS (general use, no cloning)

| Role | Current Cicero | Recommended | Notes |
|---|---|---|---|
| Mac default | `mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16` (port 8082, MLX) | Same. Qwen3-TTS ranks #2 on SeedTTS-eval WER (1.54) and is MLX-native. | — |
| CUDA default | Kokoro 82M, `am_onyx` voice (port 8082, kokoro-fastapi) | Same. Best quality-per-parameter ratio, CPU-friendly, no cloning. | — |
| Future cross-platform option | — | **OmniVoice** | #1 on SeedTTS-eval WER (1.60) AND SIM (0.741). RTF 0.025. Runs on CUDA + MPS + CPU. Worth adding if Cicero ever wants a single TTS that works equally well everywhere. Registry has `case "omnivoice":` stub. |
| **CPU-only (Mac Mini appliance)** | — | **Pocket-TTS** (100M, CPU 6× RT, supports voice cloning) | Right pick for a CPU-only client appliance — no GPU needed, voice cloning included. Registry has `case "pocket-tts":` stub. |
| **Ultra-light (constrained VRAM)** | — | **LuxTTS** (1 GB VRAM, 150× RT, 48 kHz, cloning) | Drop-in for any device with ≥1 GB VRAM that needs cloning. Faster than VibeVoice but lower long-form quality. |
| **High naturalness (MLX)** | — | **Qwen3-TTS 1.7B** (UTMOS 4.41, Apache-2.0) | Larger version of the current Mac default. Higher naturalness score; MLX port exists. Drop in if quality is the goal and you can spare the VRAM. |

---

## TTS (voice cloning)

Cicero's wired choice is the right one — confirmed by the ICLR 2026 Oral paper.

| Option | Status | Long-form quality | Notes |
|---|---|---|---|
| **VibeVoice-7B** | **Wired** (`src/backends/tts/vibevoice.ts`) | **Realism 3.71, Richness 3.81, Pref 3.75, Avg 3.76, SIM 0.692** | Beats Gemini 2.5 Pro TTS (3.66 avg) and ElevenLabs v3 alpha (3.40 avg) on the VibeVoice paper's long-form benchmark. Apache-licensed weights. Keep. |
| VibeVoice-1.5B | Same provider | Avg 3.54, WER-Whisper **1.11** (lowest) | Lower SIM (0.548) but cleanest text fidelity. Lighter VRAM. Just swap `tts.model`. |
| F5-TTS | Not wired | SeedTTS-eval: WER 1.85, SIM 0.664 | Older, well-supported. Lost to OmniVoice on both metrics. Skip unless OmniVoice doesn't land. |
| **ElevenLabs** (paid) | Plan 0 (planned) | Cloud cloning service | Closed-source. Plan 0 wires the provider + cloning helper script. Use when you want a managed cloned voice without local VRAM. |
| **Voxtral API** (paid alternative) | Not wired | Cloud cloning, 70 ms streaming | $0.016/1K chars — cheaper per-character than ElevenLabs. Same surface area as `ElevenLabsProvider`: API key + voice_id. Wire as a parallel `VoxtralProvider` if ElevenLabs pricing/limits become an issue. |
| Sesame CSM 1B | Not wired | Avg 2.89 (lower than VibeVoice) | High naturalness for non-cloning (4.7 MOS) but loses on the cloning benchmark. Skip for cloning role. |

**Reference clip workflow:** 30 s clean voice sample → store path in `tts.refAudio` (for VibeVoice) or run `helpers/clone-voice-elevenlabs.ts` (for ElevenLabs).

**Citations:** [VibeVoice paper](https://arxiv.org/abs/2508.19205); SeedTTS-eval benchmark consolidation (internal).

---

## LLM router

The router does one job: classify a transcript into JSON `{intent, category, params, confidence}`. Latency budget: < 200 ms. Reliability beats raw model quality.

| Option | VRAM | Strength | Use it when |
|---|---|---|---|
| **Qwen3.5-0.8B** (current Mac default) | ~0.5 GB | Solid baseline; MLX-native | Default. Fine until you have a specific reason. |
| **Qwen3 1.7B** / **Qwen3.5 4B** (current CUDA default) | 1.1 / 2.4 GB | Better instruction-following at acceptable latency | Default for CUDA. |
| SmolLM2-1.7B | ~1.0 GB | Lower latency than Qwen3 for pure intent classification | Drop in if router latency becomes the bottleneck. |
| Gemma 3n E4B | ~3 GB | Best sub-10B LMArena Elo, mobile-first | Drop in for higher accuracy if VRAM allows. |
| Hermes 2 Pro Mistral 7B | ~7 GB | **91% function calling, 84% JSON mode** — best dedicated tool-calling small model | Use only if Plan 4 (MCP) tool-calling load grows past simple JSON routing. |
| Claude API (Haiku 4.5) | 0 GB local | Cloud offload | Plan 0. When local VRAM is already committed to another model. |

**Critical addition — JSON compliance via constrained decoding:**

Per the original backend-abstraction spec: *"XGrammar constrained decoding → 100% JSON compliance at <40µs/token — biggest reliability win."* Plan 3 adds this as its own task. Implementation per runtime:

| Runtime | Constrained-decoding library |
|---|---|
| llama.cpp / Ollama | XGrammar (GBNF grammar) — Ollama exposes via `format: { type: "json_schema", ... }` |
| mlx-lm | `outlines` Python library, or mlx-lm's logits_processor |
| Claude API | Anthropic's tool-use schema (already JSON-typed) |

The `LLMProvider.chatCompletion()` interface needs a `jsonSchema?: object` option to plumb this through. Plan 3 covers this.

---

## VAD (Voice Activity Detection)

| Option | Type | Notes |
|---|---|---|
| **Silero VAD** | Local, ONNX | **Recommended.** 87.7% TPR at 5% FPR. Trained on 6000+ languages, no API key, zero deps. Used inside OpenWakeWord and RealtimeSTT. Plan 2 adds this. |
| OpenWakeWord | Local, ONNX | Bundles Silero VAD + custom wake-word matching. Plan 2 uses this for the wake-word path. |
| Picovoice Cobra | Commercial | 98.9% TPR at 5% FPR (best accuracy) but requires API key. Skip. |

**Why Silero gets its own listener task in Plan 2:** Cicero's current `ConversationalListener` ends recording on sox silence threshold (a crude amplitude check). Silero VAD replaces that with proper speech detection, fixing premature cutoffs on quiet voice or noisy rooms.

---

## Wake word

| Option | Notes |
|---|---|
| **Transcript scan** (Plan 2 default) | Run STT continuously, regex/fuzzy-match "Jarvis"/"Cicero" in the transcript. Zero new deps. Recommended for the conversational-mode path Cicero already uses. |
| **OpenWakeWord** (Plan 2 optional) | ONNX-based always-on wake-word detector. Add for true sleep-mode with no continuous STT cost. Train custom "Hey Cicero" with minimal data. |

---

## Inference engine

| Platform | Current | Future option (do not switch lightly) |
|---|---|---|
| Mac | raw `mlx-lm` via `python3 -m mlx_lm.server` | **Ollama v0.5.x** is now MLX-powered on Apple Silicon (March 30 2026): 57% faster prefill, 93% faster decode. Could unify Mac+Linux on a single Ollama provider. Trade-off: slightly more abstraction layers vs raw mlx-lm. **Not changing now** — the existing dual-provider path works. Consider when adding Plan 3 (constrained decoding) since Ollama exposes that uniformly via `format`. |
| CUDA | Ollama | Same. |
| CPU-only | Ollama | Same. |

---

## Embedding model

| Use case | Model | Notes |
|---|---|---|
| Action filter (Plan 3) | `sentence-transformers/all-MiniLM-L6-v2` (default) | 384-dim, 80 MB, CPU-fine. Right size for ranking 20–200 actions. Don't overthink. |
| Memory layer (Plan 5) | Same | Reuses Plan 3's embedding server via a new `/embed_text` endpoint. |

No change recommended. The role is "rank short strings against short strings" — bigger embeddings are overkill.

---

## Brain (the agent that does the work)

Out of scope for this doc — covered by Plan 1 (multi-brain CLI support). Reminder of which CLIs are targeted:

| Brain backend | Type | Notes |
|---|---|---|
| Claude Code (current) | Subprocess CLI | Existing default. |
| Codex CLI | Subprocess CLI | Plan 1 adds. |
| Gemini CLI | Subprocess CLI | Plan 1 adds. |
| Qwen CLI | Subprocess CLI | Plan 1 adds. |
| Ollama (local) | HTTP | Plan 1 adds. |
| Claude API | HTTP | **Not in Plan 1.** Would need its own `ClaudeAPIBrain` extending the `Brain` interface, parallel to the `ClaudeAPIProvider` for the LLM router in Plan 0. Defer until needed. |

---

## Model versions are config, not code

Every model string above is overridable in `~/.cicero/config.yaml`:

```yaml
deployment: local-cuda
llm:
  model: qwen3.6:1.7b      # whatever is current when you read this
tts:
  model: <new model name>
stt:
  model: <new model name>
```

Code defaults exist for the "no config file" case. They should match `DEFAULT_CONFIG.servers.*` in `src/config.ts` so the legacy backward-compat path keeps resolving cleanly. **When a new model ships and you want to update the default:** change both the provider class fallback (`config.model ?? "..."`) AND `DEFAULT_CONFIG.servers.*.model`. Keep them in sync.

---

## What this doc is NOT

- Not a hardware buying guide.
- Not a per-tier preset spec — see `src/backends/tiers.ts`.
- Not a benchmark methodology critique — consult primary sources for caveats (e.g., SeedTTS-eval is biased toward in-distribution audiobook voices).
- Not a moving target. **Dated May 2026.** Re-run the ecosystem review when this is more than 6 months old.

---

## Sources

- VibeVoice paper: https://arxiv.org/abs/2508.19205
- Moonshine v2: https://github.com/moonshine-ai/moonshine
- Silero VAD: https://github.com/snakers4/silero-vad
