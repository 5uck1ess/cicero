# Web-voice mode

The flagship shape: Cicero runs on a headless box (typically a GPU machine) and you talk to it from a browser — your laptop, your phone, anything on the LAN or your VPN.

## Setup

```yaml
# ~/.cicero/config.yaml on the GPU box
headless: true            # no local mic/speakers — the browser is the audio I/O

web_voice:
  enabled: true
  host: 0.0.0.0           # bind the LAN
  port: 8090
  # token omitted: a fresh per-run credential prints to startup stdout

stt: { backend: faster-whisper, port: 8083, model: large-v3-turbo }
tts: { backend: pocket-tts, port: 8095, voice: alba }   # clones any voice from a WAV; kokoro/audiocpp also work
llm: { backend: ollama, port: 11434, model: qwen3.5:4b } # install Ollama and pull this model first
brain: { backend: claude-code, mode: subprocess }       # tab-inject requires kitty/tmux/WezTerm
```

```bash
cicero start
# → 🎙️  Web voice server on https://0.0.0.0:8090 (token required)
```

When `web_voice.token` is omitted or blank, the one-run credential is printed
to startup stdout. It is deliberately excluded from the dashboard, dashboard
event stream, and Cicero's application logger, but a shell redirect or service
manager can retain stdout. Configure a stable token before daemonizing Cicero.
For one stable credential across restarts, run `openssl rand -hex 16` and paste
only its output as `web_voice.token`; placeholder text is rejected.

Open `https://<box-ip>:8090/?token=<token>` in a browser. TLS is on by
default (a self-signed cert is generated under `~/.cicero/web-voice/` — accept
it once per device; the browser mic requires a secure context). Automatic
generation needs `openssl` on `PATH` the first time; `cicero doctor` checks this
and prints the platform-specific install command, including `scoop install
openssl` on Windows. The completed pair is selected by one atomic manifest, so
concurrent starts and a killed generator cannot expose a mismatched half or
leave a permanent generation lock. To provide your own files, configure both
`web_voice.tls.cert_file` and `key_file`; Cicero treats explicit paths as
read-only and never fills in or overwrites a missing half.
If automatic generation fails, an exposed listener refuses to downgrade to
HTTP. Loopback may still use HTTP; `tls.enabled: false` is the explicit opt-in
for an insecure non-loopback listener. A headless daemon also exits if web
voice is disabled or cannot bind, instead of reporting ready with no usable
interface.

## Talking to it

