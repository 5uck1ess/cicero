# Full duplex: why Cicero takes turns

Cicero's conversation model is deliberately half-duplex: you speak, it speaks.
This page is the decision record for that choice — what full duplex would buy,
what it would cost, and what would change the call. (Status as of July 2026:
a *watch* item, not a roadmap item.)

## What "full duplex" means

Products like GPT Live and Gemini Live are built on **speech-native models**:
audio in, audio out, behaving as one continuous process rather than a visible
pipeline, with no explicit STT/text/TTS boundary to wait at. That fusion is
what makes them feel alive — they respond in a few hundred milliseconds,
back-channel ("mm-hm") while you're still talking, and adjust mid-sentence
when you interject.

Cicero is the opposite shape: a pipeline of seams. Speech → STT → a text
brain → TTS → speech. The stages overlap where they can — replies stream
sentence-by-sentence, speculative turns start the brain early — but the
fundamental constraint remains: the brain reasons over finished text, so it
cannot comprehend you mid-utterance. Speech that arrives while Cicero talks
can interrupt it, not converse with it.

## What Cicero does instead

Turn-taking with fast interruption, tuned hard:

- **~1 second to first spoken word**, with latency-covering filler clips.
- **Barge-in on the browser and phone paths** (and the local mic with
  full-duplex enabled) — talk over Cicero and it stops; a local VAD confirms
  a human is speaking before anything cuts it off.
- **[Semantic end-of-turn detection](turn-detection.md)** (opt-in, best-effort)
  — it can answer as soon as the model judges your sentence complete instead of
  waiting out a silence timer, and holds the mic open when you trail off
  mid-thought.
- **Speculative turns** — the brain starts on a probable-final transcript
  before your turn formally ends.
- **Echo-cancelled hot mic** — the local-mic path has a full-duplex *transport*
  mode; the conversation model stays turn-based.

The remaining gap to a fused model is real but narrow: the last few hundred
milliseconds, overlap, and back-channels. Polish, not capability.

## Why the seams are the product

The boundaries that forbid overlap are exactly where Cicero's value lives:

- **Any brain** — the agent slot is pluggable because it speaks text.
- **Any voice** — cloned voices exist because the mouth is a separate TTS
  engine, not weights baked into the brain.
- **The confirmation gate** — a dangerous tool call can be held for your
  spoken yes because there is a checkable boundary between thought and action.
- **Lanes and delegation** — different models behind one call, a switchboard
  between them, a task board underneath.

A fused model keeps far fewer of these seams. Its brain and voice are the same
weights — you cannot swap one without the other. Hosted realtime APIs do
expose tool-calling seams, but at the price of the property this project
exists for: the audio leaves your machine, and the brain is whichever model
the vendor runs. The open self-hosted duplex models (Moshi class) have the
opposite problem — your hardware, but no reliable tool seam: driving a coding
agent from one means bolting an adapter onto its text stream, which nobody has
shipped. And the consumer products offer no path from the live call to your
local repository: mouths without hands.

## The cost accounting on real hardware

On a single consumer GPU, the trade is stark. A duplex talker
(Moshi/Qwen-Omni class, ~7B) displaces the large brain that makes the
conversation worth having. You would trade **answering capacity** — 26B-class
reasoning, tool use, real work — for **conversational overlap** from a model
that cannot reliably execute or delegate tool work. Since the entire point of Cicero is that a turn
can end in a pull request, that trade fails on arrival: the work outranks the
duplexity.

Training our own "both things" model was assessed and parked for the same
reason: fine-tuning a delegation seam onto an open duplex model is plausible
(LoRA-scale, synthetic dialogues), but it spends scarce effort on the layer
the large labs are commoditizing fastest, for a gain that is polish.

## What would change the call

Two triggers re-open this decision:

1. **The model class matures** — an open, persona-controllable duplex model
   with reliable structured output (so it can *delegate*, not just chat).
2. **Hardware headroom** — enough VRAM to run a duplex talker *alongside* the
   brain instead of in place of it.

The architecture already has the seat reserved: a fused model would slot in as
the **front desk** — the conversational surface that takes the call, banters,
and hands every piece of real work to the agent lanes through the existing
switchboard, task, and notification seams. Fusion where fusion matters (the
live audio loop); seams where seams matter (everything that touches your code).
