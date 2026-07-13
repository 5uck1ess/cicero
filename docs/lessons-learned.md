# Cicero: Project Evolution & Lessons Learned

> A voice-controlled terminal assistant built over 3 days (March 10-12, 2026).
> 67 commits, 40 files, ~4,750 lines of code, 215 tests.

---

## Timeline & Strategy

### Day 1 (March 10): Scaffold → Voice Mode in 24 Hours

**Morning — The Big Bang Scaffold (commits 1-3)**
The project kicked off with a massive 1,590-line initial scaffold that laid out the full component architecture: daemon, router, executor, brain, speaker, terminal adapter, config system, and types. This was followed immediately by a resilience fix (servers failing gracefully) and a test suite.

**Strategy:** Get the entire skeleton deployed first, then iterate. This worked well — having the full component graph meant later features could be wired in without restructuring.

**Afternoon — Four Rapid Feature Phases (commits 5-10)**
- Phase 1: Tab-inject brain mode + TTS pipeline
- Phase 2: Wispr Flow listener with global hotkey
- Phase 3: Local LLM answering for simple questions
- Phase 4: Status command, action hot-reload, conversation history

Each phase was a focused commit with clear scope. The phased approach was sound, but the pace created technical debt that would bite later.

**Evening — The Fix Avalanche (commits 11-20)**
After the feature burst came 10 rapid-fire fixes:
- Model name bugs (using "default" instead of actual model name)
- Qwen3 `<think>` blocks leaking into responses
- Router using LLM params instead of original text for brain queries
- Keyword matching order wrong (LLM was classifying before cheaper keyword checks)
- Brain tab fallback when target tab not found

**Lesson: Fast feature development creates a wave of integration bugs.** Each component worked in isolation but the interactions between STT → Router → Executor → Brain → TTS revealed edge cases that weren't covered by the initial scaffold.

**Late Evening — Conversational Voice Mode (commits 21-35)**
The most ambitious stretch: whisper-server integration, streaming TTS, sentence boundary detection, LLM→TTS pipeline, sound effects, Swift hotkey helper, barge-in support, and processing state tracking. 15 commits in ~2 hours.

**Lesson: Streaming is hard.** The sentence-by-sentence TTS pipeline required careful boundary detection and state management. Barge-in (interrupting the assistant mid-speech) added significant complexity.

### Day 2 (March 11): Stabilization & STT

**Morning — Tab & Voice Polish (commits 36-47)**
- Tab ID/window ID mismatch fix (a fundamental Kitty terminal API misunderstanding)
- Silence detection tuning (1.5s → 0.7s as VAD took over)
- Fuzzy keyword matching for voice commands
- Whisper model upgrades (large-v3-turbo, Silero VAD)
- Phonetic alias maps for STT error correction
- Earcon sound effects for UX feedback
- Comprehensive test suite (171 tests)

**Lesson: STT accuracy is the foundation.** No amount of clever routing fixes speech-to-text errors. The phonetic alias system (`"cicero" → "cicero"`, `"sissero" → "cicero"`) was a pragmatic workaround, but the real fix was better whisper models and VAD.

**Late — MLX Whisper Migration (commits 48-49)**
Replaced whisper-cpp with MLX Whisper server for Apple Silicon acceleration. This was a significant architectural change — switching from C++ subprocess to Python HTTP server.

**Lesson: Platform-native ML inference matters.** MLX on Apple Silicon was noticeably faster than whisper-cpp, and the HTTP API was cleaner to integrate than parsing subprocess output.

### Day 3 (March 12): The Regex Reckoning

**Evening — Text Injection & The Breaking Point (commits 50-51)**
Added text injection commands ("type ls", "enter git status") and immediately hit regex fragility:
- "let's type LS" → classified as simple_question (filler not stripped)
- "type it in" → extracted "it in" as payload (pronoun not rejected)
- "type in LSC" → extracted "in lsc" (preposition captured as payload)

**Lesson: This was the project's inflection point.** Three distinct regex bugs from one feature addition proved that regex-first command parsing was fundamentally broken for natural speech. Fixing one pattern broke another. The regex approach couldn't scale.

**The LLM-First Refactor (commits 52-67)**
Research into how commercial voice assistants (OpenAI, Google, Alexa) handle NLU led to a complete architecture flip:
- Phase 0: Router overhaul (new prompt with few-shot examples, new intent types, unified filler stripping, context store extension) — 9 tasks
- Phase 1: Daemon refactor (remove all regex pre-filters, LLM classifies everything, multi-turn context, intent inheritance) — 9 tasks

16 commits in a disciplined TDD cadence. Test count went from 171 → 215.

---

## Mistakes & What They Taught

### 1. Regex-First Routing Was the Wrong Default

The original architecture ran voice input through three regex handlers *before* the LLM:
```
handleRuntimeToggle() → handleTabDirectedCommand() → handleTextInjection() → router.classify()
```

