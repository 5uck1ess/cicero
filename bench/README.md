# Conversation loop bench

Start a configured Cicero daemon with web voice enabled, then run:

```sh
CICERO_WEB_VOICE_TOKEN=your-token bun run bench/conversation-bench.ts --wav /path/to/spoken-utterance.wav --host 127.0.0.1 --port 8090 --turns 20
```

`--token` also works. The clip must be a real PCM WAV utterance within the web voice limits. This is an opt-in live-provider bench, never part of `bun test`. It connects to the running daemon with protocol v2 and `record=0` so synthetic turns do not enter conversation history. It sends client metric frames and acknowledges clips. Its local table reports **first clip receipt**, which may be filler; the server's private latency log resolves reply and filler from sequence IDs and contains the full table via `cicero latency`. The browser uses actual `playing` events in real use. `--timeout-ms` sets the bounded connection and per-turn deadline (default 60 seconds).

## Switchboard intent model

```sh
bun run bench/intent-bench.ts --runs 3 --misses
# Optional isolated configuration directory containing config.yaml:
bun run bench/intent-bench.ts --home /path/to/config-directory
```

This opt-in live-model evaluation uses `web_voice.tldr.summarizer_url` and
`summarizer_model`, with the configured `switchboard.intent_timeout_ms` (1500 ms by default)
and `intent_min_confidence` (0.7). It sends all 150 synthetic cases through the
same structured classifier/parser/deadline as the switchboard, including cases
that production handles by an exact fast path. No employees start and no calls
are placed. The fixed synthetic roster is coder (Rick, programmer, the coder)
and reviewer (Ada, the reviewer), independent of your real roster.

Reports include per-intent accuracy, the raw intent confusion matrix, exact
intent/target/request agreement, false-action rate on `none` cases, actions on
non-request cases, and wall-clock p50/p95 latency (including timeout/error
fallbacks). False-action rate matters most: acting means a non-`none` intent,
`request_now: true`, and confidence at or above your threshold. Provider failures
and invalid output count as `none`, so check positive-intent accuracy too;
a dead endpoint can have zero false actions. Use `CICERO_DEBUG=1` to see bounded
failure durations without transcripts or provider bodies. The first request may
include schema capability negotiation; later requests reuse that decision.

These fixtures check classifier quality, not microphones, STT accuracy, exact
fast paths, or the live call transport. Run on the reference box before changing
models or thresholds. Routing reliability depends on the classifier model's
quality; a schema guarantees structure, not correct intent or calibrated confidence.

`--runs N` repeats the fixture set (default 1, maximum 100). Repeated runs report
how many cases changed their intent/target/request decision and how many changed
their gated action. Confidence-only drift does not count as a label flip.
Timeouts are explicitly reported separately from provider errors and completed
wrong answers. `--misses` prints JSON lines with the synthetic utterance,
expected label, actual structured answer, latency and `timedOut`/`failed` flags.
Timeouts/errors are printed even if their `none` fallback matches the expected
label. Existing config files that specify 600 ms must be updated explicitly to
use the new 1500 ms budget. Classification precedes ordinary brain dispatch, adding
its elapsed time (about p50 330 ms on the reference local model) before an
ordinary reply. `cicero latency` reports this as `intentMs`.
