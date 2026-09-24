# First-run setup: bootstrap script + setup GUI

Status: design, not implemented. Date: 2026-09-24.

## Problem

First run today is the seven-step `docs/setup.md`: per-OS package installs,
hand-created venvs, a hand-written `~/.cicero/config.yaml`, then `cicero doctor`.
Worse, a missing config is not an error — `loadConfig` (`src/config.ts:1112`)
silently falls back to `DEFAULT_CONFIG`, which is macOS/MLX-flavored
(`src/config.ts:1038,1088`), so a Linux or Windows user gets a daemon that boots
and then fails at engine start.

## Shape

Two pieces, split by what each can safely do:

1. **Bootstrap script** (`scripts/install.sh`, `scripts/install.ps1`) — only the
   prerequisites a browser page cannot provide: Bun (the `packageManager` pin),
   uv, and a check for ffmpeg/openssl; clone or update the repo; `bun install`;
   then exec `cicero setup`. No models, no venvs, no config.
2. **`cicero setup`** — a new CLI command that runs a setup-mode web server
   (not the daemon) and walks the operator through the rest in a browser.

## Setup mode

- Does not call `loadConfig`. A missing config is the normal case. An invalid
  one is shown with its error and an explicit "back up and start fresh" choice
  (`config.yaml` → `config.yaml.bak-<timestamp>`); never auto-overwritten.
- Binds `127.0.0.1` on its own port by default and prints a one-time URL with
  a random setup token to stdout. Reuses the dashboard's loopback Host/Origin
  gate and custom-header CSRF pattern (`src/dashboard/server.ts:70-87`).
- `--lan` for headless boxes: binds LAN, uses `ensureTls` (`src/web-voice/tls.ts:358`)
  for a self-signed cert, same token. Plain HTTP off-loopback is refused, as
  `assertWebTlsPolicy` does today.
- Exits after hand-off. It is a one-shot process, not a daemon surface.

## Wizard steps

1. **System.** Detect OS, arch, Apple Silicon (+ macOS ≥14 via
   `src/platform/python.ts`), NVIDIA GPU + VRAM (lift the `nvidia-smi` probe out
   of `doctor.ts:1090-1112` into a shared function), RAM, free disk in the repo
   checkout (venvs live there, `requirements/README.md`) and in the HF cache.
   Recommend a starting tier from `src/backends/tiers.ts`
   (`local-mlx` / `local-cuda` / `local-cpu`); every later step pre-selects
   from it but stays editable.

2. **LLM provider.** A selector for the local runtime the operator already
   uses:
   - **llama.cpp** → `llm.backend: llama-cpp` (probe `:8080/v1/models`)
   - **Ollama** → `llm.backend: ollama` (probe `:11434/api/tags`)
   - **LM Studio** → `llm.backend: openai` with a local base URL
     (probe `:1234/v1/models`; `llm/openai.ts:94` already treats local
     OpenAI-compatible servers as keyless)
   - **Other OpenAI-compatible URL** (vLLM, llama-swap, a LAN host) and the
     existing cloud presets (`llm/openai.ts:23-67`) with an API key field.

   Probe all known default ports in parallel on page load and pre-select what
   is running. On select, list the models that runtime reports and pick from
   the list — no free-typed model names for local runtimes. If the chosen
   runtime is not running, show its official install link and a "re-check"
   button. The wizard does **not** install Ollama, LM Studio, or llama.cpp;
   those are system-level installs owned by their vendors.

3. **Brain.** The coding agent Cicero voices. Detect installed CLIs on `PATH`
   (the same `which` checks doctor uses for the brain binary) and offer the
   supported brains from `docs/brains.md`; ACP / OpenAI-compatible brains take a
   command or URL. Detect only; no installs.

