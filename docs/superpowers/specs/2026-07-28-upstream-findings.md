# Upstream findings — what to take from speech-to-speech and jarvis

Two publicly available voice-assistant codebases were reviewed in July 2026 to
check whether Cicero is reinventing solved problems. One is Apache-licensed;
the other is source-available under a non-commercial licence. This is the
surviving actionable list, with corrections made after tracing the relevant
Cicero paths end to end.

Each numbered item is an independent candidate spec unless it says otherwise.

## Sources and what they mean for licensing

| repo | licence | how we may use it |
|---|---|---|
| `huggingface/speech-to-speech` | Apache 2.0 | Code and prompts may be reused with the required notices and attribution. |
| `isair/jarvis` | custom non-commercial licence; derivatives must use the same terms | **Ideas only.** Do not copy code, prompt text, or config into Cicero; reimplement described behavior independently. |

The jarvis licence is not compatible with incorporating its material into
Cicero's MIT-licensed code. Every jarvis item below is therefore a description
of behavior to build independently.

## Established boundaries and corrected baseline

- Cicero already has smart-turn end-of-turn detection, a filler bank, and
  opt-in full-duplex/AEC support in `src/listener/`, `src/daemon.ts`, and
  `src/platform/aec-hub.ts`.
- General brain-owned memory and task planning belong behind the `Brain`
  contract in `src/types.ts`; they should not become a stable Cicero plugin
  SDK. This does not mean Cicero has no UI or tool-selection code:
  `src/dashboard/server.ts` provides its operator UI and
  `src/compute/agent-loop.ts` contains a bounded computer-use loop.
- `VadGate` in `src/listener/vad-gate.ts` already defers speech start until a
  voiced run meets its minimum duration.
- VAD preroll can carry a short speech fragment into a later onset only while
  that fragment remains in the ordinary rolling preroll. There is no separate
  candidate-fragment retention window; that narrower gap remains in Spec 8.
- Cancellation is **not** one pipeline-wide latest-wins scope; the actual
  cross-surface gap is recorded in Spec 9.
- Adopting jarvis as Cicero's base is not a candidate because of its licence and
  because Cicero's product boundary is a voice layer around pluggable coding
  brains.

Jarvis's "500+ apps" claim refers to Composio exposed through one MCP
integration, not 500 bespoke MCP servers. Its shipped `examples/config.json`
has an empty `"mcps": {}` block.

---

# Spec 1 — Prompt ownership and surface-specific prompts

**Source:** `huggingface/speech-to-speech`,
`src/speech_to_speech/LLM/voice_prompt.py` (Apache 2.0).

## Correction: the original prompt premise was wrong

`VOICE_SYSTEM_PROMPT` in `src/executor/index.ts` is used only when
`ActionExecutor.buildLocalLLMMessages` builds messages for its local-LLM route.
Local daemon command ingress from the conversational microphone and stdin, plus
native dictation configured with `target: cicero`, can reach that route through
`CiceroDaemon.dispatchCommand` in `src/daemon.ts`; it is therefore inaccurate
to call the prompt voice-only or to say text never reaches it.

Telegram's `onChat` path calls `runOperatorChatTurn` in `src/daemon.ts`, which
sends directly to the configured brain. Browser text and voice turns use the
turn functions in `src/web-voice/turn.ts`; the separate HTTP `/api/chat` handler
also reaches `runOperatorChatTurn`. None of those web paths uses
`ActionExecutor`'s local-LLM prompt.

## The real, smaller issue

`OllamaBrain` in `src/brain/ollama.ts` has a built-in system prompt and sends it
on Ollama turns. Although its direct constructor type accepts
`systemPrompt?: string`, that option is **not operator-configurable through
Cicero's runtime config**:

- `BrainConfig` in `src/types.ts` exposes `ollama_port` and `ollama_model`, but
  no Ollama system-prompt field.
- `src/config-validation.ts` rejects an unknown `brain.systemPrompt` key.
- The factory in `src/brain/index.ts` passes only the port, model, and timeout to
  `OllamaBrain`.
- `tests/brain-ollama.test.ts` can inject a prompt only because it constructs the
  class directly.

Consequently, any local, Telegram, or web turn sent to a deployed Ollama brain
uses the built-in prompt. Claude Code and ACP brains do not receive this Ollama
prompt.

## Recommendation

Do not add a surface field solely to fix the word "voice" in the Ollama default.
The direct correction is to decide whether the Ollama prompt should remain
fixed or become a documented, validated config option.

