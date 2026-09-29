# Setup wizard v2, part 1: privacy, accounts and hardware-sized models

Status: design, not implemented. Date: 2026-09-29.
Builds on: `2026-09-24-setup-wizard-design.md` (the current guided setup). This spec only covers what changes.
Co-designed with GPT-6 Astra (independent proposal, then merged).

## Why

Cicero has to install cleanly for anyone, on their hardware, with their accounts. The owner's own box shows what is hand-tuned today and what the wizard should decide instead:

- The helper model was hand-picked for a 24 GB card: Gemma 4 26B-A4B (~14 GB), then Gemma 4 E4B (~4 GB measured with `nvidia-smi`). The right pick depends on the machine. A Mac with lots of unified memory can afford a bigger one.
- The CUDA tier preset (`src/backends/tiers.ts`: faster-whisper, Kokoro, a 4B Qwen) is behind the speech stack that actually runs on the reference box (audio.cpp Nemotron STT + Pocket TTS).
- Routing to named employees needs a model. Choosing "LLM" routing in the wizard contributes nothing to the config (`src/setup/pickers.ts:192`), and without a summarizer URL the LLM classifier is absent (`src/brain/index.ts:62`). A fresh install therefore has lexical routing only.
- Which account pays is invisible. `claude` prefers `ANTHROPIC_API_KEY` over the logged-in subscription (`src/brain/claude-code.ts:19`). The Grok CLI docs state its API key takes precedence over the browser login. Either way, a user thinks they're on a subscription and is billed per token.
- Nothing asks what may leave the machine.

The full v2 is split into three specs. This is part 1. Part 2 covers employees: templates, any agent as an employee, clean memory, routing for arbitrary names, and a shareable office pack. Part 3 covers memory: per-employee private memory (Mnemosyne for Hermes employees, a private Hindsight bank otherwise) and shared Hindsight office memory filled by a batched local extraction job.

## Scope

- **In:** Linux + NVIDIA (`local-cuda`) and Apple Silicon (`local-mlx`).
- **Out:** CPU-only and Windows keep today's behavior, apart from the Privacy and Accounts steps, which are platform-neutral.

## Step order (changes in bold)

1. **Privacy** (new)
2. Machine (extended)
3. **Accounts** (new)
4. Think → renamed **Front desk** (defaults changed)
5. **Helper** (new; absorbs Router)
6. Hear (defaults changed)
7. Speak (defaults changed)
8. Agent, Tasks (unchanged)
9. **Test** (new)
10. Save (extended: edit an existing config)

### 1. Privacy (new, first)

The step asks one question: **What may leave this machine?**

- **Nothing: everything runs here** (default). The front desk, helper and speech must be local. Cloud choices in later steps are shown disabled with the reason.
- **Conversation may use cloud models.** Cloud is allowed for the front desk and agents. The helper and speech stay local by default and can be switched to cloud on their own steps.

The choice is written as `privacy: { mode: local | cloud }`. `cicero doctor` warns when a configured endpoint is non-loopback while the mode is `local`. A LAN host counts as cloud unless it is listed in `privacy.trusted_hosts`.

### 2. Machine (extended)

The step keeps today's detection (`src/setup/system.ts`) and adds a **memory budget**: how much the models can use at once.

- **CUDA:** total VRAM minus measured reservations. Speech takes 3.5 GB (audio.cpp Nemotron + Pocket, measured on the reference box). Keep 1.5 GB of headroom.
- **Apple Silicon:** 60% of unified memory (the rest is for macOS and apps), minus speech (MLX STT + TTS, ~2 GB estimated; measured at the Test step).

The budget is shown as a bar with each planned model on it, like the office map's VRAM bar. Every later default reads the budget. All numbers are starting estimates; the Test step measures the real total.

### 3. Accounts (new)

Detection is read-only, and nothing is stored except the user's choices.

| Provider | Subscription login | Pay-per-use key |
|---|---|---|
| Claude | `~/.claude/.credentials.json` | `ANTHROPIC_API_KEY` |
| ChatGPT / Codex | `~/.codex/auth.json` with `auth_mode: chatgpt` | `OPENAI_API_KEY` |
| Grok | `~/.grok/auth.json` | `XAI_API_KEY` |

Any other OpenAI-compatible key in the environment is listed as a cloud endpoint (for example Cerebras, DeepSeek or OpenRouter).

For each provider the step shows **which credential will actually be used** and whether it is a subscription or per-token billing. When a key would override a login, it offers "Use my subscription". That option writes `unset_env: [<KEY>]` for that brain, the mechanism that already exists in `src/brain/claude-code.ts:21`.

### 4. Front desk (was Think; defaults changed)