3b. **Task board (optional).** Cicero is only the voice; the kanban board is
   owned by an external management system. A selector for the systems the
   board presets support (`src/notify/board-presets.ts`, `docs/notifications.md`
   § Board presets): **Hermes**, **Multica**, **Paperclip**, or **None**.
   - Auto-find: check `PATH` for `hermes`, `multica`, and `paperclipai` and
     pre-select what is installed (several found → the operator picks one;
     `notify.kanban` watches a single board).
   - Probe: run the preset's list command once through the same bounded
     runner the watch uses (`runBoundedCommand`, argv only) and show
     "found N tasks" or the error. A failed probe does not block setup; it
     writes nothing and the step can be retried or skipped.
   - Paperclip needs a company: use `PAPERCLIP_COMPANY_ID` or the active
     `paperclipai context` profile when present, else ask for the id and pass
     `-C <id>`. The id is validated as a single token, never shell text.
   - Writes `notify.kanban: { enabled: true, preset, command, task_command }`
     with the list/detail commands from the presets table. The wizard never
     installs or configures the board system itself. Multica and Paperclip are
     labeled "not live-tested", matching the docs.

4. **Speech-to-text.** Options filtered by platform: `faster-whisper` (CUDA or
   CPU), `mlx-whisper` (macOS), `wyoming` (existing server URL). `audiocpp` is
   listed as advanced, Linux/CUDA-only, and points at
   `scripts/provision-audiocpp.sh` rather than running it.

5. **Text-to-speech.** `kokoro`, `pocket-tts` (voice cloning; link to
   `docs/voice-cloning.md`), `mlx-audio` (macOS), `elevenlabs` (API key),
   `wyoming`.

6. **Install.** For each chosen Python backend that is not already installed,
   run its **recipe** (below) with live, streamed logs, a progress state per
   recipe, and cancel. Then prefetch the model weights so the first voice turn
   is not a multi-GB silent stall.

7. **Check.** Build the draft config in memory and run
   `collectChecks(draftConfig, …)` (`src/cli/doctor.ts:751`) against it — it
   already accepts an injected config and returns structured `Check[]`. Render
   ok/warn/fail with hints. Fails block the write; warns do not.

8. **Write + pair.** Show the YAML to be written, then write it (private mode,
   atomic tmp+rename like `updateConfigFields` in `src/config.ts`) with
   `web_voice.enabled: true` and a stable generated token (so the pairing QR
   survives restarts; see `setWebVoiceToken` in `src/config.ts`). Render the
   pairing QR in the page.

