# What leaves the box

Cicero's voice pipeline runs on your hardware. In the default local
configuration, your microphone audio, transcripts, and the conversation
itself are processed entirely on your machine — speech-to-text,
text-to-speech, turn detection, and emotion analysis are local Python
sidecars bound to `127.0.0.1`, and the default brain backends are local
subprocesses. There is no Cicero cloud: **no configuration of Cicero ever
contacts a project-owned server, and there is no telemetry, analytics,
crash reporting, or update checking anywhere in the codebase.** You can
verify that claim with a grep; this page exists so you don't have to.

Data leaves the machine only on surfaces you explicitly configure. Here is
the complete map.

## Always local

| Data | Where it goes |
|---|---|
| Microphone audio | Local STT sidecar over loopback (`servers/stt_faster_whisper_server.py`, spawned with `--host 127.0.0.1`) |
| Synthesized speech | Local TTS sidecar over loopback (Kokoro by default) |
| Turn detection & emotion audio | Local sidecars over loopback (Smart-Turn, SER) |
| Conversation ↔ brain | Local subprocess over stdio (Claude Code, Codex, Gemini CLIs; ACP agents) |
| Conversation history | `~/.cicero/` on disk, owner-only permissions, optional |

The daemon spawns the model sidecars itself and pins them to loopback; the
HTTP client that talks to them defaults to `localhost`
(`src/backends/net.ts`). Audio bytes and transcripts never touch a network
interface in this configuration.

**One honest caveat about brains:** Cicero sends the brain nothing beyond
your transcribed words, over stdio, on your machine. But the coding agent
you plug in is its own program with its own vendor relationship — Claude
Code talks to Anthropic, Codex talks to OpenAI, on their own accounts,
exactly as they would in a terminal. Cicero adds no data to that exchange;
it also can't subtract from it. A fully local brain (llama.cpp, Ollama, an
ACP agent running a local model) keeps even the conversation on the box.

## Your LAN: the web-voice surface

The web-voice server binds `0.0.0.0` by default so a headless box is
reachable from a phone browser on your network. That means mic audio and
transcripts traverse your LAN when you use it — gated by a mandatory bearer
token on every request, and by TLS that Cicero generates on first start
(it refuses to serve the authenticated API over plaintext HTTP on a
non-loopback bind). Set `web_voice.host: 127.0.0.1` to keep it off the
network entirely. Details in [security](security.md).

## First-run downloads

Two things are fetched from third-party hosts once, then cached and served
locally forever:

- **Model weights** from Hugging Face on first model load — Whisper
  (CTranslate2), Kokoro, Smart-Turn. This is an unauthenticated download;
  no audio or conversation data is sent. Pre-seed the Hugging Face cache to
  run air-gapped.
- **Browser VAD assets** (Silero VAD + onnxruntime-web) from the jsDelivr
  CDN into `~/.cicero/web-voice/vad/`, pinned by version, size, and sha256,
  then served same-origin — the voice page never touches a CDN at runtime.

## Off-box only if you configure it

Each row is off by default and activates only when you set the named key.

| You configure | What is sent | Where |
|---|---|---|
| `stt.host` / `tts.host` / `turn.host` / `ser.host` | Raw audio (STT/turn/SER), reply text (TTS) | The host you name, **plain HTTP** |
| `llm.host` (llama.cpp / Ollama / MLX on another box) | Full prompt and completion text | The host you name, **plain HTTP** |
| `llm.backend` cloud preset (`openai`, `openrouter`, `groq`, `together`, `deepseek`, and others) | Full prompt text + your API key | That vendor's API |
| `tts.backend: elevenlabs` | Reply text; voice provisioning uploads your reference WAV once | `api.elevenlabs.io` |
| ACP brain with remote args (e.g. `ssh box agent acp`) | The conversation, over your ssh session | Your remote box |
| `compute.allow_cloud: true` (computer use) | Goals, selected file contents, command output | The cloud LLM you configured |

**The plain-HTTP rows are deliberate and worth reading twice:** pointing a
model backend at another machine sends raw audio or prompt text
unencrypted. That split-machine mode is designed for a trusted LAN or a
personal VPN (WireGuard, Tailscale) — not for anything that crosses a
network you don't control.

## Third-party transports

Telegram surfaces route through Telegram — that's what they're for. What
each one sends:

- **Notifications** (`notify.telegram`): message text and rendered voice
  notes to `api.telegram.org` via your bot token; replies come back over
  the same Bot API. Off until a token and chat id are configured.
- **Live calls** (the optional [telegram-call
  sidecar](../sidecars/telegram-call/README.md)): both directions of call
  audio through Telegram's MTProto/WebRTC infrastructure, on a userbot
  session you provision. STT/TTS computation stays local; the sidecar talks
  to the daemon only over loopback. A separate service, off unless you
  deploy it.

## What Cicero never does

- No telemetry, analytics, usage statistics, or crash reporting.
- No update checks, version pings, or launch beacons.
- No accounts, and no Cicero-owned backend to have an account on.
- No egress that isn't attributable to a config key you set, listed above.

If you find a network touchpoint this page doesn't account for, that's a
bug — [report it](security.md#reporting).
