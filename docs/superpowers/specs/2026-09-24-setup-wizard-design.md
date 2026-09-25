# First-run setup: bootstrap script + setup GUI

Status: design, not implemented. Date: 2026-09-24.

## Problem

First run today is the seven-step `docs/setup.md`: per-OS package installs,
hand-created venvs, a hand-written `~/.cicero/config.yaml`, then `cicero doctor`.
Worse, a missing config is not an error — `loadConfig` (`src/config.ts:1112`)
silently falls back to `DEFAULT_CONFIG`, which is macOS/MLX-flavored
(`DEFAULT_CONFIG`, `src/config.ts`, plus the MLX fallbacks in its `RuntimeConfig` getters), so a Linux or Windows user gets a daemon that boots
and then fails at engine start.

## Shape

Two pieces, split by what each can safely do:

1. **Bootstrap script** (`scripts/install.sh`, `scripts/install.ps1`) — only the
   prerequisites a browser page cannot provide: Bun (the `packageManager` pin),
   uv, and a check for ffmpeg/openssl; clone or update the repo; `bun install`;
   `bun link` to expose the `cicero` CLI, as `docs/setup.md` already requires;
   then start setup with `bun run src/index.ts setup` from the checkout. That
   does not depend on `~/.bun/bin` already being on `PATH` in the script's
   shell; if it is not, the script prints the line to add. No models, no
   venvs, no config.
2. **`cicero setup`** — a new CLI command that runs a setup-mode web server
   (not the daemon) and walks the operator through the rest in a browser.

**Guiding principle: guide everything, automate only what is safe.** The goal is a
first run that is easy, not one that is hands-free. Every part of setup gets
a screen, including parts the wizard cannot or should not do itself (system
installs, account creation, interactive logins). For those, the screen gives
the exact steps, a copy button for any command, and a **done-check**: a
re-check that confirms the step worked before moving on. The wizard runs
things itself only when that is safe: pinned install recipes, read-only
probes, and writing the config.

**Teach as it goes.** The wizard should leave the operator understanding their
own setup, not just holding a working config. Every screen has:

- **What this is:** one or two plain sentences on the component and where it
  sits in the pipeline (mic → STT → brain → TTS → speaker, plus the channels).
  A small pipeline diagram highlights the current step.
- **Why the recommendation:** the detected facts behind the pre-selection
  ("RTX 3090, 24 GB free → faster-whisper on CUDA") and what each option
  trades off (latency, quality, VRAM/RAM, local vs. cloud, voice cloning).
- **What is about to happen:** before any action, what it will run, where it
  writes (venv path, config key, `.env`), and roughly how much it downloads.
  Afterwards, what happened.
- **Learn more:** a link to the matching doc (`docs/brains.md`,
  `docs/notifications.md`, `docs/voice-cloning.md`, …) so the docs stay the
  single source of truth; the page does not duplicate them.

The review screen annotates the YAML being written: each key the wizard sets
carries a one-line comment saying what it does. That makes the written
config itself a record of what was set up and why, readable later without
the wizard.

## Setup mode

- Does not call `loadConfig`. A missing config is the normal case. An invalid
  one is shown with its error and an explicit "back up and start fresh" choice
  (`config.yaml` → `config.yaml.bak-<timestamp>`); never auto-overwritten.
- Binds `127.0.0.1` on its own port by default and prints a one-time URL with
  a random setup token to stdout. In this default mode it follows the
  dashboard's pattern: loopback-only Host/Origin gate plus a custom-header CSRF
  check (`src/dashboard/server.ts`: the loopback gate and `isTrustedControlRequest`).
- `--lan` for headless boxes: binds LAN, uses `ensureTls` (`src/web-voice/tls.ts`), generated into a setup-owned directory,
  for a self-signed cert, same token. A `null` result from `ensureTls` (openssl failed) is a hard `--lan` startup failure. Plain HTTP off-loopback is refused, as
  `assertWebTlsPolicy` does today. The dashboard's loopback gate would reject
  every LAN request, so LAN mode uses its own gate instead. A request's
  Host must name loopback or one of the box's LAN addresses on the setup
  port, the same addresses `tls.ts` puts in the certificate's SANs. Origin,
  when present, must match Host. The token is required on every request, and
  the CSRF header on every mutating route. Tests cover both modes separately:
  in LAN mode a LAN Host is accepted and a foreign Host is rejected.
- Exits after hand-off. It is a one-shot process, not a daemon surface.

## Wizard steps

Steps 1–7 only collect choices into one in-memory **draft config**; nothing is
written to `config.yaml` until step 10, which writes the whole draft once.
Every choice, including channels, is in the draft that step 9 checks and step
10 writes, so no setting depends on a later partial update. The only files
written earlier are ones outside `config.yaml` that a step needs on its own:
recipe venvs and the call sidecar's `.env` credentials.

