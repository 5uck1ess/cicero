# Native dictation

Record on demand, transcribe with Cicero's own STT, and put the text where you
want it. Off by default — it types into other applications, so it is opt-in.

```yaml
dictation:
  enabled: true
  target: focused-app        # or: cicero
  max_recording_seconds: 300
```

Toggle it with:

```bash
cicero dictate    # press once to start recording, run it again to stop
```

`cicero dictate` reaches the daemon over its existing authenticated local API,
so it needs `web_voice.enabled: true` and a fixed `web_voice.token` in your
config — the same requirement `cicero notify` has. Without them the daemon still
runs dictation, but there is no way to toggle it from the CLI.

## Binding it to a key

Cicero does not ship a global-hotkey helper for this. `cicero dictate` is a
plain command, so bind it with whatever your OS already provides:

| platform | where |
|---|---|
| macOS | Shortcuts.app → new Quick Action running the shell command, then assign a key in System Settings → Keyboard Shortcuts |
| Windows | right-click a shortcut to `cicero dictate` → Properties → Shortcut key |
| Linux | your desktop's Keyboard → Custom Shortcuts panel |

This is deliberate. A bundled global-hotkey listener would need a separate
native helper per platform, each with its own permission prompts and its own
failure modes; every desktop already has a supported way to bind a command.

## Targets

**`focused-app`** (default) types the transcript into whatever window has
focus. This is the dictation-app replacement.

**`cicero`** hands the transcript to Cicero as a spoken command instead —
nothing is typed. This works on every platform because it never synthesizes
keystrokes, and it is what the old hotkey listener did.

## Platform support for `focused-app`

| platform | how | status |
|---|---|---|
| macOS | AppleScript `keystroke` via System Events | supported; needs Accessibility permission for your terminal |
| Windows | PowerShell `SendKeys` | supported |
| Linux / X11 | `xdotool type` | supported; install `xdotool` |
| Linux / Wayland | — | **not supported** |

Wayland blocks synthetic keyboard input to other applications by design.
`xdotool` still runs there but reaches only XWayland clients, so dictation
would work in some windows and silently do nothing in others. Cicero refuses
the target rather than shipping that. Options: use an X11/Xorg session, or set
`target: cicero`.

`cicero doctor` reports which of these applies to your machine, and the daemon
logs the reason at startup rather than failing on the first hotkey press.

**Headless daemons do not run dictation.** `headless: true` means this box has
no local microphone to open — it already skips clap, conversational capture, and
the hotkey — and a dictation toggle records on that same machine. Setting both
is not an error, but dictation is disabled for the run and the daemon says so at
startup. Talk to a headless daemon through [web voice](web-voice.md) instead.

## Behavior

- **Toggle, not hold.** Press to start, press again to stop. There is no
  hold-to-talk: the macOS hotkey helper emits key-down only, and holding a
  chord through a paragraph is uncomfortable anyway.
- **A press during transcription is ignored**, not queued. Two captures racing
  to type into the same field is worse than dropping one. Simultaneous presses
  start exactly one capture — the API accepts concurrent requests.
- **The stopping press returns as soon as the recorder is released**, reporting
  `transcribing`; it does not wait out the decode. A caller is never held open
  for a slow model, and shutdown does not have to wait for that request before
  it can tear dictation down.
- **`max_recording_seconds`** (default 300) bounds a single capture so a
  forgotten dictation cannot record indefinitely. Hitting it stops the
  recording and transcribes what it has.
- **Long transcripts are truncated** at 10,000 characters before typing, with a
  warning. Model output driving a synthetic keyboard is bounded on purpose.
- **A transcript never presses Enter.** Newlines and tabs in a model's response
  become spaces before anything is typed. On a synthetic keyboard a newline is
  Return, so a transcript containing one would *submit* whatever window has
  focus — run the line at a shell prompt, send the message in a chat box.
  Speech has no Enter key, so a newline there is the provider's formatting, not
  something you said. Dictation types words; it does not act.
- **The clipboard is never touched.** Every platform drives a synthetic
  keyboard directly. The previous integration polled the clipboard and did not
  restore what it overwrote.
- **Pauses do not end a dictation.** The capture runs without the silence-based
  auto-stop a conversational turn uses, so thinking mid-sentence never cuts the
  recording short. Only the hotkey or `max_recording_seconds` ends it.
- **Dictation and voice mode are mutually exclusive.** They share one
  microphone, and on an exclusive capture device two recorders is a broken
  stream rather than a shared one. A dictation press takes the device from clap
  detection and hands it back when the capture ends; while voice mode is on, a
  press is refused instead of pre-empting the conversation.
- **Shutdown discards an in-flight capture** rather than transcribing it: the
  recorder is killed and the temp file removed. A transcription already under
  way is drained first, but one that misses the drain deadline is discarded
  rather than typed later.
- **A recorder that ignores its kill blocks the next capture** instead of being
  forgotten — it still holds the microphone. Dictation retries the reap on the
  next press and recovers on its own once the process exits.

## What this replaced

Cicero previously shipped a listener that drove Wispr Flow — a paid, macOS-only
dictation app — by simulating its activation hotkey and then polling the
clipboard every 500 ms for up to 30 seconds to see what it had produced. It
never restored the clipboard it read.

That made sense when Cicero had no STT of its own and the repo was private. It
does not ship in a public MIT project: it required a paid third-party product,
worked on one platform, and quietly clobbered operator clipboard state.

The `--wake-word` flag and `wake_word_enabled` config key were removed with it.
Neither ever enabled wake-word detection — their only effect was selecting that
listener.
