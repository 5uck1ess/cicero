# Setup

## Your first conversation

This is the opinionated first-run path: Cicero runs on a Linux box (GPU or not),
and you talk to it from a browser on your network. Linux is the reference path.

### 1. Prerequisites

Install and authenticate the selected brain before the first start. The minimal
configuration below expects the Claude Code CLI. Cicero ships no brain; see
[Brains](brains.md) for the other documented brain choices.

Install the prerequisites (skip any you have):

```bash
curl -fsSL https://bun.sh/install | bash            # Bun
curl -LsSf https://astral.sh/uv/install.sh | sh     # uv
sudo apt install ffmpeg openssl                     # Debian/Ubuntu (brew/scoop elsewhere)
curl -fsSL https://ollama.com/install.sh | sh       # Ollama (other platforms: https://ollama.com/download)
```

The Cicero CLI runs anywhere Bun runs; full local voice support still depends
on platform audio tools, provider runtimes, and (for the native hotkey/AEC
helpers) macOS-specific code. Cicero launches and supervises supported local
providers; a configured remote provider connects to a server you operate.

### 2. Install Cicero and the speech servers

Clone this repository, `cd` into it, and run everything below from that checkout
(the daemon launches and supervises the model servers itself):

```bash
bun install
bun link                    # expose the `cicero` CLI from this checkout

uv venv .venv-stt --python 3.10
uv pip install --python .venv-stt -r requirements/faster-whisper.txt
uv venv .venv-pocket --python 3.11
uv pip install --python .venv-pocket -r requirements/pocket-tts.txt
ollama pull qwen3.5:4b
```

### 3. Create the minimal config