1. **System.** Detect OS, arch, Apple Silicon (+ macOS ≥14 via
   `src/platform/python.ts`), NVIDIA GPU + VRAM (lift the `nvidia-smi` probe out
   of `doctor.ts:1090-1112` into a shared function), RAM, free disk in the repo
   checkout (venvs live there, `requirements/README.md`) and in the HF cache.
   Recommend a starting tier from `src/backends/tiers.ts`
   (`local-mlx` / `local-cuda` / `local-cpu`); every later step pre-selects
   from it but stays editable.

2. **LLM provider.** A selector for the local runtime the operator already
   uses:
   - **llama.cpp** → `llm.backend: llama-cpp` (probe `GET :8080/health`, as
     `llm/llama-cpp.ts` does). `llm.model` must be a local `.gguf` path or an
     HF GGUF repo id `owner/repo[:quant]` (doctor rejects anything else), so
     this option takes one of those. Default: the `local-cuda` tier's model.
   - **Ollama** → `llm.backend: ollama` (probe `:11434/api/tags`; list the
     pulled models).
   - **LM Studio** → `llm.backend: openai` with `baseUrl:
     http://127.0.0.1:1234/v1` (LM Studio's own default; probe `/v1/models`
     and list its models). Local hosts need no key (`isKeylessHost`,
     `src/backends/net.ts`).
   - **MLX** (macOS only) → `llm.backend: mlx-lm`, the `local-mlx` tier's
     default (port 8081).
   - **Other OpenAI-compatible URL** (vLLM, llama-swap, a LAN host) and the
     existing cloud presets (`llm/openai.ts`) with an API key field. The
     LLM keys are `baseUrl` / `apiKey`; the brain's are `brain.base_url` /
     `brain.api_key`. Keep the two spellings separate.

   Probe all known default endpoints in parallel on page load and pre-select
   what is running. Where the runtime reports a model list (Ollama, LM Studio,
   OpenAI-compatible), pick from it. No free-typed model names except
   llama.cpp's validated GGUF path or repo id. If the chosen
   runtime is not installed or not running, guide it: per-OS install steps
   from the vendor's official instructions, how to start it and load or
   pull a model, then a done-check that re-probes the port and lists
   models. The wizard does not run those installs itself; they are
   system-level installs owned by their vendors.

3. **Brain.** The coding agent Cicero voices. Detect installed CLIs on `PATH`
   (the same `which` checks doctor uses for the brain binary) and offer the
   supported brains from `docs/brains.md`; ACP / OpenAI-compatible brains take a
   command or URL. A missing CLI gets its install and sign-in steps with a
   copy button and a done-check (on `PATH`, answers `--version`); the
   wizard does not run the install or the sign-in.

4. **Task board (optional).** Cicero is only the voice; the kanban board is
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
   - Adds `notify.kanban: { enabled: true, preset, command, task_command }`
     to the draft, with the list/detail commands from the presets table, which the wizard reads from code: move the three command templates next to the preset type in `src/notify/board-presets.ts` (today they are only in `docs/notifications.md`). The wizard never
     installs or configures the board system itself. Multica and Paperclip are
     labeled "not live-tested", matching the docs.

5. **Speech-to-text.** Options filtered by platform: `faster-whisper` (CUDA or
   CPU), `mlx-whisper` (macOS), `wyoming` (existing server URL). `audiocpp` is
   listed as advanced, Linux/CUDA-only, and points at
   `scripts/provision-audiocpp.sh` rather than running it.

6. **Text-to-speech.** `kokoro`, `pocket-tts` (voice cloning; link to
   `docs/voice-cloning.md`), `mlx-audio` (macOS), `elevenlabs` (API key),
   `wyoming`.

