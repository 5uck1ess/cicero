# Reference deployment — an always-on personal Cicero

The [first conversation](setup.md#your-first-conversation) gets you a working
voice loop in a terminal you're watching. This runbook turns that into the
thing the README promises: a box that's *always* there — browser or PWA from
any device on your network, Telegram texts, a real phone call, a morning
briefing — and that comes back on its own after crashes, reboots, and
upgrades.

It **composes** the feature guides rather than repeating them: behavior and
tuning live in [web voice](web-voice.md), [notifications](notifications.md),
[the call sidecar](https://github.com/5uck1ess/cicero/blob/main/sidecars/telegram-call/README.md), and
[security](security.md). Everything here is generic — swap paths for your own.

**Before you start:** run the first-conversation path by hand once, end to
end, including one real spoken turn. Never debug a fresh install through a
service manager.

## 1. Pin the secrets

An always-on deployment can't use the print-once web token, and its secrets
need one home:

- **Web token** — generate once with `openssl rand -hex 16` and set it as
  `web_voice.token` in `~/.cicero/config.yaml`. Do this *before* running under
  a supervisor: the per-run token prints to startup stdout, and supervisors
  retain stdout in logs.
- **Repo `.env`** (git-ignored, next to the checkout) — the Telegram bot token
  and, if you deploy calls, the userbot API credentials and the caller
  allowlist (`CICERO_TG_ALLOWED`). The call listener fails closed without the
  allowlist. Names and details: [notifications](notifications.md) and the
  [call sidecar README](https://github.com/5uck1ess/cicero/blob/main/sidecars/telegram-call/README.md).
- Those are the credentials *you* place. The runtime creates more of its own —
  the Telegram userbot session file, the sidecar hook token, agent settings
  copies — so treat `~/.cicero/` as credential-bearing wholesale. What must
  never leak into logs or dashboards, and the storage rules, are specified in
  [security](security.md).

## 2. The daemon, supervised

Use the shipped user unit — no root, survives logout via lingering:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/cicero.service ~/.config/systemd/user/   # edit WorkingDirectory first
systemctl --user daemon-reload
systemctl --user enable --now cicero
loginctl enable-linger $USER
journalctl --user -u cicero -f
```

The daemon launches and owns its model servers, so STT/TTS need no units of
their own — they stay running, and for most bundled engines the daemon also
revives one that dies unexpectedly (a few backends only report the death). A
managed engine's port staying closed is therefore a failure or an in-progress
recovery, not idleness: check `journalctl --user -u cicero` rather than
shrugging it off.

## 3. Phone calls, supervised

The Telegram call bridge is a separate process and needs its own unit —
running it in a terminal is the classic silent gap: everything works for
weeks, then a reboot kills incoming calls with nothing to notice. Ship it the
same way as the daemon:

```bash
cp deploy/telegram-call.service ~/.config/systemd/user/   # edit WorkingDirectory first
systemctl --user daemon-reload
systemctl --user enable --now telegram-call
```

Provision the sidecar (venv, userbot session, allowlist) per its
[README](https://github.com/5uck1ess/cicero/blob/main/sidecars/telegram-call/README.md) *before* enabling the unit. The
sidecar reconnects to the daemon by itself when the daemon restarts.

## 4. Reaching you: texts, briefings, schedules

All configuration, no new processes — the bot, quiet hours, the morning
briefing, and scheduled prompts are `notify:` blocks in `config.yaml`,
documented in [notifications](notifications.md). The *"call me"* intent needs
no config of its own — it's built into the daemon and works once the Telegram
text line and the call sidecar are up. For the always-on shape you'll
typically want at minimum: the Telegram bot (two-way text line), quiet hours,
and the briefing time.

## 5. Prove it survives a reboot

Don't declare the deployment done until you've watched it come back:

```bash
sudo reboot
# after the box returns:
systemctl --user status cicero telegram-call   # both active
cicero status                                  # daemon + configured backends
```

Then the real acceptance tests, in order: one spoken browser turn, one text to
the bot and its reply, and one *"call me"* that actually rings. If you only
check ports, you'll miss an unauthenticated CLI or a dead userbot session.

## 6. Upgrades

```bash
cd <your-checkout>
git pull --ff-only
bun install
systemctl --user restart cicero
```

Restart **only the daemon** by default. The call sidecar survives daemon
restarts on its own — it re-dials the daemon socket with backoff and releases
the bridge on Telegram's hang-up — whereas restarting `telegram-call` sends
SIGTERM to the listener, which *ends a live call*. Deploy sidecar changes separately, preferably between calls, and
actually apply what changed before restarting — a bare restart keeps stale
dependencies and stale unit definitions:

```bash
# Only when sidecars/telegram-call/ code, requirements, or .env changed:
uv pip install --python ~/.cicero/tgcalls-venv -r requirements/telegram-call.txt
systemctl --user restart telegram-call

# Only when deploy/cicero.service changed:
cp deploy/cicero.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user restart cicero

# Only when deploy/telegram-call.service changed (between calls):
cp deploy/telegram-call.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user restart telegram-call
```

Re-run the step-5 acceptance tests after any upgrade that touched the voice
path.

If you automate this (a cron that fetches, fast-forwards, and restarts), keep
three properties: fast-forward only on a clean checkout, restart only when
files the daemon actually runs changed, and an alert channel for the cases the
script refuses to handle. A dirty tree or a diverged branch is a message to
you, not something a deploy script should resolve.

## 7. Watch it (optional, recommended)

`Restart=on-failure` covers crashes; it does not cover a daemon that's up but
wedged, or a unit someone disabled. A small external check — cron hitting the
HTTPS endpoint and alerting through a path that does **not** depend on the
daemon (e.g. the Telegram Bot API directly) — closes that gap. Keep the
watchdog dumber than the thing it watches: probe, alert, at most restart;
decisions stay with you.

## 8. Back up the state that matters

Everything irreplaceable lives in two places:

- `~/.cicero/` — `config.yaml`, `voices/` (your reference WAVs), the Telegram
  userbot session file, health log, notification state.
- The repo `.env` — tokens and API credentials.

The checkout itself, models, and venvs are all re-creatable from the setup
guide. Never commit `.env`, session files, or real voice references — see
[security](security.md) for the storage rules.
