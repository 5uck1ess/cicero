# Using Cicero

You have run [setup](setup.md), started Cicero and opened the page. This is
what day-to-day use looks like.

## What to say

Talk to it the way you would talk to a colleague at the next desk. Everyday
questions ("what's broken on CI?", "what did the last commit change?") go to
the front desk. With an agent front desk, the agent answers everything and can
use its tools. With a model front desk, the model answers quickly and hands
harder work to your agent (see [Thinking harder](#thinking-harder) below).

On the web page, click **Start conversation** first, then hold SPACE or the
orb while you speak (push-to-talk), or switch to hands-free. You can also type
into the text box; typing runs the same pipeline without the microphone.
Details are in the [web voice guide](web-voice.md).

## Interrupting

Talk over Cicero at any time and it stops speaking and listens ("barge-in").
A small local voice-activity model checks that it is actually speech first, so
keyboard noise and music do not cut it off. Typing while it speaks interrupts
it too. Within five minutes, "continue", "go on" or "as you were saying"
resumes the interrupted reply from what you actually heard.

## "Details" after a short reply

Long replies are shortened by default: Cicero speaks the first four
sentences and one closing line, and the full text lands in the chat pane. With
a helper model, that closing line is a one-line summary of the rest; without
one, it is a generic "plus N more sentences". Say **"details"** (or "tell me
more", "read the rest", "full version") to hear the rest. Set
`web_voice.tldr.enabled: false` to hear every sentence.

## Thinking harder

With a model front desk and an ACP agent chosen on the Agent step, these
phrases send that turn to the agent instead of the front desk:

- "think hard"
- "think deeply"
- "think carefully"
- "think it through"

The agent and the front desk keep separate conversations, so this suits
one-off deep questions rather than follow-ups in the middle of a thread. You
can change the phrases with `brain.escalate.triggers`.

## Privacy

The Privacy step wrote one of two modes into `privacy.mode`:

- **`local`: nothing leaves this machine unless you allowed it.** The front
  desk, the helper and speech run here. The wizard offers a cloud coding
  agent or a hosted task board only after you allow that item
  (`privacy.allow`); Telegram, which you add by hand for now, needs
  `telegram` in that list or `cicero doctor` warns. What leaves with each:
  prompts and code go to the agent's company, message text to Telegram, task
  text to the board.
- **`cloud`: conversation may use cloud models.** The front desk and agents
  may be cloud services. The helper and speech still run here, and Telegram and
  task boards still need their own allowance.

This is a declared policy, not a firewall. The wizard only offers what the
policy allows, and `cicero doctor` warns when the config drifts from it (for
example, a cloud endpoint added by hand in `local` mode). Neither can see what
a CLI agent does on the network once it runs.

## Checking what is running

```bash
cicero status          # the effective config and what is running right now
cicero doctor          # checks every configured part and prints fixes
cicero doctor --json   # the same checks as JSON, for scripts and AI agents
```

`cicero doctor` confirms binaries, ports and config, including the privacy
warnings above. It cannot prove that an agent's CLI login works; one real
spoken turn does.
