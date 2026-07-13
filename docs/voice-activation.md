# Activating voice mode

The conversational listener boots **inactive** — `cicero start` brings the
daemon up listening for commands, but it does not open the microphone for a
conversation until voice mode is *armed*. There are four ways to arm it:

| Method | How | Notes |
| --- | --- | --- |
| **Type it** | Type `voice` (or `listen`) at the `cicero>` prompt | Deterministic — matched by keyword before the LLM router |
| **Global hotkey** | Press **Ctrl+Shift+Space** | Fixed chord in the current macOS helper; grant **Accessibility** permission to the host app when prompted |
| **Dashboard button** | Click **Start listening** at `http://127.0.0.1:8086` | Works from any browser on this machine; no terminal focus needed |
| **Double-clap** | Clap twice, hands-free | On by default; see tuning below |

Say "stop listening", "goodbye", press the hotkey again, or click **Stop
listening** to turn it back off.

`wake_word_enabled` is a legacy configuration name for the macOS Wispr Flow
hotkey listener; it is not an acoustic wake-word detector. The daemon accepts a
`hotkey` label for compatibility, but the current native helper is hardcoded to
Ctrl+Shift+Space. `cicero status` warns when a different value is configured.
The helper checks System Settings → Privacy & Security → Accessibility; some
macOS releases may also show an Input Monitoring prompt for the terminal host.

## "It can't hear me" — check the microphone permission first

The single most common cause is that the process running the daemon lacks
**Microphone** access. macOS grants mic permission per *host app* (Terminal,
iTerm, VS Code, …), not per CLI. Without it, `rec`/sox opens no input and every
recording is empty.

Cicero now surfaces this instead of failing silently — you'll see:

```
🎙️  Microphone capture failed: <reason>
Grant mic access to your terminal: System Settings → Privacy & Security → Microphone, then re-activate voice.
```

Fix: **System Settings → Privacy & Security → Microphone**, enable your terminal
app, then re-activate voice mode. The dashboard button is the quickest way to
confirm the fix — click it, watch the pill flip to **LISTENING**, and speak.

## Double-clap activation

While voice mode is **off**, Cicero streams the mic and watches for two quick
claps (a sharp energy transient — no model needed). It releases the mic the
instant voice mode turns on, so it never contends with the conversational
recorder, and resumes automatically when voice mode turns back off.

Because it holds the mic whenever the daemon is idle, the macOS mic indicator
stays on. Tune or disable it in `~/.cicero/config.yaml`:

```yaml
clap:
  enabled: true      # set false to turn off clap-to-activate (frees the idle mic)
  threshold: 0.5     # peak amplitude 0..1 that counts as a clap; raise if false triggers
  min_gap_ms: 80     # ignore a 2nd clap faster than this (one clap's own ring)
  max_gap_ms: 600    # the 2nd clap must land within this of the 1st
```

If claps aren't registering, lower `threshold` (e.g. `0.35`); if ordinary noise
arms it, raise `threshold` and/or narrow the gap window.

## End-of-turn: streaming VAD (default), not a volume threshold

A turn ends when Cicero decides you've stopped talking. By default this uses a
streaming **voice-activity detector**, the way Gemini Live / pipecat / LiveKit do
it — *not* the legacy sox absolute-volume gate (`silence_threshold`), which only
stops when the raw signal drops below a fixed loudness and therefore never fires
in a room whose noise floor sits above that level (it then records to the 30s cap
every turn).

The VAD streams raw mic PCM, **learns your room's noise floor** during the first
~300ms and carries that estimate across later turns, opens when speech rises a
factor above it (so it self-adjusts without swallowing the start of every turn), and
ends the turn a short **hangover** after you stop — the "slight pause after you
finish talking" that makes it feel like a conversation. Tune in
`~/.cicero/config.yaml`:

```yaml
vad:
  enabled: true        # set false to fall back to the legacy sox silence gate
  hangover_ms: 500     # silence after speech that ends the turn — lower = snappier, higher = more patient
  open_factor: 3       # open threshold = noise floor × this; raise if noise trips it, lower if it misses soft speech
  min_speech_ms: 120   # ignore voiced blips shorter than this (clicks, taps)
  calibration_ms: 300  # initial noise-floor calibration window; the learned floor carries across turns
  preroll_ms: 240      # audio kept before the detected onset so the first phoneme isn't clipped
```

If it cuts you off at natural pauses, raise `hangover_ms` (e.g. `700`). If it
feels laggy, lower it (e.g. `350`). The legacy `silence_threshold` /
`silence_duration` keys only apply when `vad.enabled: false`.

## Muting the beeps (earcons)

The activate/ready/thinking/success/error beeps are on by default. Turn them off
for a quieter, less robotic loop (this also keeps earcon bleed out of the VAD's
noise-floor calibration):

```yaml
earcons: false
```

## Dashboard control endpoint

The dashboard's button posts to `POST /api/voice` on the in-process server. That
endpoint can arm the microphone, so it is hardened against CSRF / DNS-rebinding:
the server binds to loopback only, and a control request must carry an
`X-Cicero-Dashboard` header (which a cross-origin page cannot set without a CORS
preflight the server never approves), a loopback `Host`, and a loopback `Origin`
when one is present. The dashboard remains read-only over WebSocket for activity.
