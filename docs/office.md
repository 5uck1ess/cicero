# The office — lanes, transfers, and an agent team behind one call

Cicero's most capable shape isn't the brain doing the work itself — it's Cicero as a **thin voice shell** in front of an agentic operator that orchestrates the actual work. Cicero owns the voice; the operator owns the doing. A fast front-desk model keeps the conversation snappy, while the heavy work runs out of the voice loop, where slow is fine.

## Lane switchboard

If your harness runs multiple agent personas (hermes profiles, for instance — a coder, a researcher, a planner), Cicero can be the front desk for the whole office. *"Let me talk to the coder"* transfers the conversation to that agent — its own memory, its own personality — until *"back to Cicero"* hands you back. Each lane can have its **own TTS voice**, so you hear who's talking:

```yaml
brain:
  backend: acp
  binary: hermes
  binary_args: [-p, voice, acp]
  lanes:
    coder:
      binary_args: [-p, coder, acp]
      aliases: [the coder, code guy]
      voice: am_michael          # kokoro preset, or a provisioned clone name
      greeting: "Coder here. What are we building?"
      persona: "Terse, precise, thinks out loud in short sentences."
    conductor:                   # a lane doesn't have to be hermes —
      binary: bun                # any ACP agent slots in (this one is
      binary_args: [x, "@zed-industries/claude-code-acp@0.16.2"] # Claude on a Max plan
      voice: bf_emma
    reviewer:
      backend: codex             # or drive the Codex CLI directly (no ACP mode):
      binary_args: [-s, workspace-write]   # session-resumed across turns
      voice: af_sky
```

- **Transfers are sticky** — a phone transfer, not a per-question relay. "Talk to / switch me to / pass me to / patch me through to X" pins; "back to you / that's all / hang up" releases.
- **Nobody plays dumb about what just happened** — a transferred-to colleague is briefed on what you were discussing, and on release the front desk gets a recap of the last few exchanges it missed. Control-plane actions leave the same trail: after "call me" rings your phone, asking "did you call me?" gets a straight yes instead of a denial from a persona that never saw the dial happen.
- **The first alias is the working name** — the one Cicero says when reciting the roster or running a roll call.
- **Lanes start lazily** on their first pin, so a big roster costs nothing at boot.
- **Voices resolve per engine**: cloning engines use provisioned clones from the voice library, and unknown names fall through to the kokoro fallback's presets — so cloned and preset voices mix freely across employees.
- **`persona`** is a spoken-personality instruction injected into the lane's session — the same agent backend can sound like a different colleague per lane.
- **`fallbacks`** gives a lane a ladder of alternative backends, so a downed provider doesn't take the employee offline.

Group phrases: **"roll call"** makes every employee check in briefly, each in their own voice, with a natural beat between speakers. **"Status from everyone"** makes each colleague report what it's working on (with the kanban toolset, the front desk can also read the task board back like a standup).

## Think lane

Say *"think hard about…"* and the turn routes to a second, heavier ACP agent — everyday turns stay on the fast one. Any two ACP agents work (different profiles, models, even different harnesses):

```yaml
brain:
  backend: acp
  binary: hermes
  binary_args: [-p, voice, acp]        # fast lane: small model, sub-second replies
  escalate:
    binary: hermes
    binary_args: [-p, think, acp]      # think lane: big model, deeper answers
    # triggers: ["think hard", "think deeply", "think carefully", "think it through"]
```

The lanes are separate agents with separate conversations, so escalation suits one-shot deep questions rather than mid-thread follow-ups. If the think lane fails to start, Cicero logs it and runs fast-lane-only.

## The operator pattern

