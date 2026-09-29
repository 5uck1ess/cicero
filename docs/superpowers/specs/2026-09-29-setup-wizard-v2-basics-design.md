# Setup wizard v2, part 1: privacy, accounts and hardware-sized models

Status: design, not implemented. Date: 2026-09-29. Revision 4, after three rounds of GPT-6 Astra's adversarial review.
Builds on: `2026-09-24-setup-wizard-design.md` (the current guided setup). This spec covers only what changes; the v1 rules stand unless a section below overrides them.
Co-designed with GPT-6 Astra: an independent proposal, merged, then reviewed against the code.

## Why

Cicero has to install cleanly for anyone, on their own hardware and accounts. The owner's box shows what is hand-tuned today and what the wizard should decide instead.

- **The helper model was hand-picked for a 24 GB card.** It started as Gemma 4 26B-A4B (~15 GB resident), then became Gemma 4 E4B (4.0 GB resident, measured with `nvidia-smi`, 64k context, q8 KV cache). The right pick depends on the machine.
- **The CUDA tier preset is behind the speech stack that actually runs on the reference box.** The preset (`src/backends/tiers.ts`) uses faster-whisper, Kokoro and a 4B Qwen. The reference box runs audio.cpp Nemotron STT + Pocket TTS.
- **Choosing "LLM" routing in the wizard writes nothing** (`src/setup/pickers.ts:192`). Without a summarizer URL the LLM classifier is absent (`src/brain/index.ts:62`), so a fresh install gets lexical routing only.
- **Which account pays is invisible.** `claude` prefers `ANTHROPIC_API_KEY` over the logged-in subscription (`src/brain/claude-code.ts:19`). The Grok CLI's bundled README says "The API key takes precedence over browser credentials" (`~/.grok/README.md`, installed CLI).
- **Nothing asks what may leave the machine.**

The full v2 is split into three specs, and this is part 1.
- **Part 2 (employees):** templates, any agent as an employee, clean memory, routing for arbitrary names, a shareable office pack, and editing an existing config.
- **Part 3 (memory):** per-employee private memory (Mnemosyne for Hermes employees, a private Hindsight bank otherwise) and shared Hindsight office memory, filled by a batched local extraction job.

## Scope

- **In:** Linux + NVIDIA (`local-cuda`) and Apple Silicon (`local-mlx`).
- **Out:** CPU-only and Windows keep today's behavior, apart from the platform-neutral Privacy and Accounts steps.

## Step order (changes in bold)

1. **Privacy** (new)
2. Machine (extended)
3. **Accounts** (new)
4. Think → renamed **Front desk**
5. **Helper** (new; absorbs Router)
6. Hear
7. Speak
8. Agent (privacy-aware)
9. Tasks
10. **Test** (new)
11. Save

### 1. Privacy (new, first)

The step asks one question: **What may leave this machine?**

- **Nothing, unless I allow it** (default). The front desk, helper and speech must be local. Everything else that reaches the network must be allowed one item at a time, with a plain sentence saying what leaves. This covers:
  - **Agents:** a cloud coding agent (Claude Code, Codex, Grok) sends your prompts and the code it reads to that company.
  - **Notifications:** Telegram carries message text.
  - **Task boards:** a hosted board holds task text.
- **Conversation may use cloud models.** Cloud is allowed for the front desk and agents; the helper and speech stay local.

The choice is written as `privacy: { mode: local | cloud, allow?: [agent | telegram | board] }`.

This is a **declared policy, not a firewall**. The wizard enforces it when options are chosen: disallowed options are shown disabled, with the reason. In `local` mode, `cicero doctor` checks what it can see and warns on:
- a non-loopback model endpoint (`brain`, `llm` or the helper);
- a cloud CLI agent without `allow: [agent]`;
- a Telegram block without `allow: [telegram]`;
- an enabled task board (`notify.kanban`) without `allow: [board]`.

`cloud` mode allows the front desk and agents, so its only check is the Telegram and board allowances.

Doctor cannot see what a CLI agent does on the network, and the Privacy step says so. A config with no `privacy` key (every existing config) produces no privacy warnings.

### 2. Machine (extended)

The step keeps today's detection (`src/setup/system.ts`) and adds a **model budget**: the memory models may use at once.

- **CUDA:** total VRAM − speech reservation (3.5 GB for audio.cpp Nemotron + Pocket, measured; 2 GB for the Python presets, estimate) − 1.5 GB headroom.
- **Apple Silicon:** 60% of unified memory − speech reservation (2 GB, estimate).