7. **Channels.** Everything that reaches the operator away from the browser
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
        then add both `chat_id` and `sender_user_id` to the draft. Group chats are not
        auto-paired: they need `sender_user_id` entered deliberately. After
        pairing, acknowledge the consumed updates so they do not reach the
        daemon (it also discards queued updates on every start).
     4. Send a test message, with a voice-note toggle (`voice_note`).
     The token is never echoed back after save, logged, or included in
     errors. The wizard's Bot API client strips the token and `/bot<token>/` the same way `redactTelegramText` in `src/notify/telegram.ts` does; export that helper rather than copying it.
   - **Telegram calls** (the userbot call sidecar,
     `sidecars/telegram-call/`). A guided walkthrough of the README's
     one-time setup, one screen per step, each with a done-check:
     1. **Read and accept the risk:** it needs a second, expendable
        Telegram account, and automating a user account is a gray area
        of Telegram's ToS. Quote the README's note; the operator ticks to
        continue or skips calls.
     2. **Environment:** the `telegram-call` install recipe (Python 3.11
        venv at `~/.cicero/tgcalls-venv`,
        `requirements/telegram-call.txt`). Done-check: the venv exists
        and passes an import probe.
     3. **Create the Cicero account** in the Telegram app (one SMS).
        Instructions only; done-check is the operator's tick.
     4. **API credentials:** step-by-step for my.telegram.org (log in
        *as the new account*, API development tools, title and short name
        `cicero`, platform Other, "ERROR" means retry). Paste `api_id` and
        `api_hash` into the page. The wizard writes them, plus
        `CICERO_TG_ALLOWED` pre-filled from the bot step's
        `sender_user_id`, to the repo `.env` with the same rules the
        sidecar enforces: owner-only mode and refuse a symlink.
     5. **Log in:** interactive (phone number + in-app code), so it stays
        a terminal command. The page shows the exact
        `uv run --python <absolute venv dir> -- python sidecars/telegram-call/login.py` line (absolute path, so it works on Windows too) with a copy
        button and polls until `~/.cicero/telegram-call/cicero.session`
        exists (checking existence only; never reading it).
     6. **Harden the account:** the README's checklist (add it to your
        phone as a second account, 2FA password, 12-month away setting,
        back up the session file, never "terminate all other sessions").
     7. **Test:** "ring me now", once the daemon is up (step 11).
     Progress survives leaving the page: steps whose done-check passes
     are shown complete on return. `briefing.call` and the "call me" flow
     are only offered once calls are set up.
   - **When to reach you.** Pre-fill `notify.timezone` from the browser's
     `Intl.DateTimeFormat().resolvedOptions().timeZone` — the box clock is
     often UTC, and without it quiet hours and briefings fire at the wrong
     local time. Optional `quiet_hours` and `briefing.at`, with a one-line
     explanation that non-urgent notifications inside quiet hours queue for the
     briefing instead of pinging (an urgent notification still pings).

8. **Install.** For each chosen Python backend that is not already installed,
   run its **recipe** (below) with live, streamed logs, a progress state per
   recipe, and cancel. Then prefetch the model weights so the first voice turn
   is not a multi-GB silent stall.

9. **Check.** Render the draft YAML into a private temp Cicero home, run the
   real `loadConfig({}, { home: tmp })` on it (tier expansion and defaults
   only happen there), then `collectChecks(resolved, { ciceroHome: tmp })`
   (`src/cli/doctor.ts`). Render ok/warn/fail with hints, in two groups:
   - **Blocking:** the draft does not load or validate, or a check about the
     config itself fails (config, web-voice token, TLS). These block the write.
   - **Not ready yet:** an engine or runtime readiness check fails (a venv
     not installed, a server not running, a brain binary missing). These are
     listed with their hints as "finish before starting Cicero". The write
     proceeds after an explicit acknowledgement, because installs can
     legitimately still be pending.

   The browser-only default draft sets `headless: true` and
   `brain.mode: subprocess`, like the minimal web-voice config in
   `docs/setup.md`. Tab-inject needs a local terminal, and without `headless`
   a missing `sox` is a fail. ElevenLabs is not ready until `tts.voice` is a
   real voice id (`cicero voice add`).

10. **Write + pair.** Show the annotated YAML to be written. It is generated as
    fresh text with its explanatory comments. That is safe because v1 only
    writes when no config exists, so there are no existing comments to keep.
    The generated text must parse back to the same config and pass
    the real `loadConfig`. Then write it with the same private `wx` temp + rename
    pattern `updateConfigFields` uses, but not through `updateConfigFields`
    itself, which re-stringifies and would drop the comments. Write it with
    `web_voice.enabled: true` and a stable generated token of at least 16
    characters (`src/web-voice/startup-policy.ts` rejects shorter ones), so
    the pairing QR survives restarts.

11. **Hand-off + test turn.** Start the daemon the documented way (`cicero start`,
    or print the service command when a supervisor is detected). Wait for
    `~/.cicero/web-voice/pairing.json`, which the daemon writes only after web
    voice binds. Then render the phone pairing QR the way `cicero pair` does:
    `readPairingState` + `selectPairingUrl` plus the stored token. A QR made
    before that file exists falls back to a guessed URL. Redirect to web voice
    and prompt one spoken test turn: "What can you help me with?", the
    shell-free `help` action and the first utterance `docs/setup.md` already
    uses. ("What time is it" runs `date` through `sh -c`, which fails on
    Windows.) Then setup mode exits.

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
  that kills its own process tree only, through `runBoundedCommand`
  (`src/process/bounded-command.ts`). A timed-out or cancelled run leaves the
  venv marked incomplete and retryable, never silently "installed". On
  Windows, tree kill after the root exits is not guaranteed there, so a retry
  waits until the previous run is confirmed reaped.
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
- Running the Telegram call sidecar's login from the page, or reading its
  session. The wizard guides the login as a terminal command instead.
- Hybrid/cloud tiers (deferred in `tiers.ts` today).
- Fixing the silent MLX-default fallback for a missing config. Worth doing
  separately: `cicero start` with no config should say "run `cicero setup`".
