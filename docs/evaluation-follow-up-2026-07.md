# Evaluation follow-up — July 2026

> **Dated record (July 2026).** This documents an evaluation cycle and the PRs
> that closed it — useful as provenance, not as setup or usage guidance. Its
> claims were checked against the `main` tip at merge time and are not
> maintained afterwards.

This record closes the code evaluation of Cicero as a reusable voice layer for
different agent “brains.” It distinguishes defects addressed by the follow-up
PRs from architectural choices that should not be changed accidentally in an
isolated fix. The links below record what actually merged, what was folded into
another PR, and what was closed without merge. This documentation PR remains the
last merge in the series so its present-tense claims can be checked against the
final `main` tip.

## Outcome

The implementation is a credible single-operator voice product rather than a
prototype wrapper around one model. It already has a small `Brain` contract,
ACP and OpenAI-compatible boundaries, CLI adapters, streaming speech, multiple
transports, and local or remote providers. The evaluation found no reason to
replace that structure.

The initial weaknesses were at boundaries: unbounded local-LLM calls, streaming
frames, and owned command subprocesses; inconsistent context and cancellation
forwarding; races in audio ownership; permissive local surfaces; malformed
configuration reaching startup; source-checkout assumptions for Python; and
transport messages that did not identify their turn. The follow-up series
addressed those problems in focused PRs:

| Area | PR disposition |
| --- | --- |
| Repository hygiene, dependency audit, live-test opt-in | `shared-agent-guidance` ([#3](https://github.com/5uck1ess/cicero/pull/3)), `update-yaml-dependency` ([#4](https://github.com/5uck1ess/cicero/pull/4)), and `live-test-isolation` ([#5](https://github.com/5uck1ess/cicero/pull/5)) merged. |
| Agent autonomy, capabilities, context, and cancellation | `tab-inject-permissions` ([#6](https://github.com/5uck1ess/cicero/pull/6)), `preserve-brain-capabilities` ([#8](https://github.com/5uck1ess/cicero/pull/8)), `brain-context-contract` ([#16](https://github.com/5uck1ess/cicero/pull/16)), and `tab-inject-cancellation` ([#24](https://github.com/5uck1ess/cicero/pull/24)) merged. `turn-cancellation` [#10](https://github.com/5uck1ess/cicero/pull/10) closed after its signal-cancellation slice was folded into `daemon-lifecycle` [#18](https://github.com/5uck1ess/cicero/pull/18). |
| Speech latency, local-model fallback, and audio ownership | `streaming-tts-first-audio` ([#7](https://github.com/5uck1ess/cicero/pull/7)), `audio-lifecycle` ([#20](https://github.com/5uck1ess/cicero/pull/20)), and `local-llm-stream-reliability` ([#21](https://github.com/5uck1ess/cicero/pull/21)) merged. |
| Local, dashboard, Telegram, action, and compute security | `harden-local-surfaces` ([#9](https://github.com/5uck1ess/cicero/pull/9)), `secure-local-storage` ([#11](https://github.com/5uck1ess/cicero/pull/11)), `telegram-call-allowlist` ([#12](https://github.com/5uck1ess/cicero/pull/12)), `harden-action-execution` ([#13](https://github.com/5uck1ess/cicero/pull/13)), and `guard-compute-egress` ([#14](https://github.com/5uck1ess/cicero/pull/14)) merged. |
| Configuration, web-turn protocol, and daemon lifecycle | `validate-runtime-config` ([#15](https://github.com/5uck1ess/cicero/pull/15)), `web-turn-protocol` ([#17](https://github.com/5uck1ess/cicero/pull/17)), and `daemon-lifecycle` ([#18](https://github.com/5uck1ess/cicero/pull/18)) merged. |
| Local-LLM deadlines, backpressure, and Python portability | `python-portability` [#22](https://github.com/5uck1ess/cicero/pull/22) and the 30-second local-LLM deadline/reasoning-filter slice in [#21](https://github.com/5uck1ess/cicero/pull/21) merged. The broader `provider-deadlines` [#19](https://github.com/5uck1ess/cicero/pull/19) was closed without merge. |

The extended audit then merged literal config matching, private-host checks,
fail-closed web startup, transactional reloads, capability-bound approvals,
authenticated hooks, the end-to-end voice-provider contract, bounded command
work, Telegram ingress/call hardening, Codex session isolation, stream framing,
and ownership-safe PID control
([#25](https://github.com/5uck1ess/cicero/pull/25)–[#38](https://github.com/5uck1ess/cicero/pull/38)).

A second boundary pass completed the work that was still open in that snapshot:
bounded HTTP provider transfers and secure temporary audio
([#39](https://github.com/5uck1ess/cicero/pull/39),
[#40](https://github.com/5uck1ess/cicero/pull/40)); managed-server and ACP
ownership ([#44](https://github.com/5uck1ess/cicero/pull/44)–[#46](https://github.com/5uck1ess/cicero/pull/46)); microphone/AEC and synthesized-audio
ownership, bounded CLI/notification I/O, native-sidecar and reference-cache
lifecycle, pinned toolchain, review/private-storage hygiene, owned players, and
bounded diagnostics ([#54](https://github.com/5uck1ess/cicero/pull/54)–[#62](https://github.com/5uck1ess/cicero/pull/62)); and STT fallback, web shutdown,
agent narration, switchboard cancellation, system-speaker ownership, shared
process primitives, and configured-backend startup
([#63](https://github.com/5uck1ess/cicero/pull/63)–[#69](https://github.com/5uck1ess/cicero/pull/69)). Issue
[#70](https://github.com/5uck1ess/cicero/issues/70) closed after the final
speaker release latch gained a tested recovery path in
[#67](https://github.com/5uck1ess/cicero/pull/67).

The closing startup/configuration pass made the flagship headless path fail
closed, gave standalone voice commands exact lifecycle ownership, rejected
unknown configuration keys, made CLI status/control output describe the
effective configuration rather than hardcoded legacy defaults, and taught
`doctor` to verify the actual configured LLM and model, and rejected the last
configuration fields proven to have no runtime effect
([#71](https://github.com/5uck1ess/cicero/pull/71)–[#76](https://github.com/5uck1ess/cicero/pull/76)). Concurrent product work—morning-briefing presentation, the opt-in audio.cpp
STT backend and pinned source, plus its provisioning fixes—landed in
[#41](https://github.com/5uck1ess/cicero/pull/41)–[#43](https://github.com/5uck1ess/cicero/pull/43),
[#52](https://github.com/5uck1ess/cicero/pull/52), and
[#53](https://github.com/5uck1ess/cicero/pull/53) and was included in every
subsequent full-suite revalidation.

## Decisions that are intentional

### “Any brain” means an adapter contract, not an unversioned plugin SDK

Today a brain is pluggable when it implements the TypeScript `Brain` interface
or is reachable through ACP, an OpenAI-compatible endpoint, or one of the CLI
adapters. That is the useful product boundary: the voice and transport layers do
not need to know which model or agent is behind it.

The package remains `private` intentionally. Publishing it as an SDK should wait
until it has compiled exports, semantic versioning, lifecycle compatibility
tests, and a documented plugin discovery/configuration contract. Until then,
“bring any brain” should be described as adapter-compatible rather than implying
that an arbitrary package can be installed with no integration work. Source
imports are internal integration points: the current package `module` targets
the CLI, and importing that entry executes Commander setup rather than a stable
library surface.

### Claude uses auto permission mode; full bypass stays explicit

The dedicated Claude tab should start in Claude’s `auto` permission mode. It
must not silently add `--dangerously-skip-permissions`, because voice input can
be misheard and some transports can be remote. Full permission bypass remains
available only when the operator explicitly enables auto-approval. This keeps a
useful hands-free default without converting microphone access into implicit
authority for destructive commands.

### Transports identify turns, but the assistant is still single-operator

Web clients receive isolated connection state and explicit session/turn IDs so
late STT or agent results cannot be delivered as the wrong turn. That does not
create independent conversational memory for multiple people: transports still
share the configured brain and lanes by design.

Do not expose one daemon as a multi-tenant assistant. Per-user memory, policy,
and provider sessions require an identity-aware session coordinator and one
brain instance (or provider session) per isolation domain.

### Parking a long turn releases audio, not stateful-agent serialization

A long-running turn may release the microphone/speech floor and report progress
later. Before parking, a new interrupt can cancel the turn when the adapter
supports cancellation. Once parked, the turn is deliberately detached from
audio/client aborts and continues until completion or `max_background_s`; its
agent/session lock remains serialized so two prompts cannot corrupt the same
conversation.

True concurrent background work therefore requires separate agent sessions and
a coordinator that owns completion delivery. Removing the lock from the current
path would trade responsiveness for nondeterministic session state.

### One turn coordinator is the next architectural refactor

Local microphone, web, HTTP, and Telegram entry points still contain similar
STT → context → brain → TTS/error orchestration. The evaluation deliberately
does not combine those paths in the same change set as the boundary fixes.

The next refactor should introduce one `TurnCoordinator` with a request shaped
roughly as `{ sessionId, turnId, source, audio/text, signal }` and an event stream
for transcript, progress, audio, completion, and failure. It must preserve:

- one owner for each turn and one terminal outcome;
- stale-result suppression at every awaited boundary;
- cancellation propagation into brain and provider calls;
- per-session context isolation chosen by policy;
- transport-specific encoding outside the coordinator;
- bounded input, output, and retained history.

Behavioral tests for the current transport paths should be the migration oracle.
This is a maintainability and multi-device feature, not a prerequisite for the
single-operator product to work.

### Performance changes require an end-to-end benchmark

First-audio streaming, finite local-LLM and owned-subprocess deadlines, bounded
streaming frames, bounded inference concurrency, and audio lifecycle fixes are
correctness wins and do not require changing model quality. More aggressive
startup parallelism, persistent playback subprocesses, or new default models
should be chosen from measured microphone-to-first-audio, steady-state latency,
cancellation latency, memory, and cold-start data on the supported operating
systems.

The Python resolver handles native Windows and POSIX virtual-environment layouts.
Locating bundled `servers/` assets independently of a source checkout remains
part of the future packaging/SDK decision.

### Accepted residual risks and deployment work

Daemon PID control now uses a private versioned record, process-start identity,
an ownership token, two identity reads before `SIGTERM`, and atomic publication
([#37](https://github.com/5uck1ess/cicero/pull/37),
[#38](https://github.com/5uck1ess/cicero/pull/38)). A very small race remains
between the final identity check and the signal. Eliminating it requires an
OS-specific process handle such as Linux `pidfd`; the current double-fingerprint
check is the accepted cross-platform boundary for this single-operator daemon.

Deployments upgrading from the legacy integer/empty PID marker need a one-time
migration: stop the old daemon, independently verify that its process exited,
then remove the old `~/.cicero/cicero.pid` before the first upgraded start. New
code intentionally refuses the unsafe marker; never delete it while the legacy
daemon may still be running.

A hard crash during PID publication can leave a uniquely named
`.pending-<pid>-<uuid>` file. It is never treated as the live marker and cannot
block startup, so an automatic sweeper is not required for correctness.

TLS generation is now bounded, cancellable, and atomically published, but the
first self-signed pair still depends on an `openssl` executable. `doctor` checks
that prerequisite when generation is needed. Certificate trust prompts, LAN
hostnames, a remote call-sidecar private CA, and real browser microphone
secure-context behavior remain live deployment checks rather than facts CI can
prove.

The generated certificate encrypts the connection but, until a client explicitly
trusts it, does not authenticate the daemon against a LAN man-in-the-middle.

Owned command, agent, audio, and managed-server paths now share the same bounded
process-tree termination primitives where their OS contracts match. TLS setup
keeps a smaller purpose-built path because it publishes one atomic artifact and
uses different cancellation semantics. The remaining process gap is native:
Windows needs Job Objects for POSIX-like descendant ownership, while eliminating
the final PID signal race on Linux needs a handle such as `pidfd`.

Configuration validation now rejects unknown keys and explicitly rejects the
old `brain.turn_timeout_ms` spelling in favor of the implemented
`brain.timeout_ms` HTTP deadline. It also rejects legacy server, speech-provider,
and brain fields that were previously accepted but ignored; the only implemented
`turn.backend` value is validated literally. `doctor` and `status` derive their
checks from the effective backends. One compatibility wart remains visible
rather than hidden: the macOS native hotkey helper listens to the fixed
Ctrl+Shift+Space chord, and the legacy `wake_word_enabled` name selects Wispr
Flow hotkey mode, not acoustic wake-word detection. Status warns about
unsupported hotkey values; the docs do not promise rebinding.

### Remaining performance and platform work is deliberately measured work

The follow-up fixes correctness and makes incompatible local MLX defaults visible
in `doctor`; it does not silently choose or persist a CPU model/profile for a
non-Apple machine. Model selection should be an explicit install-time choice.

The following items remain deferred until they have representative benchmarks or
platform owners:

- parallel provider/sidecar startup, after measuring cold-start time and peak
  memory rather than increasing boot concurrency speculatively;
- a persistent playback process for the non-AEC local speaker path, after
  measuring time-to-first-audio and interruption latency against the current
  per-sentence player;
- persisted p50/p95 latency and memory reports across a named hardware matrix;
- platform-aware action execution on Windows, where several built-in actions
  still assume `/bin/sh` and Unix utilities;
- Windows Job Object ownership for subprocess descendants. Cancellation and
  deadlines fail closed, but Windows cannot make the same normal-success process
  group guarantee as POSIX without a Job Object boundary;
- full macOS and Windows audio/device CI; manifest resolution is tested, hardware
  drivers and acoustic behavior are not;
- collision-free ephemeral ports across the remaining sidecar tests and the full
  Bun/typecheck suite on macOS and Windows. The portability workflow currently
  runs focused Python path/manifest checks there; the general CI suite remains
  Ubuntu-only;
- hard isolation for a custom in-process provider that ignores `AbortSignal`;
  cooperative cancellation is part of the adapter contract, while forcibly
  stopping arbitrary code requires a worker or subprocess boundary.

## Final disposition

The original replay order has been executed; it is not a queue of branch names
to revive. Two published proposals closed without merge:

1. `turn-cancellation` [#10](https://github.com/5uck1ess/cicero/pull/10)
   closed after its signal-aware daemon cancellation behavior was folded into
   [#18](https://github.com/5uck1ess/cicero/pull/18).
2. The broad `provider-deadlines` [#19](https://github.com/5uck1ess/cicero/pull/19)
   was split into reviewed pieces. Local voice-stream deadlines/reason filtering
   shipped in [#21](https://github.com/5uck1ess/cicero/pull/21), and bounded HTTP
   transfers shipped in [#39](https://github.com/5uck1ess/cicero/pull/39).

All other implementation PRs named in this record merged before this final
documentation PR. Review blockers were addressed on their current tips rather
than waived, and issue [#70](https://github.com/5uck1ess/cicero/issues/70) is
closed. The repository already ignored `.DS_Store` and contained no tracked
copies. Root `AGENTS.md` is now the shared, project-specific instruction source;
`CLAUDE.md` imports it instead of maintaining a divergent duplicate.

The material static-audit boundary has been reached. Additional unmeasured
changes to startup ordering, model defaults, playback architecture, or transport
coordination now have a higher regression risk than expected correctness gain.
The remaining work below needs hardware, benchmark data, an explicit public-SDK
decision, or an OS-specific owner—not another blind code sweep.

## Integration evidence

The implementation base for this record is `b2ee13e`, the merge of
[#76](https://github.com/5uck1ess/cicero/pull/76) after all preceding
implementation PRs. The final documentation diff was then validated on that
base with the repository-pinned toolchain:

- Bun 1.3.14 full suite: 1,755 passed, 5 opt-in/platform tests skipped, 0
  failed across 197 files; `bun run typecheck` and `git diff --check` passed.
- `config.yaml.example` parsed as YAML, deep-merged over `DEFAULT_CONFIG`, and
  passed strict runtime validation; all 75 local Markdown targets resolved.
- The Codex migration validator accepted the 4.0 KiB root `AGENTS.md` under its
  32 KiB review threshold. Its only warning was the intentional absence of a
  repository `.codex/config.toml`; machine-local agent endpoints are not
  tracked.
- Telegram-call unit tests passed 30/30. Model-free Python sidecar contracts
  passed 29/29 in all four CI combinations (Python 3.10 and 3.11, highest and
  lowest-direct dependency resolution), and the Python 3.11 Telegram native
  dependency contract passed.

GitHub attached no hosted check run to #76. The most recent attempted
[CI run](https://github.com/5uck1ess/cicero/actions/runs/29173048553) failed
before executing any step because the account payment/spending-limit gate
prevented jobs from starting. That is recorded as an infrastructure blocker,
not a test failure, and no hosted-CI pass is claimed for the final series.

The final suite covers protocol ownership, cancellation, context, strict
configuration, bounded requests and streams, process cleanup, provider
fallback/recovery, and rapid audio reactivation. It deliberately keeps live
agent CLIs, model downloads, credentials, and hardware out of the default test
run. Those conditions belong to the acceptance matrix below.

## Acceptance beyond CI

Automated tests cover protocol ownership, cancellation, context, malformed
configuration, path resolution, bounded requests, subprocess failures, and
rapid audio reactivation. They cannot validate real acoustic echo cancellation,
device drivers, provider credentials, or network conditions. Before calling a
release generally available, run a hardware smoke matrix for:

- local microphone, speakers, barge-in, and stop phrases on macOS and Linux;
- Windows interpreter discovery plus the chosen microphone/playback tooling;
- one ACP brain and one OpenAI-compatible brain through a full voice turn;
- real audio.cpp, Pocket-TTS, VibeVoice, and ElevenLabs add → use → render
  cycles, including subjective audio quality and real provider credentials;
- live audio.cpp ASR accuracy/latency and failure recovery on the intended CUDA
  hardware. Issue [#51](https://github.com/5uck1ess/cicero/issues/51)
  reverified the pinned TTS seat only; it was not acceptance for the opt-in STT
  backend from [#42](https://github.com/5uck1ess/cicero/pull/42);
- browser reconnect and two simultaneous clients without stale delivery;
- first-run OpenSSL certificate generation on Linux, macOS, and Windows, then
  browser trust, LAN hostname, and microphone behavior over the generated TLS;
- Telegram inbound allowlist and real MTProto/WebRTC outbound calls, including
  NAT traversal, reconnect, barge-in, wrong-CA failure, and call replacement;
- one local STT/TTS stack and one remote/provider stack under timeout failure.

Use the documented Python 3.11 call-sidecar environment unless a different
runtime has been explicitly smoke-tested with real Telegram credentials and
network conditions. These are release-validation gates, not unresolved
code-review findings.