- **Push-to-talk** (default): hold **SPACE** or press-and-hold the orb; release to send.
- **Hands-free**: flip the mode toggle — an adaptive energy VAD detects when you start and stop talking. Talk over Cicero any time to interrupt (the browser's echo cancellation keeps its own voice out of the mic).
- **Only speech gets through** (default on): a small local VAD model (Silero v5 on onnxruntime-wasm, ~13MB fetched once on first start, served same-origin — no CDN at runtime) confirms an energy trigger is actually *human speech* before a hands-free utterance opens or a barge-in interrupts. Keyboard clacks, thuds, and music carry energy but no speech probability, so they stop cutting Cicero off — and with auto-start, the dormant page wakes only when words are spoken. Push-to-talk is never gated (a held key is deliberate). Missing assets or a failed model load degrade to the plain energy gate (watch `vad:` in the debug line); `web_voice.speech_gate: false` disables it.
- **Auto-start** (off by default, remembered per browser): reloads reconnect and open the mic with no click — but only when the browser has *already* granted the mic permission; the page never prompts without a gesture, and if the browser blocks gesture-free audio anyway it falls back to the Start button. Pairs with hands-free: the orb loads dormant and only lights up when you first speak. With auto-start on, the dormant page also blacks out all of its chrome behind a near-black shroud — pure cinema until first speech fades it out with the orb; taps still pass through, and a missing token keeps the shroud off so the "authorization required" status stays visible.
- **It knows when you're done** (with `turn: {enabled: true}`): a semantic end-of-turn model (Smart-Turn v3, ~8MB ONNX, runs on CPU) listens to *how* you stopped, not just *that* you stopped — a finished sentence sends ~450ms sooner than the silence timeout, while a mid-thought pause ("let me think… ") keeps the mic open instead of cutting you off. Without the model (or if its server is down) the plain silence hangover governs, exactly as before.
- **Cancel a stuck turn**: press and hold the orb while it's thinking.
- **Type instead**: the text box under the mic runs the same brain→TTS pipeline without STT — no mic permission needed, and typing over a reply barges in exactly like talking over it.
- **Transfer the call**: with lanes configured, "let me talk to the coder" hands the conversation to another agent persona — its own memory, its own voice, optionally its own spoken personality — and "back to Cicero" returns you to the front desk. "Roll call" makes every employee check in, each in their own voice. See [the office](office.md).
- **Long answers stay short by default**: the TLDR gate speaks the first few sentences plus a generic coda; say "details" to hear the rest. Configure a summarizer endpoint for a model-written coda, or set `web_voice.tldr.enabled: false` to speak every sentence. Full text always lands in the chat log.
- **Interrupt without losing the thread**: after you talk over a reply, "continue" / "go on" / "as you were saying" (within five minutes) resumes it — the agent picks up from what you actually heard, opening with "as I was saying…", instead of starting over.
- **Tone rides along** (with `tone: {enabled: true}`): a local speech-emotion sidecar (emotion2vec+ base, CPU-only, auto-launched on :8091) classifies each utterance in parallel with STT. A confident non-neutral read — happy, angry, sad — is appended to what the *agent* sees (never to the transcript you see), so replies can react to how you said it. Adds ~0 ms: the verdict races the transcript and a late one is dropped, never waited on. Utterances under `min_ms` (default 1.5s) skip classification entirely — SER models are confidently wrong on short clips. Knobs in `config.yaml.example` (`min_score`, `grace_ms`, `min_ms`).

Replies stream sentence-by-sentence, so speech starts while the brain is still generating; a pre-rendered filler clip covers the agent's first-token latency when it's slow.

## Restarts don't lose the thread

Restarting the daemon doesn't wipe the conversation: the fresh agent session is primed with a recap of the last turns (riding the warmup ping, so it costs nothing). Turns spoken by a transferred-to colleague are attributed to that colleague in the recap, so the front desk never resumes someone else's personality. Tune with `web_voice.resume_turns` (default 10, `0` disables).

The page itself opens voice-only — the orb is the interface; the **Chat** button
shows the live transcript for the current visit. A browser refresh starts a new
display and does not replay prior rows into the built-in page. Completed turns
remain persisted server-side in `~/.cicero` for daemon/brain resume.

## Install it as an app

The page ships a PWA manifest — "Add to Home Screen" on a phone (or "Install" in Chrome) and Cicero opens fullscreen like a native app. The token is remembered from your first visit, so the installed app reconnects without the query string.
After that first visit the page immediately removes `?token=` from browser
history. HTML responses are not cached and carry a no-referrer policy, CSP,
and frame restrictions so the credential is not retained by ordinary browser
history, referrers, or intermediary caches.

The manifest starts at `/app`, an unauthenticated HTML shell. That is
intentional: an installed PWA does not retain the `?token=` from the page it was
installed from, and rejecting the shell would prevent its JavaScript from
recovering the token from localStorage. The shell grants no access on its own;
the WebSocket and every `/api/*` route still require the bearer token. If the
app is installed before a tokened visit, it displays an authorization message
instead of repeatedly opening a dead connection.

## Transport identity and limits

The built-in page uses WebSocket protocol v2 (`/ws?protocol=2`). The server
sends a fresh `sessionId` in its `hello` frame, and the page assigns a unique
`turnId` to every utterance. Both IDs ride every transcript, sentence, control,
error, completion, probe verdict, and binary audio frame. A replacement turn
invalidates the old turn's sink, so late audio or a late `done` from an aborted
handler cannot be mistaken for the current reply. Turn queues, abort state,
speculation, and replay detection are scoped to one WebSocket; one browser
cannot abort or drain another browser's transport queue.

Protocol-v2 binary frames are `CVP2`, two little-endian ID lengths, the UTF-8
session and turn IDs, then the existing WAV or `PRB2` payload. Clients that do
not request `protocol=2` remain on the original raw-binary/untagged-JSON format
for compatibility. New integrations should use v2; the legacy path cannot
provide stale-frame rejection because it has no identities.

Turn audio is capped at 4 MiB and 120 seconds on both WebSocket and
`POST /api/turn`. Ingress accepts only bounded uncompressed PCM/float WAV, so a
small compressed upload cannot expand into hours of STT work. Oversized HTTP
bodies receive `413 Payload Too Large`. WebSocket text controls are capped at
64 KiB; typed turns are capped at 16,384 characters. JSON bodies are read with
an absolute deadline and per-route byte caps, health batches accept at most 100
bounded rows, the listener admits at most 32 sockets, and at most eight
authenticated jobs run concurrently (`429` asks excess callers to retry).
HTTP turn callers may send `X-Cicero-Session-Id` and
`X-Cicero-Turn-Id`; valid values are echoed in the response body and headers.
Callers that omit them get generated IDs, preserving existing integrations.

`GET /health` is process liveness and remains `200` while the listener exists.
`GET /ready` is daemon readiness: it returns `503` during startup/shutdown and
`200` only after the full daemon can accept turns. Both probes are
unauthenticated and contain no credentials.

### Deliberate multi-client boundary

Transport state is isolated per socket, but Cicero still represents one shared
assistant: connected browsers reach the same configured brain/switchboard,
active lane, and persisted history. This change does not silently invent a
separate agent-memory session per device. That would change product semantics
(one household/office conversation versus independent rooms) and requires an
explicit conversation/session coordinator plus per-session brain lifecycle.
Until that decision is made, use one actively speaking client at a time when
the selected brain adapter does not itself serialize concurrent prompts.