Memory that other processes already hold (`nvidia-smi` used vs total) is shown next to the budget as a warning, not subtracted. It may be transient, and the v1 `gpuWarning` pattern already covers it.

The budget is recomputed whenever the Hear or Speak choice changes. It is shown as a bar with each planned model's footprint on it.

### 3. Accounts (new)

The step detects accounts read-only and stores only the user's choices. It covers two fixed lists:
- **Agent logins:** Claude Code, Codex and Grok, shown in the table below.
- **Cloud front-desk keys:** the existing OpenAI-compatible presets in `src/backends/llm/openai.ts:22` (OpenAI, OpenRouter, Groq, Together, DeepSeek and others), plus two new presets:
  - `cerebras`: `https://api.cerebras.ai/v1`, key in `CEREBRAS_API_KEY`.
  - `xai`: `https://api.x.ai/v1`, key in `XAI_API_KEY`.

  Both are OpenAI-compatible chat endpoints. The reference box's Hermes profiles use them that way today. Anthropic is an agent only in part 1, because its API is not OpenAI-compatible and the `llm` backend has no Anthropic client.

**Login detection** uses each CLI's own status command where one exists, falling back to known locations.

| Provider | Login locations | Key variable |
|---|---|---|
| Claude | `$CLAUDE_CONFIG_DIR` or `~/.claude/.credentials.json` on Linux; the Keychain on macOS | `ANTHROPIC_API_KEY` |
| Codex | `$CODEX_HOME` or `~/.codex/auth.json` (`auth_mode`) | `OPENAI_API_KEY` |
| Grok | `~/.grok/auth.json` | `XAI_API_KEY` |

- The exact status commands and the Codex keyring case are **verified during implementation**. Any detection that is not verified shows "unknown" rather than a guess.
- For each provider the step shows the credential the tool will most likely use, and whether it is a subscription or per-token billing.
- When a key would override a login, the step offers "Use my subscription". This writes `unset_env: [<KEY>]` for that agent. That only removes the key from the agent's environment (`src/brain/subprocess-cli.ts:190`), so the step says "falls back to your login". The Test step then asks the CLI which credential it reports, where the CLI can say.

### 4. Front desk (was Think)

This is what answers when you talk. It writes **`brain`**, the key every conversation turn goes to (`src/web-voice/turn.ts:207`), using existing brain backends only. The v1 Provider step wrote `llm` instead, which only feeds the speech sidecar's summarizer (`src/sidecar/service.ts:10`). Part 1 stops showing that step, and existing `llm` keys are left alone.

The step offers two kinds of front desk:
- **A model** (fast, no tools; recommended). Written as `brain.backend: ollama` or an OpenAI-compatible backend with `base_url` and `model` (`src/setup/pickers.ts:233`, `src/brain/index.ts:193`).
  - **Local mode:** the Model fit rules below pick it.
  - **Cloud mode:** also lists the cloud presets whose key was found in Accounts. Adding `cerebras` and `xai` to the presets makes them valid brain backends too, because both lists come from the same `OPENAI_COMPATIBLE_BACKENDS` (`src/backends/llm/openai.ts:67`). The user picks one; there is no automatic speed ranking.
- **An agent** (slower, can use tools). This is v1's behavior: the Agent step's choice becomes `brain` itself, and there is no separate front-desk model.

### 5. Helper (new; absorbs Router)

One local model does background work:
- spoken-summary codas;
- routing to employees (once part 2 adds employees);
- optionally, history compaction and call minutes.

**Lifecycle.** In part 1, Cicero does **not** own the helper process. The helper is a model on a runtime that serves more than one model:
- llama-swap or llama.cpp `llama-server` on CUDA;
- Ollama or LM Studio on either platform.

The step detects a running runtime with the existing Think probes (`src/setup/pickers.ts:123`), then lists that runtime's models: `/v1/models` for llama-swap, llama-server and LM Studio, and `/api/tags` for Ollama. The chosen helper model must appear in the list before the step turns green; a missing one gets its pull or download command.

**Single-model runtimes.** The step does not try to tell llama-swap from a bare `llama-server`; both answer the same health probe. It counts the listed models instead. With exactly one model listed, it treats the runtime as single-model: the helper and a model front desk must be that same model, and the step offers llama-swap or Ollama for running two. With no runtime found, the step shows install steps. This keeps the v1 rule that Cicero does not install vendor runtimes. Cicero's own MLX provider, which starts one model from `.venv` (`src/backends/llm/mlx-lm.ts:127`), stays the front-desk option and is not used for the helper.

**Config it writes**, all through existing keys:

- **When a helper is set:** `web_voice.tldr.summarizer_url` and `web_voice.tldr.summarizer_model`. Spoken codas and `summarizerClassifier` read these (`src/brain/index.ts:62`), which fixes the no-op LLM router.
- **Checkbox "Compress long conversations":** `brain.history_compaction.enabled: true` (`src/daemon.ts:1178`), using the same endpoint.
- **Call minutes** (`notify.call_minutes`, `src/daemon.ts:1680`) need Telegram. The wizard does not set up Telegram in part 1, so this checkbox waits for the Channels step.

**Routing:**
- Exact and fuzzy name match runs first, with no model.
- The helper classifier runs over the current roster second. It only takes effect with ACP office lanes (`src/brain/index.ts:259`), which is part 2.
- The fine-tuned Laya sidecar moves under **Advanced**, labeled "needs a checkpoint trained on your roster".

**No helper** (only possible in `cloud` mode; see fit rule 1): the step shows "Skipped" and writes no summarizer keys. The compaction checkbox is hidden, Test skips the Helper probe, and long replies end with the generic "say details" coda instead of a summary (`src/web-voice/turn.ts:529`).

**The helper is local-only in part 1.** Both summarizer clients send only `Content-Type` (`src/brain/history-compactor.ts:25`, `src/brain/index.ts:71`), so a cloud helper would need an auth contract first.

### 6–7. Hear and Speak

- **CUDA:** recommend audio.cpp (Nemotron + Pocket TTS on port 8092) when the binary and model directory are detected. Otherwise recommend today's preset. Detection is unchanged (`docs/setup.md`, "Speech choices on a CUDA box"). The wizard does not download audio.cpp weights; missing ones get install steps.
- **Apple Silicon:** MLX STT + MLX TTS, unchanged.
- **Play sample:** each TTS option with a running engine gets one; it synthesizes one sentence and plays it in the browser.
- **Voice cloning** is a later add-on with a consent check.

### 8. Agent (privacy-aware)

This is today's step, with two changes.

**Where the agent goes:**
- If the front desk is **an agent**, this choice is written to `brain`, as in v1.
- If the front desk is **a model**, the agent is written to `brain.escalate` (`src/brain/index.ts:236`). The front desk hands a turn to it when the user says one of its trigger phrases ("think hard", "ask the agent"). `brain.escalate` accepts ACP commands only, so the list shows ACP agents: `hermes acp`, `codex-acp` via `bunx`, and a Claude Code ACP adapter. Which adapters work for Claude and Grok is **verified during implementation**; unverified ones are not listed. The agent is optional; skipping it gives a talk-only setup.

**Privacy:** in `local` mode, cloud CLI agents are disabled until the user ticks "Allow this agent to use the cloud", which adds `agent` to `privacy.allow`. A local agent (an ACP harness pointed at a local model) needs no exception.

### 9. Tasks

This is today's step, with one change. The board probe (`src/setup/pickers.ts:275`) runs the board's CLI, which may send a request to a hosted board. In `local` mode, before the probe runs, the step asks "Allow task text to go to this board?"; ticking it adds `board` to `privacy.allow`. Without that tick the step can only choose "No board".

### 10. Test (new)

Test runs against the **engines already running**, on the user's click. It checks:

1. **Hear:** a bundled 3-second WAV is sent to the configured STT endpoint, and the transcript is compared with the expected text.
2. **Front desk:** one chat completion.
3. **Helper:** one summary of a bundled long reply.
4. **Speak:** a sentence is synthesized and played in the browser (playback only; no microphone in part 1).
5. **Memory (CUDA only):** per-process use from `nvidia-smi --query-compute-apps`, matched to the speech and runtime PIDs where possible. The rest shows as "other GPU use". This is how the reference box was measured. The existing aggregate telemetry (`src/platform/gpu.ts:21`) is the fallback, labeled "whole GPU". Mac measurement is deferred.

Rules:
- Each probe has a timeout and a Cancel button. Nothing is started or stopped by Test.
- An engine that isn't running is reported as "not running", with its start command, rather than as a failure.
- Results are cleared when the draft changes.
- Config errors still block saving, as today (`src/setup/draft.ts:86`). Probe failures can be acknowledged and saved past.

### Channels and Install

Both are unchanged from v1: still unbuilt preview steps (`src/setup/steps.ts:49`), with the manual instructions in `docs/setup.md`. The Privacy step's `telegram` allowance therefore only matters when the user adds Telegram by hand later; doctor then warns if it is not allowed.

### 11. Save