The operator slot is pluggable — it's just Cicero's brain backend (see [brains](brains.md)). Any CLI agent or ACP operator can fill it. The reference driver is [hermes](https://hermes-agent.nousresearch.com), because the whole orchestration layer — per-task model routing, a durable Kanban board, parallel swarms, and `git`/`gh` execution — is native to it. Swap in a different agent and the same voice shell drives it.

```
  YOU ──speech──▶  CICERO         thin voice shell   ·  local, in-loop
                   (STT · TTS)       faster-whisper + streaming cloned-voice TTS
                      │ text (ACP)
                      ▼
                   OPERATOR        conductor: converse · decompose · route · summarize
                      │              runs on a fast model — must be a snappy in-loop tool-caller
                      ▼
                   KANBAN          durable board: decompose → route to profiles by role
             ┌────────┼────────┐
             ▼        ▼        ▼   PROFILES — each pinned to whatever model fits the role
           coder     docs      qa    run with the operator's own git/gh tools → open the PR
             └────────┴────────┘     out-of-loop, async, slow is fine
```

| Layer | Who | Job | Needs to be |
|---|---|---|---|
| Voice shell | Cicero | mic ↔ speaker, STT/TTS | fast I/O, in-loop |
| **Conductor** | operator on a fast model | converse, decompose, route, summarize | **snappy, reliable tool-caller** |
| Workers | operator profiles | do the work in an isolated workspace, incl. `gh pr create` | genuinely smart per role; async |

In this topology the conductor writes no code itself — a convention your harness's profile enforces, not something Cicero guarantees — it understands the spoken ask, decomposes it, and routes each task to the profile whose description says it's the right one for the job. Because the workers run *out* of the voice loop, the conversation stays snappy on a fast model while the heavy work runs async. The conductor's only load-bearing skill is **reliable tool-calling** — a much lower bar than agentic coding, which lets a small fast model drive frontier-class outcomes.

**A real turn, end to end:**

> **You:** "Fix the failing auth test and open a PR."
> **Cicero** transcribes → hands text to the operator over ACP.
> **The operator** files a Kanban task, routes it to the `coder` profile, and acks instantly: *"On it — spun up a task for the auth test."* (a filler clip covers first-token latency)
> **The worker** (async, on its profile's model) fixes the test, runs the suite, `gh pr create`.
> **The operator** reads the run and summarizes: *"Done — fixed the token-expiry check, suite's green, PR #142 is up."*
> **Cicero** speaks it.

## An example office

Every lane picks its own model, provider, and voice in config — here's one topology that works well on a single 24 GB GPU plus subscription plans:

| Employee | Model @ provider | Role | Voice |
|---|---|---|---|
| Front desk | a small fast local model (e.g. a ~4B-active MoE via llama.cpp) | spoken conversation, parks real work on Kanban | your cloned voice |
| `coder` | a frontier coding model on a **flat monthly plan** (Codex OAuth, Claude plan) with a free-tier fallback | design opinions in-conversation; Kanban workers do the async building | `am_michael` |
| `conductor` | Claude via `claude-code-acp` (plan-billed) | planning, decomposition talk-through | `bf_emma` |
| `qa` | any strong reviewer model (free-tier cloud or a second plan seat) | reviews finished work, runs suites, verdicts | `af_sky` |
| `think` | a large reasoning model at a fast-inference provider | deep answers at conversational speed | `bm_george` |

The pattern worth stealing: **subscription plans as lanes**. Agent-CLI adapters (Claude Code's ACP adapter, Codex OAuth) bill flat monthly plans instead of per-token API credits — so your two most expensive employees (frontier coder, frontier planner) cost the same whether you talk to them once or all day, and each declares a fallback chain for when plan limits bite.

**VRAM reality check (single 24 GB card):** front-desk LLM ≈ 15 GB (Q4 MoE via llama-swap) + STT ≈ 2.5 GB + TTS ≈ 1–2 GB ≈ **~20 GB**, with the think/coder/conductor/QA employees in the cloud on plans or free tiers. Tight but stable — and the whole spoken loop (ears, brain, mouth) never leaves the box.

> **Fast-inference provider gotchas** (Cerebras, and friends): tier limits are often **per-key** (keys minted before a paid upgrade can keep trial limits forever — mint a new key after upgrading), and **cached prompt tokens may still count against tokens-per-minute** (a 13k-token agent prompt can mean ~2 turns/min on a trial tier). Check both before blaming your stack.

## Fire-and-forget — background tasks + voice callbacks

The operator is **asynchronous by design**: you speak a task, the operator acks and files it on the Kanban board, and you're immediately free to keep talking, fire more tasks, or walk away. Each task runs in the background and **Cicero speaks up when it finishes** ("PR #142 is up") — and when it fails. Kanban already tracks many tasks at once, so "keep things running in the background" is native: you're driving a job queue by voice, not waiting on a chatbot.

The pieces that close the loop — proactive voice-back, the kanban watch, quiet hours, and the morning briefing — live in [notifications](notifications.md). The spoken confirmation gate on destructive ops lives in [brains](brains.md).
