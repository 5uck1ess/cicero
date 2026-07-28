# Upstream findings — what to take from speech-to-speech and jarvis

Two open-source voice assistants were reviewed in July 2026 to check whether
Cicero is reinventing solved problems. This is the surviving actionable list,
written down because it kept getting lost in chat.

Each item below is a spec. Work them in any order — they are independent.

## Sources and what they mean for licensing

| repo | licence | how we may use it |
|---|---|---|
| `huggingface/speech-to-speech` | Apache 2.0 | Code and prompts may be **lifted** with attribution. |
| `isair/jarvis` | non-commercial + viral | **Ideas only.** Never copy code, prompt text, or config into Cicero. Reimplement from the described behavior. |

The jarvis licence is incompatible with Cicero's MIT in the ingest direction.
Every jarvis item below is a description of a *behavior* to build independently.

## Where Cicero already wins — do not re-open these

Established during the review; recorded so they are not re-litigated:

- Turn-taking. Cicero has smart-turn semantic end-of-turn detection, a filler
  bank, full-duplex, and an AEC hub. Both upstream repos are behind here.
- Assistant scaffolding (memory graph, tool selection, planner, GUI) is
  **deliberately absent**. The pluggable brain owns it. Building it in Cicero is
  the scope creep the product boundary in `AGENTS.md` forbids.
- VAD short-segment stitching — preroll in `src/listener/vad-recorder.ts` already
  covers it.
- Deferred speech-start — already exists at `src/listener/vad-gate.ts:121-130`.
- A pipeline-wide cancel scope — `src/switchboard.ts` already aborts superseded
  turns per-turn.
- Adopting jarvis as a base — wrong licence, wrong language, and it has no
  coding-agent brain, which is the entire point of Cicero.

The jarvis "500+ integrations" figure is MCP servers, not bespoke work; its
shipped `examples/config.json` has an empty `"mcps": {}`.

---

# Spec 1 — Split the voice and text system prompts

**Source:** `huggingface/speech-to-speech`, `LLM/voice_prompt.py` and
`LLM/text_prompt.py` (Apache 2.0 — their voice rules may be lifted verbatim).

## Problem

Cicero speaks and types through the same prompt. `src/executor/index.ts:20` is a
single hardcoded line:

```
/no_think
You are a helpful voice assistant. Keep answers under 2 sentences.
Be concise and natural. Do not use markdown.
```

`src/brain/ollama.ts:35` has its own one-line default. Neither is composed, and
the same instruction governs the Telegram text line, where "under 2 sentences"
and "no markdown" are actively wrong — a text reply *should* be able to use a
code block.

## What upstream does

Two prompt modules assembled in a fixed order:

```
lead  →  session prompt  →  tool descriptions  →  tail
```

The ordering is deliberate: strongest constraints go **last**, closest to the
generation boundary. The voice module carries rules for spoken output
(no markdown, no lists, spell out symbols, keep it short enough to listen to);
the text module drops those and allows structure.

## Design

1. New `src/brain/prompt.ts` exporting `assemblePrompt(parts, surface)` where
   `surface` is `"voice" | "text"`.
2. Voice and text rule blocks as separate exported constants. Lift upstream's
   voice rules verbatim where they are good — attribute Apache 2.0 in a header
   comment.
3. Thread the surface through. Voice turns come from `src/web-voice/turn.ts` and
   the host mic path; text turns from the Telegram line. Both currently reach the
   brain through the same call, so this needs a `surface` field on the turn
   options rather than a new code path.
4. `src/executor/index.ts:20` and `src/brain/ollama.ts:35` become callers.

## Verification

- `bun:test` over `assemblePrompt`: ordering is stable, the strongest-constraint
  block is last, a voice surface never emits markdown instructions to a text
  turn and vice versa.
- One test asserting the Telegram surface is allowed to produce markdown.
- No live model needed.

## Risks

Prompt changes are behavioral and not covered by CI. Any change to the *voice*
rules should be checked by actually speaking a few turns before merge — mocked
tests do not prove a voice prompt is good.