The v1 write rules are unchanged: write only when no config exists, and back up an invalid one only by explicit choice (`src/setup/write.ts:207`). Editing an existing config moves to part 2, where adding employees needs it.

## Model fit rules

**Footprint** means resident memory in llama.cpp with 64k context and q8 KV cache. The measured and estimated values:

| Model (Gemma 4, Google QAT q4_0 GGUF) | Footprint |
|---|---|
| E2B | 2.5 GB (estimate) |
| E4B | 4.0 GB (measured) |
| 12B | 8.5 GB (estimate) |
| 26B-A4B | 15 GB (measured ~14–15) |
| 31B | 20 GB (estimate) |

**What these numbers assume.** The wizard does not configure external runtimes. For llama-swap it shows a copyable model entry with these settings. For Ollama and LM Studio, whose default context and cache differ, it shows the settings to change and labels every fit "estimate". An MLX front desk uses the GGUF row, also labeled "estimate". Only a CUDA Test measurement replaces an estimate; on a Mac everything stays an estimate in part 1.

**Rules:**

1. **Helper:** E4B if it fits in the budget, else E2B.
   - In `local` mode, if even E2B doesn't fit, the step says this machine can't run the helper locally. The user must use a smaller speech preset or switch to `cloud` mode, where part 1 runs without a helper.
2. **Local front desk:** the largest model **larger than the helper** whose footprint fits in the budget minus the helper. If none fits, the front desk reuses the helper's own instance; a second copy of the same model is never loaded.

**Worked examples:**

| Machine | Budget | Helper | Front desk |
|---|---|---|---|
| 24 GB card | 24 − 3.5 − 1.5 = 19 GB | E4B | 26B-A4B (15 GB of the 15 left) |
| 16 GB card | 16 − 3.5 − 1.5 = 11 GB | E4B | E4B reused (7 GB left; the 12B needs 8.5 GB) |
| 32 GB Mac | 0.6 × 32 − 2 = 17.2 GB | E4B | 12B (13.2 GB left) |
| 64 GB Mac | 0.6 × 64 − 2 = 36.4 GB | E4B | 31B (32.4 GB left) |

The 24 GB example is what the reference box ran before the swap: 21.9 GB used, including a 3 GB Laya router that this design no longer needs.

The helper stays E4B even on big machines. On the reference box, over 8 spoken summaries and 3 conversations, it matched the 26B on summaries and compression, and was faster (0.26 s vs 0.40 s per summary). Memory-extraction quality is a part 3 question.

**Pinned artifacts** (all confirmed on Hugging Face on 2026-09-29):
- `google/gemma-4-E2B-it-qat-q4_0-gguf`
- `google/gemma-4-E4B-it-qat-q4_0-gguf`
- `google/gemma-4-12B-it-qat-q4_0-gguf`
- `google/gemma-4-26B-A4B-it-qat-q4_0-gguf`
- `google/gemma-4-31B-it-qat-q4_0-gguf`

Ollama tags and MLX conversions are **verified during implementation**. Where no verified tag exists, the step offers only the models it can confirm.

## Config changes

- **New key:** `privacy: { mode: "local" | "cloud", allow?: ("agent" | "telegram" | "board")[] }`.
  - It is added to the top-level allowlist in `src/config-validation.ts:318`.
  - `mode` is required when `privacy` is present.
  - `allow` is an optional array of those strings.
  - Unknown values are errors.
- **Written using existing keys:** `web_voice.tldr.*`, `brain.history_compaction.enabled`, `notify.call_minutes`, per-brain `unset_env`.

## Testing

- **Unit tests:**
  - Budget math and fit rules at every boundary, including the four worked examples and a budget too small for E2B.
  - Accounts detection with fixture homes and env: login only, key only, key overrides login, `CLAUDE_CONFIG_DIR` / `CODEX_HOME` overrides.
  - Privacy gating per step.
  - Router and helper contributions: the URL is written and the checkboxes write their keys.
  - `privacy` validation.
  - Doctor privacy warnings.
- **Server tests:** the existing setup-server pattern for Privacy, Accounts, Helper and Test, including probe timeout, cancel and invalidation on draft change.
- **Manual:** a full run on the reference Linux box and on an Apple Silicon Mac, recorded in the PR.

## Out of scope (parts 2 and 3, or later)

- Employees, the office pack, editing an existing config, and per-employee memory (parts 2 and 3).
- A cloud helper, which needs an auth contract.
- Cicero-managed helper and runtime installs.
- A microphone test and Mac memory measurement.
- Voice cloning, Windows, CPU-only tuning, automatic provider speed ranking.