If surface-specific brain prompts are later justified, add a required,
discriminated surface to the turn options, preserve it through every brain
wrapper, and test each wrapper. Upstream's prompt assembly order—lead, session
prompt, optional tools, then the strongest tail constraints—is still a useful
design reference.

---

# Spec 2 — Background history compaction

**Source:** `huggingface/speech-to-speech`,
`src/speech_to_speech/LLM/chat.py::Chat.trim_if_needed`.

## What upstream does

Upstream starts a single background compaction when history crosses a threshold.
While it is running, conversation continues on the current history. Only one
compaction runs at a time, and a successful result replaces the compacted span
with a summary.

## Implemented in this tree

`BrainTurnContext` in `src/brain/turn-context.ts` still defaults to bounded
eviction: without a compactor it retains at most 12 completed turns and 32,000
characters and removes the oldest retained turns at those bounds.
`SubprocessCLIBrain` in `src/brain/subprocess-cli.ts` uses that context, and
`ClaudeCodeBrain` inherits it. ACP builds prompts with transcript replay off and
uses its own stateful session.

The optional compaction path is now implemented by `HistoryCompactor`,
`BrainTurnContext.setCompactor`, and `setDefaultHistoryCompactor` in
`src/brain/turn-context.ts`:

- `BrainTurnContext.remember` starts a background pass when retained history
  crosses its normal cap. It submits up to the older six turns, runs only one
  compaction at a time, and keeps serving the captured turns while the request
  is pending, subject to a hard two-times overrun ceiling.
- One retired-turn batch is capped at 20,000 characters. The summarizer prompt
  is sliced at a 28,000-character boundary before its truncation marker is
  appended; one retained summary is capped at 4,000 characters and one wait at
  30 seconds. Failure, an empty summary, or a deadline returns the context to
  normal bounded eviction.
- `BrainTurnContext.applyCompaction` removes the exact captured turn objects,
  so turns appended while the request was running remain. `clear()` increments
  a generation and prevents a result from the cleared conversation from
  reattaching. Successive passes fold the previous summary into one replacement
  summary, which both `buildTextPrompt` and `buildChatMessages` replay.

`CiceroDaemon.start` registers the process-wide compactor only when
`brain.history_compaction.enabled` is true. It uses that block's
`summarizer_url` and `summarizer_model`, falling back to the corresponding
`web_voice.tldr` values. `createHistoryCompactor` in
`src/brain/history-compactor.ts` reuses the same bounded
`createSummarizerComplete` client used by TLDR and call-minutes work.
`BrainConfig.history_compaction` in `src/types.ts`,
`validateRuntimeConfig` in `src/config-validation.ts`, and
`config.yaml.example` document and validate the opt-in block.

## Deviations from the proposed design

The daemon does not constructor-inject a compactor through every brain and
wrapper. Because adapters construct private `BrainTurnContext` instances, it
registers a daemon-wide default through `setDefaultHistoryCompactor`; tests can
still override an individual context through `setCompactor`.

Result validity is not an exact history-revision equality check. The
implementation removes the captured objects by identity, preserving later
arrivals, and uses the generation only to reject work invalidated by `clear()`.

## Verification already present

`tests/brain/turn-context-compaction.test.ts` covers default eviction,
single-flight execution, history served during a pass, bounded overrun,
replacement, failure and timeout fallback, later arrivals, and `clear()` races.
`tests/brain/history-compactor.test.ts` covers the bounded HTTP client and
process-wide registration. `tests/daemon-lifecycle.test.ts` covers daemon
registration and release. These tests use injected compactors or fetchers; they
do not require a live model.

## Remaining work

None within this spec. The feature remains off by default; enabling it without
either summarizer URL logs a warning and leaves the original bounded-eviction
behavior in place.

---

# Spec 3 — LLM intent judge ("was that directed at me?")

**Source:** `isair/jarvis`, `src/jarvis/listening/intent_judge.py`.
**Ideas only; reimplement independently.**

## Implemented in this tree

There is still no acoustic wake-word detector. `wake_word_enabled` and
`wispr_hotkey` are retired and select nothing:
`RETIRED_TOP_LEVEL_KEYS` in `src/config-validation.ts` tolerates them only so an
old config still boots, then `validateRuntimeConfig` logs that they are ignored.
`createListener` in `src/listener/index.ts` always returns `StdinListener`.
The daemon constructs `ConversationalListener` separately through
`createConversationalListener`; `dictation.enabled` selects the separate native
`DictationListener` path, and the global hotkey toggles conversational mode
rather than selecting a listener.

The addressed-to-me veto has shipped:

- `src/listener/intent-judge.ts` defines `IntentJudgeInput`, `IntentVerdict`,
  `DEFAULT_INTENT_JUDGE_OPTIONS`, `buildJudgePrompt`, `parseVerdict`, and
  `createIntentJudge`. The input is exactly the candidate utterance, bounded
  recent room utterances, bounded recent assistant speech, and elapsed time
  since local assistant speech; it does not receive general conversation state
  or an explicit asked/answered flag. `createIntentJudge.decide` uses elapsed
  time only for the hot-window fast path; `buildJudgePrompt` sends the model the
  utterance and the two bounded text histories, not the elapsed value.
- The classifier request asks for the strict JSON schema named
  `intent_verdict`, uses at most 32 output tokens, temperature zero, and an
  absolute deadline. `parseVerdict` separately caps the raw result at 2,000
  characters and validates the two field types and confidence range. It is more
  tolerant than the proposed strict parser: it can extract a verdict object
  from surrounding prose and does not reject extra object properties itself.
- `ConversationalListener.addressedToMe` owns bounded six-line rings for room
  utterances and assistant speech. The idle loop calls it after self-echo and
  deactivation checks; both legacy and full-duplex barge-in paths also call it.
  Stop/deactivation phrases bypass the judge.
- `CiceroDaemon.start` creates the judge from `this.providers.classifier` and
  passes it to the host listener. `CiceroDaemon.webIntentGate` also gates both
  `processWebTurn` and `streamWebTurn`, so browser-captured audio is covered.
  Browser typed turns through `streamWebTextTurn`, `/api/chat`, stdin, native
  dictation, and `ConversationalListener.listenOnce` bypass it.
- `IntentJudgeConfig` in `src/types.ts`, `RuntimeConfig.intentJudge` in
  `src/config.ts`, and `validateRuntimeConfig` in
  `src/config-validation.ts` implement the five documented keys. The example is
  in `config.yaml.example`; operator behavior is documented in
  `docs/intent-judge.md`, `docs/classifier.md`, and
  `docs/voice-activation.md`. It is off by default and is not constructed
  without a configured classifier.

## Deviations from the proposed design

The shipped judge fails **open**, not closed. `createIntentJudge.decide` accepts
on timeout, transport failure, caller cancellation, an unusable verdict, and a
`directed: false` verdict below `min_confidence`; only a well-formed, confident
`directed: false` vetoes the turn. Enabling the block without a classifier logs
a warning and accepts every utterance.

The local hot window is also an unconditional fast path, not a confidence-policy
adjustment: for `hot_window_ms` after completed local speech,
`createIntentJudge.decide` skips the model and accepts. An interrupted reply
enters assistant context but deliberately does not restart the window, and
barge-ins always pass `msSinceAssistantSpoke: null`. The browser gate also
always passes `null`, because the daemon cannot observe when queued browser
audio actually finishes playing, so browser audio never uses the hot-window
skip.

Full-duplex barge-in judges before interrupting and gives the verdict 400 ms;
a slower verdict fails open and interruption proceeds. The legacy energy-first
path has already interrupted playback before it has a transcript to judge, so a
later veto can discard the command but cannot undo that interruption.

## Verification already present

`tests/listener/intent-judge.test.ts` covers parsing, bounds, schema request
options, confident and low-confidence verdicts, fail-open paths, deadlines,
hot-window boundaries, context rings, activation races, and all three host
capture call sites. `tests/web-voice/intent-judge.test.ts` covers both browser
audio paths, the typed-input bypass, cancellation, daemon wiring, and the
deliberate absence of a browser hot window. All classifier behavior in these
tests is injected; there is no real-classifier quality or acoustic smoke test
in this tree.

## Remaining work

None within the behavior proposed by this spec. Real-model accuracy and latency
remain deployment-specific and are not established by the injected tests.

---

# Spec 4 — Dedicated classifier backend role

**Source:** `isair/jarvis`, `src/jarvis/llm/tiers.py`.
**Ideas only; reimplement independently.**

## Implemented in this tree

Cicero now has a dedicated optional `classifier` backend role:

- `CiceroConfig.classifier?: LLMBackendConfig` is declared in `src/types.ts`.
  `validateRuntimeConfig` in `src/config-validation.ts` validates `classifier`
  alongside `llm`, and `RuntimeConfig.classifierBackend` resolves it without a
  default.
- `BackendProviders.classifier`, `createClassifierProvider`, and
  `buildLLMProvider` in `src/backends/registry.ts` construct it separately from
  the reply `llm`. An absent block produces no provider; an unsupported
  configured backend is an error; there is no fallback to the reply model.
  `supportedBackendsForRole` in `src/backends/supported-backends.ts` gives it the
  same built-in backend set as `llm`.
