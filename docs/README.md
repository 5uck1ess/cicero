# Cicero documentation

Start from what you're trying to do. Every guide below is current unless it
says otherwise; the [historical records](#history-dated-records) at the bottom
are provenance, not guidance.

## Understand it

| Read | For |
|---|---|
| [Project README](/) | What Cicero is, what it feels like, and what you need |
| [Architecture](architecture.md) | The three runtime shapes and how a spoken turn flows through them |
| [Why not full-duplex](duplex.md) | The core design decision: honest turn-taking with fast barge-in |
| [The office](office.md) | Lanes: several agents with their own voices behind one call |

## Have your first conversation

| Read | For |
|---|---|
| [Setup](setup.md) | The canonical install path — prerequisites to first spoken reply, per platform |
| [Choosing a brain](brains.md) | Which agent to plug in (Claude Code, Codex, Gemini, ACP, any OpenAI-compatible endpoint) and how |
| [Configuration](configuration.md) | Deployment tiers, the config schema, quick intents, custom voice actions — with [`config.yaml.example`](https://github.com/5uck1ess/cicero/blob/main/config.yaml.example) as the annotated reference |

## Operate it

| Read | For |
|---|---|
| [Web voice](web-voice.md) | The browser/PWA surface: controls, identity, limits |
| [Daemon mode & local mic](daemon-mode.md) | Lifecycle, activation, echo cancellation, computer use on the local machine |
| [Voice activation](voice-activation.md) | Hands-free start, claps, VAD tuning, earcons |
| [Turn detection](turn-detection.md) | Semantic end-of-turn (Smart-Turn): what it fixes and how to enable it |
| [Voice cloning](voice-cloning.md) | Giving Cicero (or a lane) any voice from one reference clip |
| [Notifications](notifications.md) | Cicero speaking up on its own: Telegram, briefings, schedules, quiet hours |
| [Telegram calls](https://github.com/5uck1ess/cicero/blob/main/sidecars/telegram-call/README.md) | The phone-call sidecar: talk to your agent from anywhere |
| [Security](security.md) | Threat model, authentication, egress rules — read before exposing anything beyond localhost |
| [What leaves the box](data-flows.md) | The complete data-flow map: what stays local, what's opt-in, and what Cicero never does |

## Extend it

| Read | For |
|---|---|
| [Choosing a brain → custom drivers](brains.md) | The three tiers of adding an agent, from zero-code to a small adapter |
| [Configuration → quick intents](configuration.md#quick-intents--your-own-zero-latency-phrases) | Your own zero-latency phrases and voice actions, pure YAML |
| [Python model servers](https://github.com/5uck1ess/cicero/blob/main/requirements/README.md) | How the speech sidecars are provisioned |

## History (dated records)

Point-in-time snapshots kept for provenance. Claims inside describe their date,
not the current product.

- [Lessons learned](lessons-learned.md) — the first three days (March 2026)
- [Performance & portability evaluation](performance-portability-evaluation.md) — June 2026 audit
- [Evaluation follow-up](evaluation-follow-up-2026-07.md) — the July 2026 hardening series
- `superpowers/plans/`, `superpowers/specs/` — historical design records, not the backlog
