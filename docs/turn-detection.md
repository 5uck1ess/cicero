# Semantic end-of-turn detection (Smart-Turn)

**Status:** wired into the live conversational loop, **gated behind config and
default-off**. The detector module lives under `src/backends/turn/`, the model
server is `servers/turn_server.py`, and the listener integration is in
`ConversationalListener.captureTurn()`.

## Why energy/VAD isn't enough

A mid-thought pause and a finished-turn pause are *acoustically identical* — both
are silence. Energy/frequency VAD (which is exactly what the `sox silence` gate
already does) can only ever wait a fixed amount of silence and then guess "done."
That fixed timer is the whole problem: too short cuts you off mid-thought, too
long feels laggy. The distinguishing signal lives in the **prosody and linguistic
completeness** leading into the pause, not in the energy envelope — which is why
this needs a (tiny) model, and why ChatGPT/Gemini use semantic turn detection too.

## Why

Without Smart-Turn, turn-taking is decided by quiet alone: the streaming VAD
(on by default) ends the turn after `vad.hangover_ms` of silence, and with
`vad.enabled: false` the plain silence gate does the same with `silenceDuration`.
Either way it's a timer — it cuts users off when they
pause mid-thought, and waits too long when they're clearly done. **Smart-Turn** is
a small ONNX classifier that, given the buffered speech, predicts whether the turn
is *semantically* complete — so we can end snappily when the user is done and keep
the mic open through natural pauses.

Design adapted (ideas, not code — flowcat is Rust, Apache-2.0) from flowcat's
`TurnAnalyzer` / `TurnSilenceTracker`, themselves a port of pipecat's
`BaseSmartTurn`.

## What's in the spike

A provider seam matching the STT/TTS/LLM pattern:

- **`SilenceTracker`** (`silence-tracker.ts`) — pure, deterministic silence
  accumulation. Works with **no model**: once speech is seen, silence past
  `stopSecs` forces an end-of-turn. This is the safety floor.
- **`SmartTurnProvider`** (`smart-turn.ts`) — `TurnDetector` over HTTP (Cicero's
  Python-ML convention; reuses `net.ts` host/port). `predict(samples, rate)` →
  `{complete, probability}`. **Degrades gracefully**: any server error returns an
  incomplete prediction, so the silence floor governs and a model hiccup never
  stalls the conversation.
- **`decideEndOfTurn`** (`policy.ts`) — the combiner: model-complete (prob ≥
  threshold) → end now; else silence-timeout → end (hard ceiling); else → wait.
- **`createTurnDetector(config)`** (`index.ts`) — factory / extension point.

All pure logic is unit-tested with fakes — no audio, no model required.

## The model server (`servers/turn_server.py`)

Smart-Turn **v3** = Whisper-tiny encoder + a shallow linear head (8M params, ~8MB
int8 ONNX, ~12ms CPU inference). The server loads `pipecat-ai/smart-turn-v3`
(`smart-turn-v3.2-cpu.onnx`) and exposes the wire contract `smart-turn.ts` expects:

- `POST /predict {model, sample_rate, audio:number[]}` → `{prediction, probability, is_complete}`
- `GET /health` and `GET /` → `{"status":"ok"}`

Preprocessing matches pipecat's reference inference exactly: keep the **last 8s**
of audio, `WhisperFeatureExtractor(chunk_length=8)` → `[1, 80, 800]` log-mel,
`do_normalize=True`. The v3.2-cpu checkpoint bakes the sigmoid in, so the output
is already a probability in `[0,1]` that the turn is **complete**.

The daemon manages the server like STT does (`smart-turn.ts` `start()` →
`startManagedServer`), launching it from a dedicated `.venv-turn`. It runs on
**:8087** (8086 is the dashboard). Create the small Python 3.11 environment
once:

```sh
uv venv .venv-turn --python 3.11
uv pip install --python .venv-turn -r requirements/turn.txt
```

The same commands work on macOS, Linux, and Windows. Passing the environment
directory lets `uv` find either POSIX `bin/python` or Windows
`Scripts/python.exe` without merging Smart-Turn into the larger STT/MLX graph.

For upgrades from older checkouts, the launcher uses the first available
interpreter in `.venv-turn`, `.venv-stt`, then `.venv`. The latter two are
migration-only fallbacks and emit a deprecation warning at every Smart-Turn
start; they prevent an existing voice box from silently losing semantic turn
detection on restart. Move the installed stack into its dedicated environment
with the commands above. Once `.venv-turn` is usable, the shared environments
are no longer selected.

## How the listener uses it (`captureTurn()`)

Each `recordUntilSilence()` return is a *candidate* end-of-turn:

1. Transcribe the segment; decode the wav to mono `Float32Array` and
   `detector.predict(samples, 16000)`.
2. `decideEndOfTurn({ prediction, silenceForced, threshold })`:
   - `endTurn` → finalize the turn (join segments, hand off to STT/brain).
   - `waiting` → reopen the mic for a bounded grace window and append the
     continuation; `silenceForced` (grace budget exhausted) is the hard ceiling.

The grace re-record uses a **wall-clock deadline that only fires while the file is
still silent** — so if the user really stopped we give up after
`grace_max_duration`, but once speech is flowing sox stops on natural silence and a
long continuation is never truncated.

**Health-gated:** the grace loop engages only if `detector.health()` passes at
activation; if the server is down (or dies mid-session) it reverts to plain
silence detection, so the feature is a safe no-op without a running server.

## Enabling it

Add a `turn` block to `~/.cicero/config.yaml` (all fields optional; shown with
defaults). `enabled: false` by default:

```yaml
turn:
  enabled: true          # master switch (default false)
  backend: smart-turn    # default
  port: 8087             # model server port (8086 is the dashboard)
  model: pipecat-ai/smart-turn-v3
  threshold: 0.6         # P(complete) at/above which the turn ends
  grace_attempts: 2      # max re-record rounds when the model says "not done"
  grace_max_duration: 3  # seconds to wait for the user to resume per grace round
  timeout_ms: 10000      # absolute /predict deadline, including response body
```

**Tuning tip:** turn detection composes with a *shorter* `silence_duration`.
Lower it (e.g. `"0.5"`) for snappy turn-taking — the grace loop catches the
mid-thought cutoffs that a short timer would otherwise cause.

This touches the load-bearing listen loop, so it stays gated behind
verify-before-stacking — confirm the conversational voice path on hardware first.
