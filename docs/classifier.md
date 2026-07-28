# The classifier backend

Cicero has one model that writes replies. Some decisions are not replies: was
that utterance addressed to me, what kind of request is this, should this route
somewhere else. Those run **per utterance**, and running a reply-tier model on
every utterance is not affordable — on a single-GPU box it is not even
schedulable alongside STT and TTS.

The `classifier` role is a second, smaller model held apart for exactly that
work. It is optional, off by default, and nothing today requires it.

## Configuration

Same shape as an `llm:` section:

```yaml
classifier:
  backend: llama-cpp          # any backend the llm role supports
  host: 127.0.0.1
  port: 8090
  model: your-small-model
```

A ~2B-class instruct model is the intended size. It must be **warm** — a model
that loads on demand defeats the purpose, because the latency lands in the path
of every utterance.

Remote and local-managed both work. `host` pointing at another machine makes it
a remote endpoint Cicero only talks to; a local backend that Cicero can launch
is started and stopped with the daemon like any other managed provider.

## What absence means

Leaving the section out means the role is **unconfigured**, and every feature
that depends on it stays off and logs the reason.

It does **not** silently fall back to the reply model. That fallback is the
failure this role exists to prevent: it would look like a working feature while
quietly costing a full reply per utterance, and on a VRAM-tight box it would
contend with the STT/TTS seat. There is no implicit default either — unlike
`llm`, an absent `classifier` section resolves to nothing at all.

A configured but **unsupported** backend is an error at startup, not a fallback.
The message names the classifier (`Unknown classifier backend '<name>'`) rather
than the reply model, so it is clear which of the two sections is wrong, and
`cicero doctor` points at `classifier.backend` for the same reason.

## Failure behavior

The classifier is never a required primary. If it is configured and cannot
start, the daemon logs a warning and carries on — a per-utterance helper being
down must not stop a daemon that can still hold a conversation. Features that
need it decline rather than guess.

`cicero doctor` reports a configured-but-unreachable classifier as a failing
check, exactly as it does for an unreachable reply model — the role was asked
for and is not there. An unconfigured one is silent, since absence is a valid
choice rather than a problem. `cicero status` shows a `Classifier` row only when
the role is configured.

## VRAM

A resident classifier competes with the STT and TTS seats on a single-GPU box.
Measure the resident cost on your hardware before enabling anything that depends
on it — this is the reason the role ships optional rather than on.