This is the model that answers everyday talk.

- **Local mode:** pick from the hardware table below and reuse the helper when the budget is tight.
- **Cloud mode:** also offer the cloud endpoints found in Accounts. Default to the fastest configured one; otherwise keep the local pick.

### 5. Helper (new; absorbs Router)

One local model does the background jobs: spoken-summary codas, call minutes, history compaction, and routing to employees.

- **Model:** sized from the budget (table below).
- **Runtime:** reuses a running llama.cpp/llama-swap, Ollama or LM Studio if found. Otherwise the Install step sets one up: llama.cpp on CUDA, MLX-LM on Apple Silicon.
- **Written config:** `web_voice.tldr.summarizer_url` + `summarizer_model`. This is the endpoint that summaries, call minutes, compaction and `summarizerClassifier` already share (`src/brain/history-compactor.ts:15`, `src/brain/index.ts:62`). This fixes the no-op LLM router.
- **Routing:**
  - Exact and fuzzy name matching runs first, with no model.
  - The helper classifies over the current roster next.
  - The fine-tuned Laya sidecar moves under **Advanced**, labeled as needing a checkpoint trained on your roster.
- **Cloud helper:** allowed only in cloud mode, and only by explicit choice on this step, with a note that background jobs see whole conversations.

### 6–7. Hear and Speak (defaults changed)

- **CUDA:** recommend audio.cpp (Nemotron + Pocket TTS on port 8092) when the binary and models can be installed. Otherwise use today's preset. The existing detection stays (`docs/setup.md`, "Speech choices on a CUDA box").
- **Apple Silicon:** MLX STT + MLX TTS (unchanged).
- **Voices:** each voice option gets a **Play sample** button. Voice cloning is out of scope for v2 part 1; it's a later add-on with a consent check.

### 9. Test (new)

Test runs after Install and before Save, against the draft config. It starts the engines, then walks the user through:

1. Say a sentence → shows the transcript.
2. The front desk answers aloud.
3. A long answer is shortened by the helper.
4. The actual memory in use is read back (from `nvidia-smi` on CUDA, from process RSS on Apple Silicon) and compared with the budget.

A failure shows which part failed and a fix. The user can still save after acknowledging it, as today (`src/setup/checks.ts`).

### 10. Save (extended)

Setup can now **edit an existing config**, not only write a missing one. It shows a diff, backs the old file up as `config.yaml.bak-<timestamp>`, and writes only the keys the wizard owns. Keys it doesn't know are preserved. Re-running setup is safe.

## Hardware table (starting candidates)

These are Gemma 4 models, quantized (Google's QAT q4_0 GGUF on CUDA, MLX 4-bit on Apple Silicon). All sizes listed below exist on Hugging Face as of 2026-09-29: E2B, E4B, 12B, 26B-A4B, 31B.

| Budget after speech | Helper | Local front desk |
|---|---|---|
| < 4 GB | E2B | reuse helper |
| 4–10 GB | E4B | reuse helper |
| 10–18 GB (e.g. 24 GB card) | E4B | 12B |
| 18–30 GB (e.g. 48 GB Mac) | E4B | 26B-A4B |
| ≥ 30 GB (e.g. 64 GB+ Mac) | E4B, or 26B-A4B when the front desk is cloud | 26B-A4B or 31B |

The helper stays E4B even on big machines. On the reference box it matched the 26B on spoken summaries and compression, and was faster: 0.26 s vs 0.40 s per summary. Memory extraction quality is a part 3 concern.

## Config changes

- New: `privacy: { mode, trusted_hosts? }`.
- Written by new steps using existing keys: `web_voice.tldr.*`, per-brain `unset_env`.
- Validation: `privacy.mode` must be `local` or `cloud`. In `local` mode, a non-loopback endpoint that isn't in `trusted_hosts` is a doctor **warning** (not an error), so existing configs keep booting.

## Testing

- **Unit tests:**
  - Budget math per platform with fixture facts.
  - Table lookups at each boundary.
  - Accounts detection with fixture home dirs, including key-overrides-login.
  - Privacy gating of options.
  - The router now contributes the helper URL.
  - Save-over-existing (diff, backup, unknown keys preserved).
- **Server tests:** the existing setup-server test pattern for the new steps.
- **Manual:** a full run on the reference Linux box and on an Apple Silicon Mac, recorded in the PR.

## Out of scope (parts 2 and 3, or later)

- Employees, office pack and per-employee memory (parts 2 and 3).
- Voice cloning, Windows, CPU-only tuning.
- Managing Hermes's own helper settings (Hermes profiles keep their own config; part 2's Hermes adapter can mirror the helper choice).