---

# Spec 2 — Background history compaction

**Source:** `huggingface/speech-to-speech`, `chat.py::trim_if_needed(compactor)`.

## Problem

`src/brain/turn-context.ts` evicts. Confirmed in the source:

```ts
const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_CHARS = 32_000;
...
if (this.history.length > MAX_HISTORY_TURNS) this.history = this.history.slice(-MAX_HISTORY_TURNS);
while (chars() > MAX_HISTORY_CHARS && this.history.length > 1) this.history.shift();
```

Turn 13 silently deletes turn 1. In a long conversation the assistant simply
forgets the beginning, with no signal to the user.

**Correction from the review:** this is *not* confined to the internal LLM lane.
CLI brains replay `BrainTurnContext`, and Claude Code uses that default — so the
eviction affects the primary brain too.

## What upstream does

Single-flight background summarisation. When the history crosses its threshold,
a compactor summarises the oldest span into one synthetic entry *in the
background* while conversation continues on the current context. Only one
compaction runs at a time; a second trigger while one is in flight is a no-op.

## Design

1. `TurnContext` gains an optional `compactor: (turns) => Promise<string>`.
   Without one, current eviction behavior is unchanged — this must be additive.
2. On crossing the threshold, start compaction if none is running. Keep serving
   the un-compacted history until the summary lands, then swap it in atomically.
3. Reuse the existing local summarizer endpoint — the TLDR gate and call-minutes
   writer already share one (`summarizerComplete` in `src/daemon.ts`). Do not add
   a second summarisation dependency.
4. Bound it: absolute deadline, a size cap on the summary, and a failure path
   that falls back to today's eviction rather than growing unbounded.

## Verification

- Injected fake compactor with a controllable gate: assert single-flight (a
  second trigger during an in-flight compaction does not start a second one),
  atomic swap, and that a compactor failure degrades to eviction.
- Assert the no-compactor path is byte-identical to current behavior.
- No live model needed.

## Risks

A compacted history changes what the brain sees mid-conversation. Late work from
a compaction that started before a turn was superseded must never publish into a
newer turn — same invariant as every other background task in the daemon.

---

# Spec 3 — LLM intent judge ("was that directed at me?")

**Source:** `isair/jarvis`, `listening/intent_judge.py`. **Ideas only — do not
read its code into Cicero.** Behavior described below; reimplement.

## Problem

Deciding whether speech is addressed to the assistant currently rests on
wake-word gating and the clap gesture. In a room with other people talking, or
with a podcast playing, that is either too eager or requires saying the wake word
every single turn.

## The behavior to build

A small model is given, per candidate utterance:

- the rolling transcript buffer (not just the current utterance — context
  disambiguates "yeah, do that")
- what the assistant itself recently said via TTS (so it does not answer its own
  echo, and so a direct reply to its question is recognised)
- current state (is a conversation already open, was there a recent turn)

and returns strict JSON: directed at me or not, plus a confidence.

A "hot window" follows any assistant turn during which follow-ups are accepted
without a wake word, then decays.

## Design

- New `src/listener/intent-judge.ts`, behind config, **off by default**.
- Consumes the existing rolling transcript; does not add a second capture path.
- Strict JSON out, validated and bounded — treat model output as untrusted.
- On any failure (timeout, unparseable, model down) fall through to today's
  wake-word behavior. Never fail into "accept everything".
- Depends on Spec 4 to be affordable — a full reply-tier model per utterance is
  not viable.

## Verification

- Table-driven tests over transcript/TTS-history/state fixtures with an injected
  fake judge; assert the fallback path on malformed and slow responses.
- A labeled live smoke test for the real model, gated like
  `tests/brain-claude-code-stream.test.ts` — CI must not depend on it.

## Risks

False negatives are invisible and infuriating (the assistant ignores you). Ship
it off by default with an obvious log line when it declines a turn, so the
failure is diagnosable rather than silent.

---

# Spec 4 — Fast-tier classifier model