- `BackendRole` and `createBackendStartupPolicies` in
  `src/servers/startup-policy.ts` include the role as optional rather than a
  required primary. `providerEntries` in `src/servers/index.ts` gives a
  configured provider normal start, prewarm, and stop lifecycle coverage; an
  optional start failure is logged rather than failing daemon startup.
- `CiceroDaemon.start` sends a best-effort one-token completion to a configured
  classifier in the background so a health-only probe does not leave the model
  cold. It then passes that same provider to `createIntentJudge`.
- `collectChecks` in `src/cli/doctor.ts` checks a configured classifier and
  warns when intent judging is enabled without one. `collectStatus` in
  `src/cli/status.ts` adds a `Classifier` row only when configured.
  `docs/classifier.md` and `config.yaml.example` document remote and
  local-managed configurations and the lack of an implicit fallback.

`tests/backends/classifier.test.ts` covers separate construction, absent and
unsupported configurations, validation, remote/local behavior, startup policy,
doctor integration, and managed lifecycle. `tests/daemon-lifecycle.test.ts`
covers completion warmup, and `tests/cli/status.test.ts` covers the optional
status row.

## Why the earlier recommendation was superseded

The older `summarizerClassifier` in `src/brain/index.ts` still serves semantic
dial-back and ACP-lane routing from `web_voice.tldr`; it is not the intent
judge's client. The shipped intent judge is a per-utterance feature with its own
focused config and needs a separately selectable warm model, with provider
lifecycle handling for both remote-host and local-managed configurations. The
dedicated role makes absence explicit and prevents an implicit reply-model
fallback, so the previous recommendation to reuse only the TLDR endpoint was
not adopted.

## Remaining work

None for Spec 3 or for the classifier role described here. The role is optional
and off when unconfigured; whether a resident classifier fits alongside STT,
TTS, and the reply model remains a hardware-specific deployment measurement.

## Risks

An operator can point the endpoint at another resident model, which may compete
for memory with STT, TTS, or the reply model. That deployment cost should remain
explicit and optional.

---

# Spec 5 — Streaming partial STT

**Status:** blocked in this tree. The provider contract and the audio.cpp
integration both accept completed audio files; no live-ingest session contract
exists here. An engine-side live-ingest contract that Cicero can consume remains
a prerequisite, so this section records only the consumer-side design.

## The consumer-side trap

`STTProvider` in `src/backends/stt/provider.ts` exposes whole-file
`transcribe(audioFile)` calls and has no streaming session capability.

Widening it needs a required discriminated capability, not an optional method:

```ts
type STTStreaming =
  | { kind: "unsupported" }
  | { kind: "live"; open(options: STTSessionOptions): Promise<STTSession> };
```

`FallbackSTTProvider` in `src/backends/stt/fallback.ts` and `wrapSTTWithTap` in
`src/backends/stt/tap.ts` expose a fixed method set. An optional
`transcribeStream?()` added only to a concrete provider would disappear through
those wrappers.

The eventual session should own PCM writes, replacement-snapshot updates,
finish, abort, and bounded cleanup. Upstream's
`src/speech_to_speech/STT/smart_progressive_streaming.py` is a reference for the
fixed-text/active-text snapshot split.

Do not implement the Cicero side before the engine-side contract is available.

---

# Spec 6 — OpenAI Realtime + WebRTC endpoint

**Source:** `huggingface/speech-to-speech`,
`src/speech_to_speech/api/openai_realtime/README.md`.

## Status: a positioning bet, not a correctness fix

Cicero's web-voice server currently has no WebRTC transport and no OpenAI
Realtime-compatible API. The live browser audio path in
`src/web-voice/page.ts` uses `getUserMedia` and a WebSocket.
`src/web-voice/server.ts` serves that WebSocket **and** HTTP endpoints including
`/api/turn`, `/api/chat`, `/api/notify`, and `/api/say`; it is not a
WebSocket-only server. Separately, the optional Telegram call sidecar sends call
audio through Telegram's MTProto/WebRTC infrastructure, as documented in
`docs/data-flows.md`; that is not a WebRTC endpoint exposed by the web-voice
server.

The remaining `realtime` wording under `src/` is descriptive text about provider
pipelines or synthesis speed, not an OpenAI Realtime protocol implementation.

Adding the protocol would pursue client compatibility, while WebRTC could add a
transport suited to browser media. Neither is required to fix current behavior.
If this is picked up, keep WebSocket and WebRTC adapters behind shared session
protocol semantics and the same bounded turn-pipeline ownership.