8b. **Channels.** Everything that reaches the operator away from the browser
   (`docs/channels.md`, `docs/notifications.md`). Telegram is the primary
   remote channel for now: the step opens on it, pre-selected, and the other
   parts follow. Every part stays skippable; none blocks the hand-off.
   - **Telegram text bot** (primary; the two-way text line: chat, `log`,
     "call me", approvals, notifications). Walk through it in-page:
     1. Link to @BotFather with the exact steps to create a bot; paste the
        token. Offer `token_env` (show the `export CICERO_TELEGRAM_TOKEN=…`
        line for the operator's shell/service) or storing `token` in the
        private config file; recommend `token_env` for service deployments.
     2. Validate with `getMe` and show the bot's @name.
     3. "Send /start to @yourbot now": poll `getUpdates` (bounded: short
        timeout, capped response, a total deadline) and show the sender's
        display name for confirmation. Take the confirmed update only from a
        chat Telegram marks `private` and whose sender id equals the chat id,
        then write both `chat_id` and `sender_user_id`. Group chats are not
        auto-paired: they need `sender_user_id` entered deliberately. After
        pairing, acknowledge the consumed updates so they do not reach the
        daemon (it also discards queued updates on every start).
     4. Send a test message, with a voice-note toggle (`voice_note`).
     The token is never echoed back after save, logged, or included in
     errors; Telegram API errors go through the existing redaction.
   - **Telegram calls** (the userbot call sidecar,
     `sidecars/telegram-call/`). It needs a second Telegram account, API
     credentials, and an interactive login. v1 does **not** automate the
     login or hold the session: it detects whether the sidecar is set up
     (`~/.cicero/tgcalls-venv` and `~/.cicero/telegram-call/cicero.session`
     exist, without reading the session), shows a checklist linking
     `sidecars/telegram-call/README.md`, and offers "ring me now" as the
     test once the operator has done it. `briefing.call` and the "call me"
     flow are only offered when this is set up.
   - **When to reach you.** Pre-fill `notify.timezone` from the browser's
     `Intl.DateTimeFormat().resolvedOptions().timeZone` — the box clock is
     often UTC, and without it quiet hours and briefings fire at the wrong
     local time. Optional `quiet_hours` and `briefing.at`, with a one-line
     explanation that notifications inside quiet hours queue for the
     briefing instead of pinging.

9. **Hand-off + test turn.** Start the daemon the documented way (`cicero start`,
   or print the service command when a supervisor is detected), wait for
   `~/.cicero/web-voice/pairing.json`, redirect to web voice, and prompt one
   spoken test turn ("say: what time is it"). Then setup mode exits.

## Install recipes

The GUI can trigger installs only by **recipe id**. Nothing typed into the page
becomes a command, a path, or a package name.

- Declared in one module next to the backend catalog
  (`src/setup/recipes.ts`), keyed by backend id, with per-OS variants:
  venv dir and Python version (the table in `requirements/README.md`), the
  requirements file, and the prefetch step.
- Executed as argv arrays through `uv` (no shell), with the resolved POSIX /
  Windows venv layout from `src/platform/python.ts`.
- Each run has one owner, an absolute deadline, a log-size cap, and cancel
  that kills its own process tree only. A timed-out or cancelled run leaves the
  venv marked incomplete and retryable, never silently "installed".
- "Installed" means the interpreter exists **and** an import probe of the
  backend's module succeeds, not just that the directory exists.
- **Weights prefetch** uses the backend's own loader or `huggingface_hub`
  `snapshot_download` with a pinned repo id (and revision where the backend
  already pins one), so HF's own resume applies. Show bytes-so-far from the
  cache directory. Pre-check free disk against a declared size estimate and
  refuse early with the number.
- Recipes follow the pinning style of `src/web-voice/vad-assets.ts` (exact URL,
  size, sha256) wherever Cicero downloads a file itself.

## Security

- Setup server: loopback by default, one-time token, Host/Origin gate, CSRF
  header on every mutating route, bounded request bodies
  (`src/http-request-body.ts`).
- API keys entered in the page go straight into the private config file; they
  are never echoed back, logged, or sent to the dashboard bus.
- Probed endpoints and "other" URLs are untrusted: bounded response size and
  timeout; model lists capped before render.
- Only the fixed set of recipe ids can be run. No arbitrary commands.

## Testing

- `bun:test` with injected fetcher (provider probes: each runtime up/down,
  malformed and oversized model lists), injected spawner (recipe success,
  failure, timeout, cancel, retry after failure), fixture `nvidia-smi` output,
  and an injected `platform` for the win32/darwin/linux option filters.
- Board step: injected `which` + runner for each preset found / not found /
  probe failure / several installed, and Paperclip with and without a
  company id in env.
- Telegram step with an injected Bot API fetcher: bad token, `getMe` ok,
  `/start` from a private chat (paired), from a group (not auto-paired), from
  a sender ≠ chat id (rejected), no update before the deadline, oversized
  response; the token never appears in thrown errors or logged lines.
- Round-trip: every wizard output config passes `validateRuntimeConfig`.
- Setup server auth: missing/wrong token, foreign Host/Origin, missing CSRF
  header — all rejected.
- Labeled smoke test (not CI): a clean VM running `install.sh` → wizard →
  spoken test turn, once per OS. Mocked CI is not proof of real installs.

## Out of scope for v1

- Reconfiguring an existing valid config (needs comment-preserving edits and a
  diff preview; v2).
- Installing LLM runtimes, CUDA/drivers, the audiocpp build, or a board
  system (Hermes/Multica/Paperclip).
- Automating the Telegram call sidecar's account login or session storage.
- Hybrid/cloud tiers (deferred in `tiers.ts` today).
- Fixing the silent MLX-default fallback for a missing config. Worth doing
  separately: `cicero start` with no config should say "run `cicero setup`".
