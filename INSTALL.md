# Installing Cicero for a user (for AI agents)

You are an AI coding agent asked to set up Cicero for the person you are
working with. Follow these steps in order. You drive the same setup wizard the
person would use in a browser (same detection, parsers, probes and checks),
headlessly through `--plan` and `--apply`.

Cicero has [two layers](docs/concepts.md): you are setting up layer 1, Cicero
itself, plus one front desk and one agent. You are not setting up anyone's
office of employees.

## Rules

- **Never invent config keys.** Every choice you apply comes from the plan's
  own output (`recommended`, or an option listed in `detected`).
- **Never copy another user's config**, including examples from the docs or
  the project owner's setup.
- **Never run `bun link` from a scratch or temporary clone.** It would point
  the person's global `cicero` command at a directory that may disappear. Use
  `bun run src/index.ts …` instead.
- **Never overwrite `~/.cicero/config.yaml`.** `--apply` refuses when a config
  exists. If it does, tell the person and stop; editing an existing config is
  not supported yet. Pass `--backup-invalid` only if the person agrees and the
  existing config is invalid.
- Never print or store API keys. The plan reports credentials only as found or
  not found; keep it that way.

## 1. Check prerequisites

```bash
bun --version        # must match "packageManager" in package.json (bun@X.Y.Z)
bun install
```

If Bun is missing or the wrong version, tell the person how to install it
(`curl -fsSL https://bun.sh/install | bash`) and stop until they have.

## 2. Ask the person two questions

Ask these in your own words only if you must; the verbatim wording is best.

**Question 1: "What may leave this machine?"**

- **Nothing, unless I allow it.** The front desk, helper and speech run on
  this machine. Anything else that reaches the network, including a cloud
  speech service, needs its own allowance. (`--privacy local`)
- **Conversation may use cloud models.** The front desk and agents may be
  cloud services; the helper stays local. Cloud speech, Telegram and task
  boards still need their own allowance. (`--privacy cloud`)

**Question 2: "Which coding agent should Cicero use, if any?"** The ids
`--agent` accepts:

- `claude-code`, `codex`, `gemini`, `qwen`: a CLI agent. It becomes the front
  desk and answers everything.
- `hermes`, `codex-acp`, `claude-acp`, `grok-acp`: an ACP agent. With a local
  model front desk, it takes turns when the person says "think hard".
- `none`: talk only, no agent.

In local mode, a cloud agent (everything above except `hermes` and `none`)
sends prompts and code to its company; the plan adds `agent` to
`privacy.allow` for it. Say that sentence to the person.

## 3. Plan

```bash
bun run src/index.ts setup --plan --json --privacy <local|cloud> --agent <id> > plan.json
```

`--plan` only reads. Its JSON has:

- `recommended`: a complete answers file, ready to apply.
- `reasons`: one line per step explaining the choice.
- `blocked`: steps it could not fill, each with `reason` and `fix`.
- `detected`: what each step found (runtimes, models, engines, agents).

Show the person `recommended`, `reasons` and `blocked` in plain words, and
get their OK on every plan before you write answers or apply. If `blocked` is
not empty, show each `fix` and stop: the person (or you, with their OK) runs
the fix, then you plan again and ask again.

The wizard's steps, in order: Privacy, Machine, Accounts, Front desk, Helper,
Hear, Speak, Agent, Tasks, Test, Check, Save, Hand-off. The answers file
covers the choice steps (`privacy`, `system`, `accounts`, `frontdesk`,
`helper`, `stt`, `tts`, `brain`, `board`); Test, Check, Save and Hand-off
take no answer.

## 4. Write the answers file

Only after the person has said OK to the plan, write `answers.json` =
`plan.recommended`, changed only where the person asked for something different. Each change must be an existing choice shape taken
from `detected` for that step (for example a model name the runtime actually
lists). Keep `privacy` at the top level equal to `steps.privacy`.

## 5. Apply

```bash
bun run src/index.ts setup --apply answers.json
```

`--apply` re-runs detection, checks every choice with the same parsers and
probes as the setup page, runs the same checks as `cicero doctor`, and writes
`~/.cicero/config.yaml` only if none exists. If it reports engines that are
not installed or running yet, show the person the list; add
`--acknowledge-not-ready` only if they agree to save now and install those
engines afterwards.

For a person who chose local privacy, a local model front desk and no agent,
the saved file comes down to this (comments and the random `web_voice.token`
left out):

```yaml cicero-config
deployment: local-cuda
headless: true
privacy: { mode: local }
brain: { backend: ollama, mode: subprocess, ollama_model: gemma4:26b-a4b-it-qat }
web_voice:
  enabled: true
  tldr: { summarizer_url: http://127.0.0.1:11434/v1, summarizer_model: gemma4:e4b-it-qat }
llm: { backend: openai, baseUrl: http://127.0.0.1:11434/v1, model: gemma4:e4b-it-qat }
stt: { backend: faster-whisper }
tts: { backend: kokoro }
```

## 6. Doctor

```bash
bun run src/index.ts doctor --json
```

It prints `{ version, checks, fails, warns }`. Summarize every `fail` and
`warn` for the person, with its `hint` when there is one. Checks named
`privacy: …` are policy warnings: the config lets something leave the machine
that the privacy answer did not allow.

## 7. Test (optional)

Once the engines are running:

```bash
bun run src/index.ts setup --test --json
```

It transcribes a bundled clip, asks a model front desk and the helper once
each, and measures GPU memory on NVIDIA. Speak is reported as skipped (it
needs a browser). An agent is never run; it is tested on the first real call.

## 8. Start

Tell the person to run:

```bash
bun run src/index.ts start
```

then open the printed web-voice URL, or pair a phone as described in
[docs/setup.md](docs/setup.md#start-and-pair). What to say is in
[docs/using.md](docs/using.md).