---

# Spec 7 — Adaptive coalescing for streaming TTS

**Source:** `huggingface/speech-to-speech`,
`tests/test_tts_input_coalescing.py`.

## Implemented baseline

There is no shared or adaptive TTS coalescer, and no
`src/speaker/coalesce.ts`, in this tree. `TTSSpeaker` does have an older fixed
chunking heuristic: for text with more than two parsed sentences and more than
300 characters, `TTSSpeaker.speakChunked` in `src/speaker/tts-speaker.ts`
synthesizes the first sentence separately and joins sentences 2..n into one
second request while the first audio plays.

`StreamingTTSSpeaker.speakStream` in `src/speaker/streaming-tts.ts` instead
synthesizes one sentence per request with exactly one sentence of lookahead.

## Remaining work

Adaptive coalescing is unbuilt. The remaining candidate is the streaming path;
the fixed batch heuristic is not the proposed adaptive policy and should not be
reported as that feature.

Measure first-audio latency, total synthesis time, cancellation latency, and
speech naturalness against current behavior before adopting it. Keep the first
sentence independent; use a benchmark for the performance decision and focused
tests for ordering and cancellation correctness.

---

# Spec 8 — Stitch nearby sub-threshold speech segments

## Problem

`VadGate.feed` in `src/listener/vad-gate.ts` resets `voicedSinceMs` when audio
falls below the opening threshold before `minSpeechMs`.
`VadRecorder.runGate` in `src/listener/vad-recorder.ts` keeps every pre-onset
frame only in a bounded rolling `preroll` and prepends whatever is still there
when the gate opens. A completed short voiced fragment can therefore survive a
brief gap opportunistically, but there is no separate candidate segment or
independent silence-gap lifetime for it.

As a result, a brief first speech blip can be lost: if the later qualifying
utterance starts after that blip has rolled out of preroll, the recording does
not contain it. `tests/listener/vad-gate.test.ts` confirms that a short voiced
blip alone never starts speech.

## Design

- Add a bounded candidate-fragment window distinct from ordinary rolling
  preroll.
- Retain a sub-threshold voiced fragment only for a short maximum silence gap.
  If qualifying speech follows within that gap, prepend the candidate; otherwise
  discard it.
- Bound retained audio by bytes and wall-clock duration, and clear it on abort,
  stop, or recorder replacement.

## Verification

- Cover a short blip plus short gap plus qualifying speech, the same sequence
  beyond the gap, isolated noise blips, and repeated fragments at the memory
  bound.
- Verify stop and cancellation release the candidate buffer.

---

# Spec 9 — Cross-surface turn supersession

## Problem

Cicero does not currently have one latest-wins scope for all interactive input:

- `dispatchCommand` in `src/daemon.ts` supersedes only `activeLocalTurn`.
- Telegram's `onChat` passes the daemon lifecycle signal to
  `runOperatorChatTurn`; a new Telegram message does not supersede a local turn.
- `queueTurn` in `src/web-voice/server.ts` applies latest-wins only within one
  WebSocket's `WsData`.
- `SwitchboardBrain` in `src/brain/switchboard.ts` does supersede its previous
  accepted public send, but `createBrain` in `src/brain/index.ts` installs it
  only for ACP with configured lanes.
- Claude Code's underlying `ClaudeCodeBrain` is subprocess-backed. The factory
  may decorate it with `DialBackBrain` (`src/brain/dial-back.ts`) and
  `QuickIntentsBrain` (`src/brain/quick-intents.ts`), but neither adds cross-send
  supersession for normal delegated turns. `SubprocessCLIBrain` in
  `src/brain/subprocess-cli.ts` spawns a process per send.

Therefore a long local Claude Code turn and a Telegram turn can overlap and run
two subprocess turns.

## Design

- Give interactive local, Telegram, and web turns one daemon-owned latest-wins
  generation and abort scope before they enter brain wrappers.
- Preserve the generation and signal through every wrapper. A late result from
  an older generation must not emit text, speech, transport frames, or retained
  history into the newer turn.
- Keep explicitly background work—scheduled, parked, or dial-back operations—in
  a separately named scope rather than implicitly canceling it with user input.
- Make cleanup bounded for the subprocess, stream, timers, and transport work
  owned by the superseded turn.

## Verification

- Test local→Telegram, Telegram→web, web-socket-A→web-socket-B, and same-surface
  supersession with controllable fake brains.
- Add a Claude Code subprocess regression with an injected spawner proving that
  the older process is aborted and cannot publish after the newer generation.
- Assert background operations follow their explicitly chosen cancellation
  policy.
