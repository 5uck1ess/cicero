# Advanced / example deployment

Everything on this page is optional, and most of it is one person's
[layer 2](concepts.md): the project owner's own office. It shows what Cicero
can grow into. It is not what [setup](setup.md) installs, and none of it is a
default.

## The example office

- **[Reference deployment](reference-deployment.md)**: the owner's always-on
  box. Web voice from any device, Telegram texts and calls, morning briefings,
  and restarts after crashes and upgrades. Treat its hardware, models and
  ports as one worked example.
- **[The office](office.md)**: lanes, meaning several agents with their own
  voices and personalities behind one call; transfers ("let me talk to the
  coder"), roll call, and the think lane. The example office there runs
  [Hermes](https://hermes-agent.nousresearch.com) profiles, but lanes accept
  any ACP agent or Codex.
- **[Channels](channels.md)**: how voice and text reach Cicero (browser,
  Telegram, calls) and what adding a new channel takes.

## Laya routing sidecar (opt-in)

The [Laya switchboard sidecar](https://github.com/5uck1ess/cicero/blob/main/sidecars/laya-switchboard/README.md)
replaces the model intent prompt for transfers, roll call, standups and
"call me" with a small local classifier. It **needs a checkpoint trained on
your roster**: the base model does not route zero-shot, and no public
checkpoint ships yet. The setup wizard's Helper step shows Laya as disabled
for this reason.
