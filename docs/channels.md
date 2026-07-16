# Channels, transports, and sidecars

How voice and text actually reach Cicero, who owns each path, and — since
that's the question this doc exists to answer — what it takes to add a new
one. Read this before wiring up another messenger; most of the work is already
done by an existing pattern.

One boundary up front: Cicero is **single-operator by design** (see
[security](security.md)). Every *network-reachable* channel below
authenticates the operator (token, allowlist); the purely local ones — the
mic, terminal scraping — rely on local machine access instead. Either way, a
new channel must not quietly turn shared state into a multi-user contract.

## The map — every current way in and out

| Channel | Direction | Runs where | Transport & auth |
|---|---|---|---|
| **Local mic / speakers** | in + out | inside the daemon | direct audio devices ([daemon mode](daemon-mode.md)) |
| **Browser / PWA** | in + out | inside the daemon | WebSocket protocol v2 over HTTPS, token-authenticated ([web voice](web-voice.md), `src/web-voice/server.ts`) |
| **Telegram text bot** | in + out | inside the daemon | Bot API long-polling (`getUpdates`), user-ID allowlist (`src/notify/telegram.ts`, [notifications](notifications.md)) |
| **Telegram calls** | in + out | **separate Python sidecar** | bridges call audio ↔ the same authenticated web-voice WebSocket endpoint the browser uses, on the v1 framing (`sidecars/telegram-call/`) |
| **Sidecar mode** (`cicero hook` / `cicero scrape`) | out only | their own processes | agent hooks (Claude Code, Codex) post authenticated HTTP into the `cicero hook` receiver; `cicero scrape` watches a terminal tab (`src/sidecar/`) |
| **Notify targets** | out only | inside the daemon | browser voice-back, Telegram notes/texts, and ringing you via the call sidecar ([notifications](notifications.md)) |

Two facts fall out of the table that matter for extension work:

- **The web-voice WebSocket is the de-facto channel API for audio.** The
  Telegram call sidecar is not a special case in the daemon — it is just
  another authenticated client of the same endpoint. The daemon neither knows
  nor cares that a phone call is on the other side. One precision: the server
  speaks two framings — the built-in page requests protocol v2
  (`/ws?protocol=2`, tagged `CVP2` frames), while the call sidecar connects
  plain `/ws` and uses the original v1 raw-WAV/untagged-JSON format. A new
  bridge can use either; both are documented in
  [web voice → transport identity](web-voice.md#transport-identity-and-limits).
- **Text channels currently live inside the daemon.** Telegram text is wired
  directly into `src/notify/` — there is no channel registry to drop a module
  into. That's an honest limitation, not a plugin point.

## Adding a channel — the three patterns

### 1. A voice/call channel → write a bridge sidecar

The pattern for "I want to talk to Cicero over ___" is a **separate process**
that speaks the platform's audio API on one side and the authenticated
web-voice WebSocket on the other. `sidecars/telegram-call/` is the worked
example, and its responsibilities are the checklist:

- authenticate to the daemon with the web-voice token; reconnect with bounded
  backoff when the daemon restarts;
- enforce *its own* caller allowlist before bridging anyone to your agent
  (the Telegram sidecar refuses to *listen* for incoming calls without one;
  outgoing-only dialing works without it);
- resample platform audio to what the protocol expects, run local
  voice-activity detection, and forward barge-in;
- keep an absolute deadline and size bound on everything it reads from the
  platform — treat the messenger as untrusted input.

Because the daemon side is just another client, this needs **zero changes to
Cicero itself** — which is why it's the recommended shape for a WhatsApp or
Signal *call* bridge: same skeleton, different platform SDK. Expect the
platform SDK (not the Cicero side) to be most of the work, and check the
platform's terms allow a userbot/bridge at all.

### 2. A text channel → today, that's a daemon change

A new text ingress (WhatsApp/Signal messages) means code in the daemon
following the Telegram bot's shape: bounded polling or webhook ingress, an
operator allowlist, notify integration for the outbound half, plus the parts
[AGENTS.md](../AGENTS.md) requires of every adapter — config schema, `doctor`
and `status` coverage, example config, docs, and an explicit error (never a
silent fallback) for unsupported settings. It's a contribution to Cicero, not
a plugin. If you want this, open an issue first — the second text channel is
exactly when a proper ingress seam should be carved, and it's better designed
once than reverse-engineered from two hardcoded bots.

### 3. A brain-owned channel → maybe Cicero shouldn't be in the loop

Agent harnesses increasingly ship their own messenger integrations (Hermes,
for instance, has its own channel support). If the *agent* is present on
WhatsApp/Signal natively, Cicero doesn't need to bridge that platform at all —
Cicero remains the voice layer, and the brain talks text wherever it already
lives. Where the useful boundary sits — whether Cicero should relay its
notifications into brain-owned channels, or stay out entirely — is
**deliberately undecided**; nothing is built or promised here yet. If you're
weighing this path, the only current integration point is the brain adapter
contract in [brains](brains.md).

## Output-only integrations: `SpeakAdapter`

Sidecar mode has a real, small seam — but note its direction: a
`SpeakAdapter` is an **event source**, not an output sink. It implements
`{ name, attach(service), detach(), health() }` and *feeds agent output into*
a fixed `SpeakService` whose `speak({ text, agent?, skipSummary? })` does the
summarize-and-say work through Cicero's speaker (`src/sidecar/types.ts`). The
registry in `src/sidecar/registry.ts` ships exactly two adapters, and config
validation accepts only those names: the claude-code adapter — the
authenticated HTTP receiver that the `cicero hook` process runs, which Claude
Code's installed Stop hook posts into — and terminal scrape, run by the
separate `cicero scrape` command. The Codex integration is *not* a
`SpeakAdapter`: its hook posts authenticated HTTP to the same receiver's
`/speak` (`src/sidecar/codex-hook.ts`), which is the honest way in for any
*other* event source that can make a local HTTP call. So: "make Cicero speak
when X happens" fits here (post X to `/speak`); "mirror what Cicero says onto
a status LED or another chat surface" does not — there is no output-sink seam
today, and pretending otherwise would be exactly the kind of doc this file
exists to prevent.

## What this is not

There is **no stable third-party plugin SDK** and no package-discovery
contract: the package is intentionally private, and "pluggable" means the
documented adapter surfaces — a brain via ACP / OpenAI-compatible / CLI
adapters ([brains](brains.md)), speech providers via the backend registry
([configuration](configuration.md)), an audio channel via the web-voice
protocol, and output sidecars via `SpeakAdapter`. Anything deeper is a normal
code contribution, with the reliability rules in [AGENTS.md](../AGENTS.md)
applying in full.