Make `~/.cicero/config.yaml` with exactly this content (don't copy
`config.yaml.example` for a first run — it documents every option and expects
backends this quickstart doesn't install):

```yaml
# ~/.cicero/config.yaml — the minimal web-voice setup
headless: true
web_voice: { enabled: true, host: 0.0.0.0, port: 8090 } # a fresh token prints at startup
stt: { backend: faster-whisper, port: 8083, model: large-v3-turbo }
tts: { backend: pocket-tts, port: 8095, voice: alba }
llm: { backend: ollama, port: 11434, model: qwen3.5:4b }
brain: { backend: claude-code, mode: subprocess } # or acp / codex / gemini / ollama / any OpenAI-compatible URL
```

For Hermes or another ACP harness, set
`brain: { backend: acp, binary: …, binary_args: […] }` instead — see
[Brains](brains.md).

### 4. Check the setup

```bash
cicero doctor   # checks configured backends and prints fixes
```

`cicero doctor` checks the effective configuration and prints fixes for missing
prerequisites. It can verify that a CLI binary is present, but it does not prove
that the CLI is authenticated or complete a live agent turn.

### 5. Start Cicero

```bash
cicero start
# → 🎙️  Web voice server on https://0.0.0.0:8090 (token required)
```

### 6. Pair your phone

With the daemon running, use the fast path:

```bash
cicero pair
```

The command ensures `web_voice.token` is a stable random credential, prints the
phone URL, and renders the same URL as a terminal QR code. If it creates or
replaces the token, restart the daemon once and re-run `cicero pair`. The QR
contains the live credential; use `cicero pair --no-token-in-qr` to scan only
the address and type the separately printed token on the phone.

When no `web_voice.tunnel` block is configured, `pair` prints the exact
one-line block to add but does not make that second config change. With a
daemon-owned tunnel, the published tunnel URL wins over the LAN URL.
Cloudflared quick-tunnel URLs change on every daemon run, so re-run `pair` after
each restart; Tailscale hostnames are stable. The manual URL and certificate
flow below remains available.

### 7. Say this, expect this

Open `https://<box-ip>:8090/?token=<token>`, accept the self-signed certificate
once, and click **Start conversation** (the page loads with the conversation
off; push-to-talk does nothing until you start it and grant the microphone).
Then hold SPACE (or the orb) and say **“What can you help me with?”** Expect
the hint line to flash what was heard, then a spoken response (the page keeps
no chat log — replies are spoken, not displayed). Exercise this real turn
before treating a deployment as ready. Full page controls, hands-free mode, and
PWA behavior are in the [web-voice guide](web-voice.md).

### First-run troubleshooting

- **The browser warns about the certificate.** Expected: Cicero generates a
  self-signed HTTPS certificate on first start (browsers only expose the
  microphone over HTTPS or on localhost, and this walkthrough reaches the box
  from another device). Accept it once per device.
- **Where's the token?** Printed at startup, once per run. For a stable token
  across restarts, run `openssl rand -hex 16` and paste only its output as
  `token:` inside the `web_voice:` block (e.g.
  `web_voice: { enabled: true, host: 0.0.0.0, port: 8090, token: <paste> }`).
  Configure it before running Cicero under a service manager, because startup
  stdout may be retained — and never copy an example placeholder as a secret.
- **I talk and nothing happens.** First make sure the conversation is started —
  the page loads with it off, and push-to-talk is inert until you click
  **Start conversation**. Then remember the default is push-to-talk: hold SPACE
  or the orb *while* speaking. Then check the browser's microphone permission,
  then `cicero doctor`.

## Platform variants of the first-run sequence

Use the same minimal config, `cicero doctor`, `cicero start`, browser URL, and
spoken test above after substituting the platform-specific install steps below.

### macOS 14+ (Apple Silicon)

The current MLX dependency floors require macOS 14 or newer on Apple Silicon.
Install [Ollama](https://ollama.com) before running these commands:

```bash
bun install
brew install uv sox openssl ffmpeg
bun link

uv venv .venv-stt --python 3.10
uv pip install --python .venv-stt -r requirements/faster-whisper.txt
uv venv .venv-pocket --python 3.11
uv pip install --python .venv-pocket -r requirements/pocket-tts.txt
ollama pull qwen3.5:4b
```

For tab integration, use a terminal with remote control — [Kitty](https://sw.kovidgoyal.net/kitty/), [tmux](https://github.com/tmux/tmux), or [WezTerm](https://wezterm.org/). Cicero auto-detects which one you're in (`terminal: auto`). Set `terminal: none` for headless mode (voice → brain dispatch with no terminal integration). See [terminal adapters](https://github.com/5uck1ess/cicero/blob/main/docs/superpowers/terminal-adapters.md).

### Windows (CUDA)

```bash
# Install Bun
powershell -c "irm bun.sh/install.ps1 | iex"

# uv (manages the Python model servers), audio tools, tmux, and automatic
# web-voice HTTPS certificate generation
scoop install uv sox ffmpeg tmux openssl

# Ollama: download from https://ollama.com/download/windows
ollama pull qwen3.5:4b

# Python backends (the venv-directory syntax is the same on every OS):
uv venv .venv-stt --python 3.10
uv pip install --python .venv-stt -r requirements/faster-whisper.txt
uv venv .venv-pocket --python 3.11
uv pip install --python .venv-pocket -r requirements/pocket-tts.txt
uv venv .venv-kokoro --python 3.11
uv pip install --python .venv-kokoro -r requirements/kokoro.txt

bun install
bun link
```

OpenSSL is needed only to create Cicero's first self-signed web-voice
certificate. Later starts reuse the atomically published pair. `cicero doctor`
reports a blocker, with the native install command, when generation is still
needed and `openssl` is missing from `PATH`.

## Optional macOS MLX stack and native helper

The existing MLX and native-hotkey recipe is an alternative to the reference
speech-server installation above:

```bash
bun install
brew install sox openssl ffmpeg
uv venv .venv --python 3.12
uv pip install --python .venv -r requirements/mlx.txt --prerelease=allow

bun run build:hotkey    # optional — macOS Ctrl+Shift+Space helper
bun link

bun run src/index.ts doctor
cicero start --tts
```

## Additional Linux installation detail

Install [Ollama](https://ollama.com) before the commands below, or select a
different explicit `llm` backend in the copied configuration.

The complete Linux package and fallback-seat recipe is retained here for
operators who need local mic/system speech, terminal integration, or Kokoro:

```bash
bun install
bun link
sudo apt install tmux openssl ffmpeg alsa-utils # use pulseaudio-utils instead of alsa-utils when the host provides only PulseAudio
ollama pull qwen3.5:4b
# Non-headless local mic/system-speech fallback:
sudo apt install sox speech-dispatcher

# STT — faster-whisper (CTranslate2; CUDA if available, CPU otherwise):
uv venv .venv-stt --python 3.10
uv pip install --python .venv-stt -r requirements/faster-whisper.txt

# TTS — pocket-tts (voice cloning, CPU-friendly) + kokoro as the fallback seat:
uv venv .venv-pocket --python 3.11
uv pip install --python .venv-pocket -r requirements/pocket-tts.txt
uv venv .venv-kokoro --python 3.11
uv pip install --python .venv-kokoro -r requirements/kokoro.txt

# Config, then verify the configured prerequisites:
mkdir -p ~/.cicero && cp config.yaml.example ~/.cicero/config.yaml   # edit it
bun run src/index.ts doctor
```

The full `config.yaml.example` expects a `hermes` ACP executable; replace its
`brain.binary`/`binary_args` with another ACP harness or one of the documented
CLI/HTTP brains if Hermes is not your driver.

On a fresh non-macOS install with no config file, an unsupported implicit LLM
default produces a warning, while unsupported implicit STT or TTS defaults are
hard failures. Copy and edit `config.yaml.example` before relying on `doctor` as
a readiness gate.

For Windows operators using that full example rather than the first-run config:

```bash
# Copy config.yaml.example to ~/.cicero/config.yaml, then: bun run src/index.ts doctor
# The example uses Ollama qwen3.5:4b, matching the model pulled above.
```

## Run at boot

Ship it as a systemd user service (no Docker needed; the daemon supervises its own model servers):

Set a stable `web_voice.token` before enabling the service. Systemd retains
service stdout in the journal, including the one-run token printed when that
setting is omitted.

```bash
cp deploy/cicero.service ~/.config/systemd/user/   # edit WorkingDirectory first
systemctl --user enable --now cicero
loginctl enable-linger $USER                        # keep it alive when logged out
```

## Optional VibeVoice, Smart-Turn, and speech-emotion stacks

VibeVoice's published `vibevoice-api==0.0.1` wheel is not standalone: its server
imports the separate `vibevoice` model package, but the wheel does not declare
or include it. Cicero therefore pins the upstream
[`VibeVoice`](https://github.com/vibevoice-community/VibeVoice) and
[`VibeVoice-API`](https://github.com/vibevoice-community/VibeVoice-API) source
snapshots in `requirements/vibevoice-sources.txt`, along with the server's
undeclared direct imports. Keep that stack in its own Python 3.11 environment
(Git is required so `uv` can fetch the pinned snapshots):

```bash
uv venv .venv-vibevoice --python 3.11
uv pip install --python .venv-vibevoice -r requirements/vibevoice.txt
```

No manual checkout or separately started server is needed: the manifest owns
the source revisions, and Cicero launches `python -m vibevoice_api.server`.
The selected model weights download on first launch. See [voice
cloning](voice-cloning.md) for the backend config and reference-clip workflow.

Smart-Turn has a dedicated, small Python 3.11 environment on every platform.
This avoids changing the MLX or faster-whisper dependency graph:

```bash
uv venv .venv-turn --python 3.11
uv pip install --python .venv-turn -r requirements/turn.txt
```

Existing installations that previously put Smart-Turn in `.venv-stt` or
`.venv` continue to launch during migration, in that order, but Cicero logs a
deprecation warning with the command above. `.venv-turn` is always preferred;
create it before removing Smart-Turn packages from either shared environment.

Speech-emotion recognition stays isolated because FunASR's PyTorch/ModelScope
graph can conflict with STT dependencies:

```bash
uv venv .venv-ser --python 3.11
uv pip install --python .venv-ser -r requirements/ser.txt --index-strategy unsafe-best-match
```

The files under [`requirements/`](https://github.com/5uck1ess/cicero/blob/main/requirements/README.md) constrain direct
dependencies only. Accelerator-specific transitive packages remain resolved
for the host rather than being presented as one universal lockfile.

## Sidecar quickstart (Claude Code and Codex)

The zero-commitment entry point: Cicero attaches to the coding agent you already use and speaks its responses.

```bash
bun install
bun link

# One-time: install one or both native Stop hooks
cicero hook install claude-code
cicero hook install codex

# Each session: run the receiver in a separate terminal
cicero hook
```

The installers and receiver share an automatically generated bearer credential in `~/.cicero/hook-token`; no token needs to be copied into config. Before changing an existing agent settings file, the installer writes one private timestamped backup; an already-current reinstall is a no-op and does not accumulate backups. Claude Code posts its response directly to the loopback receiver. Codex runs a bounded local bridge; open `/hooks` once after installation and trust that command hook. Native-hook sessions then speak summarized responses through Cicero's TTS. See [`sidecar modes`](https://github.com/5uck1ess/cicero/blob/main/docs/superpowers/sidecar-modes.md) for terminal-scrape mode (Gemini / Ollama / any CLI agent without hooks) and config.

**For real summaries** (not raw token blobs), point Cicero at a local LLM — install [Ollama](https://ollama.com) and add to `~/.cicero/config.yaml`:

```yaml
llm:
  backend: ollama
  port: 11434
  model: qwen3:0.6b
```

Without an LLM the sidecar still works — it falls back to speaking the last line of the response.

## Remote model servers

Run the heavy models on one machine (e.g. a Windows/Linux GPU box) and drive Cicero from another. Any HTTP backend — `faster-whisper`, `mlx-whisper`, `mlx-audio`, `kokoro`, `vibevoice`, `mlx-lm`, `ollama`, `llama-cpp` — accepts a `host`:

```yaml
# ~/.cicero/config.yaml on the laptop — point each backend at the GPU box
stt: { backend: faster-whisper, host: 192.168.1.50, port: 8083, timeout_ms: 90000 }
tts: { backend: mlx-audio,      host: 192.168.1.50, port: 8082, timeout_ms: 60000 }
llm: { backend: llama-cpp,      host: 192.168.1.50, port: 8080, timeout_ms: 120000 }   # llama-server (e.g. Gemma GGUF)
```

The `llama-cpp` backend talks to llama.cpp's `llama-server` over its OpenAI-compatible `/v1/chat/completions` API. Run your own server (`llama-server -m gemma.gguf --port 8080`) and Cicero connects to it; or set `llm: { backend: llama-cpp, model: /path/to/gemma.gguf }` to have Cicero launch one locally. `llama-server` also supports GBNF/json-schema constrained decoding.

When `host` is a non-local address Cicero connects directly and does **not** launch a local server for that backend. Omit `host` (or use `localhost`) to keep the model on the same machine. For Home Assistant voice servers, use the [Wyoming backends](https://github.com/5uck1ess/cicero/blob/main/docs/superpowers/wyoming-integration.md) instead.

## CLI reference

```bash
# Sidecar mode
cicero hook install claude-code      # install the Stop hook (one-time)
cicero hook install codex            # install the native Codex Stop hook
cicero hook                          # run the hook receiver
cicero scrape <tab>                  # terminal-scrape an agent without hooks

# Daemon mode
cicero start --tts                   # start the daemon with TTS
cicero start --no-tts                # without TTS
cicero start --no-servers            # keyword routing only, no model servers
cicero stop                          # stop the daemon
cicero status                        # bounded effective-config/runtime snapshot
cicero doctor                        # check every configured backend, print fixes
cicero pair                          # print the phone URL and credential-bearing QR
cicero pair --no-token-in-qr         # scan the URL, then type the token separately

# Utility
cicero speak "Hello from Cicero"     # speak arbitrary text
echo "build done" | cicero speak     # pipe-friendly
cicero notify "PR is up."            # speak through every connected browser

# Voices
cicero voice add butler ~/ref.wav --provider pocket-tts  # match the configured TTS engine
cicero voice use butler              # set the active voice
cicero voice list / inspect / remove

# Override brain at startup
cicero start --brain qwen
cicero start --brain-mode subprocess
```
