# Daemon mode — local mic, conversational voice, computer use

The same voice loop as web-voice, but with a local mic/speaker on the box itself: mic in → STT → intent classification → brain dispatch → streaming TTS. This is the mode for a machine you sit at.

## Lifecycle and embedding

`CiceroDaemon.start()` initializes the stack and resolves when it is ready. It does not install process-global signal handlers, wait forever, or call `process.exit()`. An embedding host owns its own lifetime and calls the idempotent `stop()` method; partial startup failures automatically roll back already-created resources and release the daemon marker. The `cicero start` CLI is the layer that waits for `SIGINT`/`SIGTERM`.

Only one daemon can claim `~/.cicero/cicero.pid`. The marker is a private
versioned record containing both the PID and the operating system's process
start identity, not a bare PID. `cicero status` and `cicero stop` verify that
identity before reporting or signaling the process, so a stale marker cannot
target an unrelated process after PID reuse. A crashed daemon's verified-stale
marker is replaced on the next start. Unsafe legacy, symlinked, non-regular, or
non-private markers are rejected with an actionable error instead of followed
or overwritten.

## Live STT/TTS swaps

A running daemon can replace either speech provider without restarting:

```bash
cicero swap stt faster-whisper
cicero swap stt faster-whisper Systran/faster-whisper-large-v3-turbo
cicero swap tts kokoro
cicero swap tts kokoro hexgrad/Kokoro-82M
```

The optional final argument overrides the model. Cicero constructs and starts
the complete configured provider, including its fallback, then requires warmup
and a healthy primary before cutover. Local managed replacements that would
collide with the live provider are staged on a free loopback port. New work uses
the replacement after cutover; work already holding the old generation is
allowed to finish before that generation is stopped.

Only a successful readiness gate is written to `~/.cicero/config.yaml`, using
the same atomic private-file update as other configuration commands. A startup,
warmup, health, or persistence failure cleans up the candidate and leaves both
the active provider and config unchanged. One swap may run at a time across
both roles, preventing simultaneous STT/TTS writes from racing the shared
config file. A concurrent
request exits non-zero with `another provider swap is already in progress`.
The command's success line names the active backend/model and says
`Config persisted`; preparation and persistence failures explicitly say the
current provider and config were retained. A rare post-cutover cleanup failure
instead reports that cutover committed but old-provider cleanup is unconfirmed;
the daemon does not lie about rolling back after ownership became uncertain.

The CLI reaches the daemon through a loopback-only authenticated control socket.
Its short-lived descriptor is private under `~/.cicero/` and is removed during
clean shutdown. If the descriptor is absent, the CLI reports that runtime
control is unavailable instead of editing config behind a stopped daemon.

## Conversational mode

Type `voice` in the cicero prompt or, on macOS with the helper built, press **Ctrl+Shift+Space** to toggle. The native helper currently listens to that fixed chord; configuring another display value does not rebind it. Cicero continuously listens, transcribes, responds via streaming TTS. Say "stop listening" or "goodbye" to deactivate.

**Hands-free:** a **double-clap** arms voice mode (on by default — `clap.enabled`). To also double-clap to turn it *off*, set `clap: { deactivate: true }`. Off-mode clap detection runs its own mic; on-mode deactivation is read from the conversational recorder's own stream (no second mic), so it needs `vad.enabled` (the default). The clap threshold is deliberately high (`clap.threshold`, peak ≥ 0.5), and a false trigger only turns voice off — you just clap again to bring it back.

LLM tokens are streamed through sentence-boundary detection directly to TTS, so you hear the first sentence while the rest is still generating.

## Full-duplex (continuous, interruptible)

By default the loop is half-duplex: Cicero listens, then speaks, then listens again (a short *ready* beep marks each handoff). Turn it into a continuous, interruptible conversation — talk over Cicero and it yields mid-sentence, no beeps, no ping-pong:

```yaml
full_duplex: true   # default false
```