**Source:** `isair/jarvis`, `llm/tiers.py`. **Ideas only.**

## Problem

`src/backends/tiers.ts` is unrelated despite the name — it is `TierConfig` /
`TIER_PRESETS`, i.e. **hardware** presets. There is no notion of a cheap model
for per-utterance decisions distinct from the model that writes replies.

Every per-utterance classification pass we might want (Spec 3, tone, routing)
currently has to borrow the reply model, which is far too expensive to run on
every utterance.

## The behavior to build

A small warm model (~2B class) held resident for classification only, separate
from the reply model, with its own config block and health/doctor coverage.

## Design

- Extend the backend registry with a `classifier` role alongside stt/tts/llm.
- Config, `doctor`, `status`, `config.yaml.example`, and operator docs updated
  together — `AGENTS.md` requires these stay in sync.
- Optional. Absent config means features that need it (Spec 3) stay off, with an
  explicit reason logged, not a silent fallback to the reply model.
- Remote-host and local-managed modes tested separately.

## Verification

- Registry/factory/doctor tests with injected spawners and fetchers; no
  fixed-port races, no real network.
- Assert an explicitly configured unsupported backend is an **error**, not a
  silent fallback.

## Risks

VRAM. A resident classifier competes with the STT/TTS seat on a single-GPU box.
Measure resident cost before enabling anything by default.

---

# Spec 5 — Streaming partial STT

**BLOCKED** on the audio.cpp live-ingest PR (owner: Tym; spec lives outside this
repo). Recorded here so the consumer-side design is not re-derived.

## The consumer-side trap

`STTProvider` is `transcribe(audioFile) => Promise<string|null>` — whole
utterance, no way to express a partial.

Widening it needs a **required discriminated capability**, not an optional
method:

```ts
type STTStreaming =
  | { kind: "unsupported" }
  | { kind: "live"; open(options: STTSessionOptions): Promise<STTSession> };
```

The reason is specific and was proven during review: `FallbackSTTProvider` and
`wrapSTTWithTap` both wrap the primary and forward only a **fixed method set**.
An optional `transcribeStream?()` silently vanishes the moment fallback or
`CICERO_STT_TAP` is enabled — the capability would appear to work in tests and
disappear in production.

`STTSession` owns `write(pcm)`, replacement-snapshot updates
(`{fixedText, activeText}` — the fixed/active split comes from upstream's
`smart_progressive_streaming.py`), `finish(finalAudioFile)`, and bounded
`abort`/`close`.

## Do not start this before the engine side lands.

---

# Spec 6 — OpenAI Realtime + WebRTC endpoint

**Source:** `huggingface/speech-to-speech`, `api/openai_realtime/` (~2,900 LOC),
two transports behind one `SessionTransport`.

## Status: a positioning bet, not a fix. Largest item on this list.

Confirmed by grep: Cicero has **no** WebRTC and **no** Realtime API surface.
`src/web-voice/server.ts` is WebSocket-only; the browser uses `getUserMedia` and
sends frames over WS. The only `realtime` hits in `src/` are TTS comments about
realtime *factor*.

Implementing the OpenAI Realtime protocol would make Cicero a drop-in for any
Realtime client, and WebRTC would improve mobile/lossy-network behavior over the
current WS transport. Both are real wins, and neither fixes anything broken.

Do this only as a deliberate decision to chase compatibility. If it is picked up,
follow upstream's shape: one `SessionTransport` interface with WS and WebRTC
implementations behind it, so the turn pipeline stays transport-agnostic.

---

# Spec 7 — TTS input coalescing

**Source:** `huggingface/speech-to-speech`.

Merge adjacent ready sentences before handing them to synthesis, reducing
per-call overhead on multi-sentence replies.

**Measure before adopting.** This fights Cicero's tuned per-sentence
first-audio latency, which is a headline property of the current speaker. The
plausible outcome is that it helps sentences 2..n and hurts sentence 1, in which
case the answer is to coalesce everything *except* the first sentence.

Gate it behind a benchmark against the existing baselines, not a unit test.