Each handler had its own filler word strip, its own pattern matching, its own edge cases. When a command didn't match any regex, it fell through to the LLM — but the LLM never got a chance to see commands that *partially* matched a regex.

**The fix:** Flip the architecture. LLM classifies everything first. Keyword matching is just a fast-path for exact matches with high confidence.

**Takeaway:** When you have an LLM available, use it as the primary classifier, not the fallback. Regex is for validation, not understanding.

### 2. Duplicated Filler Stripping

Three different methods in daemon.ts each stripped filler words with slightly different regex patterns:
- `handleRuntimeToggle`: stripped "okay, ok, hey, so, um, uh, alright, well, yeah, yes, please, now"
- `handleTextInjection`: same list + "let's, lets" (added as a bugfix)
- `handleTabDirectedCommand`: its own subset

When "let's type LS" broke, it was because `handleTextInjection` was missing "let's" in its filler list — but the other handlers had some of the same fillers. Three sources of truth for the same concern.

**The fix:** One `stripFillers()` function in `text-utils.ts`, called once at the top of handleCommand.

**Takeaway:** DRY isn't just about code size — it's about having one source of truth for behavior. Three regex strips means three places to forget to add "let's".

### 3. Not Testing Voice Patterns Early Enough

The initial test suite (commit 3) covered config, router, terminal, speaker, and context store — but didn't test actual voice command patterns like "type in ls" or "switch to the sales tab". The comprehensive test suite didn't arrive until commit 47, after 46 commits of untested voice interaction patterns.

**The fix:** 171 tests added retrospectively, then 44 more during the refactor.

**Takeaway:** Write voice command tests from day 1. Voice input is inherently fuzzy — "type ls", "type in ls", "let's type ls", "go ahead and type ls" should all be test cases, not discovered bugs.

### 4. Silence Detection Whiplash

Silence threshold was changed three times:
- Initial: some default
- Commit 42: increased to 1.5s/3% "for natural speech pauses"
- Commit 45: reduced to 0.7s because "VAD handles voice detection"

**Takeaway:** Don't tune silence detection by feel. Use VAD (Voice Activity Detection) from the start and let the ML model handle it. Hardcoded thresholds fight with the acoustic environment.

### 5. Model API Confusion

Two early bugs came from not understanding the mlx-lm API:
- Using "default" as the model name instead of the actual model identifier
- Using temperature 0.1 for classification (should be 0.0 for deterministic results)

**Takeaway:** Read the API docs, test with `curl` first. Small model APIs have quirks — `mlx-lm` serves models by their actual name, not by aliases.

### 6. The `<think>` Block Leak

Qwen3 models produce `<think>...</think>` reasoning blocks. These leaked into both router JSON output and local LLM conversational responses. The fix was simple (regex strip), but it broke TTS because `<think>` blocks are long internal monologues.

**Takeaway:** When using reasoning models for structured output, always use `/no_think` mode or strip reasoning blocks before downstream processing.

### 7. Tab ID vs Window ID

Kitty terminal's API has separate concepts for window IDs and tab IDs. The initial implementation confused them, causing commands to be sent to the wrong tab. This was a fundamental API misunderstanding that took a 273-line fix.

**Takeaway:** Read the terminal emulator API docs carefully. Test with `kitty @ ls --match all` before building abstractions.

---

## Model Selection Journey

Three ML models power Cicero's pipeline, each of which went through selection iterations.

### Router / Local LLM — Qwen3 → Qwen3.5-0.8B

| When | Model | Why Changed |
|------|-------|-------------|
| Day 1 initial | `Qwen/Qwen3-0.6B-Instruct` | First pick — small, fast, Instruct-tuned |
| Day 1 fix (commit 12) | `mlx-community/Qwen3-0.6B-Instruct-4bit` | Original was **gated on HuggingFace** (required auth approval). Switched to mlx-community's public 4-bit quant — same model, no auth gate, optimized for Apple Silicon |
| Day 2 (commit 44) | `mlx-community/Qwen3.5-0.8B-MLX-4bit` | **+38% reasoning improvement.** Qwen3.5 was a newer release with better instruction following. The 0.8B size is still fast enough for real-time classification on M-series chips. This is the final model. |

**Key decisions:**
- **4-bit quantization** was a deliberate choice — the router only needs to output ~60 tokens of JSON classification, so accuracy loss from quantization is negligible while inference speed doubles.
- **`/no_think` mode** was required because Qwen3/3.5 models produce `<think>...</think>` reasoning blocks by default. These waste tokens and leak into output. The `/no_think` prefix in the system prompt suppresses them, and a regex strip catches any that leak through.
- **Temperature 0.0** for routing (deterministic classification) vs **0.7** for local-llm conversational answers.
- **max_tokens: 100** for routing (JSON output is ~60-80 tokens) vs configurable for conversation (default 150).

### TTS — Qwen3-TTS-0.6B

| Model | Details |
|-------|---------|
| `mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16` | Only model used, never changed |

