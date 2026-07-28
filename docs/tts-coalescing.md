# TTS input coalescing

Cicero synthesizes a reply sentence by sentence, so the first sentence starts
playing while the rest is still being generated. That is what makes it feel
fast, and it is also why a ten-sentence reply costs ten calls to the TTS engine.

Coalescing merges sentences that have **already arrived** into one call.

```yaml
tts_coalesce:
  enabled: true
  max_chars: 240
  passthrough_first: 1
```

Off by default. Read the numbers below before turning it on — on a local GPU
engine this is measurably free and measurably pointless.

## It never waits

Sentences are drained into a queue as fast as the brain produces them, and each
call takes whatever is queued *at that instant*. If only one sentence has
arrived, one sentence is sent. Coalescing that waited around for a second
sentence would be trading time-to-first-audio for throughput, which is the wrong
direction for a voice assistant.

`passthrough_first` sends that many sentences alone before any merging starts,
so nothing is deliberately placed in front of the opening sentence of a reply.
(The queue itself costs a scheduling hop, which measured below the run-to-run
noise on every configuration tested — small, but not literally zero.) `max_chars` caps a merged chunk, because a chunk that
takes longer to synthesize than the audio playing ahead of it is a gap the user
hears.

## What it costs

An interrupted merged chunk reports as a single pending item, so after a barge-in
Cicero can no longer tell which sentences inside that chunk were actually heard.
With coalescing off, that record is per sentence.

It also changes how far ahead the brain is allowed to run. Without coalescing the
speaker pulls exactly one sentence at a time, which paces the brain to the
speaking rate. Coalescing has to read ahead to have anything to merge, so it
drains the reply into a queue and stops pulling once 16,000 characters are
waiting — so the peak is that plus whatever sentence was already in flight. Far
more than any merged chunk needs, but bounded rather than open-ended.

A barge-in, a shutdown, or a superseding reply all stop the read-ahead at the
moment they retire the turn — the same operation that makes its output stale
also cancels its reading — and then ask the source to close. The close itself is
best-effort: an async iterator cannot be made to
abandon a read that is already in flight, so a brain stalled mid-response is
released when that read finally settles rather than at the moment of the
barge-in. Nothing is spoken from a cancelled turn either way — the wait for
confirmation is bounded precisely so a stalled producer cannot hold up the
next turn.

The text handed to the engine is otherwise identical; only its grouping differs.

## The measurement

`bench/tts-coalesce-bench.ts` drives a real endpoint and reports three numbers
per reply: **TTFA** (time to first audio), **TOTAL** (wall-clock to synthesize
the whole reply), and **SLACK** (the smallest margin by which synthesis stayed
ahead of playback — negative would mean the user hears a gap).

Against audio.cpp / pocket-tts on a local 3090, `--runs 5`:

| reply | TTFA | TOTAL | calls | SLACK |
|---|---|---|---|---|
| short (2 sentences) | 55ms → 55ms | 126ms → 124ms | 2 → 2 | 1.9s → 1.9s |
| typical (5 sentences) | 54ms → 53ms | 320ms → 254ms | 5 → 2 | 1.8s → 1.6s |
| long (10 sentences) | 53ms → 52ms | 673ms → 561ms | 10 → 3 | 1.6s → 1.5s |

Synthesis work drops about 20%, first audio does not move, and playback keeps
well over a second of buffer. But **none of that 20% is time the user waits**:
the streaming speaker already renders the next chunk during playback of the
current one, and a chunk of audio lasts ~2s against ~60ms of synthesis. On this
setup the honest summary is "fewer GPU calls, same experience."

It starts to matter when each call carries fixed overhead. Sweeping a modeled
per-call cost (`--overhead-ms`, which adds latency to every call without
touching the engine — a model of a round trip, not a real hosted provider):

| modeled overhead | TOTAL, 5 sentences | TOTAL, 10 sentences |
|---|---|---|
| 0ms | −20% | −21% |
| 150ms | −48% | −53% |
| 400ms | −54% | −62% |

TTFA stayed flat at every setting, and slack never dropped below 1.2s.

So: enable it if your TTS is a hosted API or lives across a network. Leave it off
for a warm local engine. If you are unsure, run the bench against your own
endpoint — that is what it is for.

## Limits of the bench

It measures synthesis and models playback; it does not open the audio device.
Device buffering and the player's own scheduling are not in the SLACK number, so
treat a thin margin as "listen to it first," not "proven safe." The
`--overhead-ms` sweep is a latency model, not a measurement of any real hosted
provider under load.