While Cicero thinks or speaks, the mic stays open and the streaming VAD watches for speech. Finite capture windows automatically re-arm, so a long model/tool call does not become uninterruptible. Anything it catches is transcribed and compared against what Cicero is saying *right now* — if it's Cicero's own voice bleeding through the speakers it's ignored, so Cicero never interrupts itself. Only genuinely new speech interrupts the reply (an exact, bare "stop" just halts it; requests such as "stop the deploy" remain normal commands); everything else becomes the next turn.

**Open speakers need acoustic echo cancellation.** On macOS, set `aec: true` and run `bun run build:aec`; the Voice Processing helper routes both playback and the echo-cancelled mic through one duplex device. Helper startup is bounded and retried on the next activation. If it fails, Cicero falls back to the ordinary mic/player instead of hanging or going silent. Without AEC, use headphones for reliable voice-over-voice barge-in; transcript echo rejection still prevents the common self-interrupt loop, but it cannot make a raw mic hear quiet speech over loud speakers. (The browser in [web-voice mode](web-voice.md) uses browser AEC.)

**Double-clap remains the acoustic backstop.** A clap peaks *above* TTS, so it can cut through playback even without AEC. With `full_duplex: true`, **double-clap while Cicero is speaking to interrupt it**, then say your next thing. (While idle-listening, a double-clap deactivates voice mode only if `clap.deactivate` is set.)

Relies on the streaming VAD (`vad.enabled`, on by default). Barge-in stays armed across detector caps and during the interrupting turn's processing. Generation cancellation is cooperative for in-process adapters and a bounded, best-effort terminal interrupt for terminal-injected agents.

## Computer use (experimental)

`cicero do "<goal>"` lets Cicero take actions, not just answer — it picks tools (list/read/write files, run shell, open apps, and optionally a Playwright browser with `--web`) one step at a time. File tools are confined to the current directory by default; choose another boundary explicitly with `--root`. Existing file paths are resolved through symlinks before policy checks, so an alias cannot hide a credential-shaped read. Mutating actions prompt for confirmation, credential-shaped reads also require confirmation, and destructive shell patterns are refused outright.

The browser driver is optional. Install its browser once before using `--web`:

```bash
bun x playwright install chromium
```

```bash
cicero do "summarize the README files in this folder"
cicero do --root ~/Documents/notes "summarize my notes"
cicero do --web "find the current Bun version on bun.sh"
cicero do --yes "open my notes app"   # skip confirmation prompts
```

Browser actions are restricted to public HTTP(S) destinations. Cicero rejects
loopback, private, link-local, and known metadata destinations before approval,
and applies the same gate to redirects, frames, popups, and subrequests. Browser
confirmations identify the page involved, and observations report the verified
final URL. `--yes` skips human prompts; it does not bypass file boundaries or
browser destination checks.

Local and private-LAN `llm` backends run without an egress prompt. A public/cloud backend is refused by default because goals, file contents, and command output become model observations; opt in for one invocation with `--allow-cloud-data`, or persist that decision with `compute.allow_cloud: true`.

The inline-action pattern is inspired by [Clicky](https://github.com/farzaa/clicky) (MIT) — which points at on-screen elements but leaves the clicking to you. Cicero extends the idea to actually execute actions, behind a confirmation gate.

### By voice (conversational mode)

In conversational mode you can drive actions out loud — talk, it acts, it speaks back. Prefix the request with an explicit trigger so it doesn't get confused with an ordinary question:

> "**Computer,** open my downloads folder and tell me what's there."
> "**Use the computer to** summarize the README files here."
> "**Take action and** create a file called notes.txt."

Triggers: `computer, …`, `use the computer to …`, `take action …`, `go ahead and …`. Mutating actions are **confirmed out loud** — Cicero says what it's about to do and waits for you to say "yes" (a "no" always cancels); the spoken result is read back. The one-shot confirmation temporarily owns the mic, so full-duplex detection cannot start a competing recorder. Everything runs through the same safety policy and workspace boundary as `cicero do`; cloud-backed computer use additionally requires `compute.allow_cloud: true`.
