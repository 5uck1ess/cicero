# The intent judge — "was that addressed to me?"

Once voice mode is active, Cicero treats every intelligible, non-echo utterance
as a command. In a quiet room that is right. With other people talking, or a
podcast playing, it is far too eager — and the alternative, saying the wake word
before every single turn, is why people stop using voice assistants.

The intent judge asks a small model, per utterance, whether that speech was
addressed to Cicero.

```yaml
intent_judge:
  enabled: true
  hot_window_ms: 15000
  min_confidence: 0.6
  context_turns: 4
  timeout_ms: 1500

classifier:                 # required — see docs/classifier.md
  backend: llama-cpp
  host: 127.0.0.1
  port: 8090
  model: your-small-model
```

Off by default.

## It is only ever a veto

This is the design constraint everything else follows from: **the judge can
decline an utterance the listener would otherwise have taken, and it can never
cause one to be taken that would not have been.**

So every failure path ends in *accept*, which is exactly today's behavior. A
classifier that is down, slow, missing, or returning nonsense makes Cicero
behave precisely as it does without this feature. The judge can make Cicero
deafer; it cannot make it more indiscriminate.

Concretely, the turn is accepted when:

- the model is unreachable, times out, or the request is cancelled
- the reply is not a well-formed verdict — missing a field, a confidence outside
  0..1, prose with no JSON, an oversized response
- the model says "not for me" but below `min_confidence`
- the utterance falls inside the hot window (below)

It declines only on a well-formed, confident `directed: false`.

## What the model is shown

- the utterance being decided
- the last `context_turns` utterances heard in the room, so context can
  disambiguate a bare "yeah, do that"
- the last `context_turns` things **Cicero itself said**, so a direct answer to
  its own question is recognised as directed at it
- nothing else

All of it is bounded per line and in total before it leaves the process —
captured room audio is untrusted input, and these buffers are small rings, not a
transcript log.

## The hot window

For `hot_window_ms` after Cicero finishes speaking, the judge is skipped entirely
and the utterance is accepted.

A direct reply to Cicero's own question is both the case a judge is most likely
to get wrong and the case we are most certain about, so it is not worth asking.
It also removes the model call from the most latency-sensitive moment in a
conversation. Past the window the judge applies again.

## Ordering

The judge runs **after** self-echo rejection and **after** the deactivation
phrases. So "stop listening" always works even if the judge would have
disagreed, and Cicero never spends a model call deciding about its own voice.

## Cost and latency

One classifier call per utterance, outside the hot window, bounded by
`timeout_ms` (default 1.5s). The deadline settles the wait itself rather than
trusting the provider to honor cancellation — this sits in the audio path, and a
classifier that ignored its abort signal would otherwise block every utterance.

This is why it requires the `classifier` role rather than the reply model. See
[the classifier backend](classifier.md).

## Diagnosing it

A false negative is invisible and infuriating: you speak, and nothing happens.
So every declined turn is logged with the utterance and the confidence:

```
🙉 Not addressed to me (0.91), ignoring: "so then he said we should ship it"
```

If turns are being dropped that should not be, raise `min_confidence`, raise
`hot_window_ms`, or set `enabled: false`.

`cicero doctor` warns when `intent_judge.enabled` is set without a configured
classifier — the daemon starts fine and accepts everything, so the feature would
otherwise look on while doing nothing.
