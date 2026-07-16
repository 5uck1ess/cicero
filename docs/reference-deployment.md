# Reference deployment — an always-on personal Cicero

The [first conversation](setup.md#your-first-conversation) gets you a working
voice loop in a terminal you're watching. This runbook turns that into the
thing the README promises: a box that's *always* there — browser or PWA from
any device on your network, Telegram texts, a real phone call, a morning
briefing — and that comes back on its own after crashes, reboots, and
upgrades.

It **composes** the feature guides rather than repeating them: behavior and
tuning live in [web voice](web-voice.md), [notifications](notifications.md),
[the call sidecar](../sidecars/telegram-call/README.md), and
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
  [call sidecar README](../sidecars/telegram-call/README.md).
- Nothing else should hold credentials. What must never leak into logs or
  dashboards is specified in [security](security.md).

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

The daemon launches and supervises its own model servers, so STT/TTS need no
units of their own. Note that speech engines it manages may shut down when
idle — a health probe finding a TTS port closed between conversations is
normal, not an outage.

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
[README](../sidecars/telegram-call/README.md) *before* enabling the unit. The
sidecar reconnects to the daemon by itself when the daemon restarts.

## 4. Reaching you: texts, briefings, schedules

All configuration, no new processes — the bot, quiet hours, the morning
briefing, scheduled prompts, and the *"call me"* intent are `notify:` blocks
in `config.yaml`, documented in [notifications](notifications.md). For the
always-on shape you'll typically want at minimum: the Telegram bot (two-way
text line), quiet hours, and the briefing time.

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
systemctl --user restart cicero telegram-call
```

Restart the call sidecar whenever you restart the daemon, not only when
sidecar files changed — a long-lived bridge across a redeployed daemon can
hold a stale session and fail exactly when someone calls. Re-run the step-5
acceptance tests after any upgrade that touched the voice path.

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