**Key decisions:**
- **wav format only** — mlx-audio doesn't support mp3 encoding without ffmpeg. We output wav directly.
- **`lang_code="en"` is required** — the default `"a"` causes the model to produce French/Chinese output randomly.
- **Sentence chunking for streaming** — TTS generates sentence-by-sentence (plays sentence N while generating N+1). Only chunks responses >300 chars to avoid voice inconsistency between short fragments.
- **~5s cold start** on first request — solved by pre-warming the server with a dummy request on startup.

### STT — whisper-cpp → MLX Whisper

| When | Model/Engine | Why Changed |
|------|-------------|-------------|
| Day 1 | whisper-cpp (C++ subprocess) | Initial implementation — parsed subprocess stdout for transcriptions |
| Day 2 early | whisper-cpp + Silero VAD | Added Voice Activity Detection config, but VAD required a **separate ONNX model** that whisper-cpp didn't bundle. Had to remove `--vad` flags. |
| Day 2 (commit 49) | `mlx-community/whisper-large-v3-turbo` (MLX Whisper) | **Complete rewrite.** Replaced C++ subprocess with a Python FastAPI server using `mlx_whisper.transcribe()`. Faster on Apple Silicon, cleaner HTTP API, model pre-loaded in memory. |

**Key decisions:**
- **large-v3-turbo** over large-v3 — turbo variant is ~3x faster with minimal accuracy loss. Good tradeoff for real-time voice.
- **HTTP API** over subprocess — the whisper-server runs as a FastAPI service on port 8083. Transcription is a simple POST request (~100-200ms) vs ~500ms for whisper-cli subprocess spawning.
- **Model pre-warming** — on startup, sends a silent WAV to force model loading. Without this, the first real transcription takes 5-10s.
- **Silero VAD** — the original whisper-cpp experiment was abandoned when its separate ONNX dependency proved flaky. Current streaming VAD is configured through the top-level `vad` block and does not use a model path.

### Why All MLX?

Every model runs through Apple's MLX framework — this was the single most impactful infrastructure decision:
- **Unified runtime** — one framework for routing, TTS, and STT (no mix of ONNX/PyTorch/C++)
- **Apple Silicon native** — uses Metal GPU acceleration automatically, no CUDA
- **Memory efficient** — models share the unified memory architecture (no GPU↔CPU copies)
- **Community quants** — `mlx-community` on HuggingFace provides pre-quantized models ready to run
- **Offline** — entire pipeline runs locally with zero cloud dependencies

The tradeoff: MLX is Apple-only. This project can't run on Linux/Windows without replacing all three model servers.

---

## What Worked Well

### 1. Phased Feature Development
The Day 1 phases (1-4) were clean, focused, and buildable. Each phase had a clear goal and resulted in working functionality. The Phase 0/1 refactor on Day 3 continued this pattern effectively.

### 2. Component Architecture
The initial scaffold's separation of concerns (daemon, router, executor, brain, speaker, terminal, listener) held up through the entire project. New features could be added without restructuring the core.

### 3. TDD for the Refactor
The LLM-first routing refactor was done entirely TDD: write test → verify fail → implement → verify pass → commit. This caught issues early (like action ordering conflicts between `tab_switch` and `tab_command`) and gave confidence to delete 200+ lines of regex code.

### 4. MLX Stack on Apple Silicon
Running Qwen3.5-0.8B for routing and MLX Whisper for STT locally on Apple Silicon gave low-latency inference without cloud dependencies. The entire voice pipeline runs offline.

### 5. Phonetic Aliases
A simple lookup table that maps STT errors to correct words (`"sissero" → "cicero"`) was more effective than trying to improve the STT model's vocabulary. Pragmatic and cheap.

### 6. Streaming TTS Pipeline
Sentence boundary detection + streaming TTS playback made responses feel instant. The assistant starts speaking as soon as the first sentence is ready, not after the full response is generated.

---

## Architecture Evolution

```
Day 1 (v1):  Voice → Wispr Flow → Regex handlers → LLM fallback → Executor
Day 2 (v2):  Voice → Whisper STT → Regex handlers → LLM fallback → Executor
Day 3 (v3):  Voice → Whisper STT → stripFillers → LLM Router → Intent dispatch → Executor
                                                      ↑ conversation context
                                                      ↑ few-shot examples
                                                      ↑ intent inheritance
```

The progression from regex-first to LLM-first was the most significant architectural decision. It reduced daemon.ts complexity, improved natural language understanding, and made adding new commands trivial (just add examples to config.yaml).

---

## Stats

| Metric | Value |
|--------|-------|
| Development time | ~3 days |
| Total commits | 67 |
| Files changed | 40 |
| Lines of code | ~4,750 |
| Tests | 215 |
| Python servers | 2 (TTS, STT) |
| TypeScript modules | ~15 |
| Local ML models | 3 (Qwen3.5-0.8B router, Qwen3-TTS, MLX Whisper) |
| Regex handlers deleted | 3 (handleRuntimeToggle, handleTabDirectedCommand, handleTextInjection) |
| Lines of regex deleted | ~200 |
