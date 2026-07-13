# Telegram calls — Cicero on a real phone call

Cicero rings you on Telegram (or answers when you ring it) and you talk to the
same brain, in the same cloned voice, on a live call — screen locked, phone in
your pocket. The bridge pipes the call's audio through the daemon's existing
authenticated streaming WebSocket, so everything you configured (brain lanes,
confirmation gate, kanban tools) works on the phone too.

Built on [pytgcalls](https://github.com/pytgcalls/pytgcalls) / ntgcalls
(WebRTC) + [pyrogram](https://docs.pyrogram.org) (MTProto session).

## Why a second Telegram account

Telegram **bots cannot make calls** — calls are user-account territory, so the
bridge runs as a "userbot". And an account can't call itself, so for
"Cicero calls *you*" it needs its own identity: a second account on any number
that can receive **one** signup SMS. After signup the number is never needed
again (see *Phone migrations* below).

Don't run this on your personal account — a daemon holding your main session
is a bad trade, and userbot-ish behavior is where Telegram's abuse heuristics
look first.

> **Terms-of-service note:** automating a user account sits in a gray area of
> Telegram's ToS. This bridge is a polite citizen — one account, calls only
> with yourself, no mass messaging — but Telegram bans userbots at its sole
> discretion and accounts have been suspended for far less. Assume the
> account is expendable (that's half the reason it's a second account), and
> accept that risk before setting this up. This sidecar is optional; every
> other Cicero surface works without it.

## Setup (one time, ~15 minutes)

1. **Create the Python 3.11 environment.** TgCrypto 1.2.5 publishes a CPython
   3.11 wheel; using a newer interpreter falls back to a local native build
   (and Pyrogram does not support Python 3.13):

   ```bash
   uv venv ~/.cicero/tgcalls-venv --python 3.11
   uv pip install --python ~/.cicero/tgcalls-venv -r requirements/telegram-call.txt
   ```

2. **Create the Cicero account** in the Telegram app (the one SMS).

3. **Mint API credentials** at [my.telegram.org](https://my.telegram.org),
   logged in **as the new account**: *API development tools* → App title and
   short name `cicero`, platform *Other*, everything else blank → you get
   `api_id` and `api_hash`. (Only those two matter — ignore the public keys,
   DC configuration, and FCM fields. If the form says "ERROR", retry or switch
   networks; the endpoint is famously moody.)

4. **Store them** in the repo's `.env` (gitignored). The sidecar repairs this
   file to owner-only mode (`0600`) when it reads it and refuses a symlink:

   ```bash
   echo 'CICERO_TG_API_ID=<id>' >> .env
   echo 'CICERO_TG_API_HASH=<hash>' >> .env
   echo 'CICERO_TG_ALLOWED=<your-numeric-user-id>' >> .env  # required for --listen
   ```

5. **Log the session in** — interactive (asks for the account's phone number,
   then the code that appears in its Telegram app):

   ```bash
   uv run --python ~/.cicero/tgcalls-venv -- python sidecars/telegram-call/login.py
   ```

   The session persists under `~/.cicero/telegram-call/` — this never asks again.
   Cicero creates the directory as `0700`, keeps `cicero.session` and its SQLite
   sidecars at `0600`, and refuses symlinked/non-owner session paths.

6. **Harden the account** (5 minutes, makes the phone number disposable):
   - Add the account to your phone's Telegram app as a second account — login
     codes then always arrive in-app, never by SMS.
   - Set a 2FA cloud password (Settings → Privacy → Two-Step Verification) —
     protects against carrier number recycling.
   - Settings → Privacy → *If away for* → 12 months.
   - Back up `~/.cicero/telegram-call/cicero.session` with your other secrets —
     it's a standing credential.
   - Never tap "terminate all other sessions" on this account.

## Usage

```bash
# Cicero rings you:
uv run --python ~/.cicero/tgcalls-venv -- python sidecars/telegram-call/call_agent.py --call @yourusername

# Or leave it listening and ring Cicero yourself (auto-answers):
CICERO_TG_ALLOWED=<your-user-id> \
  uv run --python ~/.cicero/tgcalls-venv -- python sidecars/telegram-call/call_agent.py --listen
```

Set `CICERO_TG_ALLOWED` (comma-separated numeric user ids) in `.env`. Listener
mode fails closed: `--listen` refuses to start when the allowlist is missing or
empty, and callers not on the list are never answered. Outgoing `--call`
continues to work without an allowlist.

For a deliberately public listener, the only override is the conspicuous
acknowledgement below. This lets **any Telegram user who can find the account**
talk to your configured brain, so it is strongly discouraged:

```bash
CICERO_TG_ALLOW_ANY_CALLER=I_UNDERSTAND \
  ~/.cicero/tgcalls-venv/bin/python sidecars/telegram-call/call_agent.py --listen
```

The allow-any override applies only to incoming voice calls. Text dial-back and
daemon callback notifications still require an explicit `CICERO_TG_ALLOWED`
owner id. The daemon must be running (`web_voice` enabled); the bridge reads its
URL/token from `CICERO_WEB_URL` / `CICERO_WEB_TOKEN`, defaulting to
`https://127.0.0.1:8090` and the token in `~/.cicero/config.yaml`.

Only one call is bridged at a time. A new allowed call replaces the prior
session; a hang-up (Telegram's discard update) releases the bridge immediately,
so a later callback request rings instead of being treated as "already on a
call". A callback request is consumed only when it actually rings: during a
live call it stays spooled (logged once) and rings after the call ends, and a
"busy" bridge that has delivered no caller audio for 15 seconds is treated as
a dead call, released, and rung anyway — a dial-back is an explicit ask and is
never silently lost. Shutdown (including SIGTERM from the
`pkill -f call_agent.py` reload, which is logged and handled gracefully)
closes the daemon socket, playback/reconnect workers, callback poller,
Telegram call client, and Pyrogram session under bounded deadlines.

## Daemon transport and logging

The bearer token is sent in the HTTP/WebSocket `Authorization` header, not in a
URL query string. HTTP and WebSocket redirects are rejected rather than
forwarding bearer/audio data. TLS certificate and hostname verification are on
by default:

- For the default local daemon, the sidecar trusts Cicero's generated
  `~/.cicero/web-voice/cert.pem` certificate.
- For a daemon on another machine or behind a private CA, set
  `CICERO_WEB_CA_FILE=/path/to/ca-or-server-cert.pem`.
- A public certificate uses the operating system trust store automatically.

If a legacy deployment cannot be fixed immediately, certificate verification
can only be disabled with the exact acknowledgement below. This makes the
bearer token and both directions of call audio vulnerable to interception; it
is not a normal setup:

```bash
CICERO_WEB_INSECURE_TLS=I_UNDERSTAND \
  ~/.cicero/tgcalls-venv/bin/python sidecars/telegram-call/call_agent.py --listen
```

Plain HTTP is accepted automatically only for loopback. Non-loopback HTTP also
requires `CICERO_WEB_ALLOW_PLAINTEXT=I_UNDERSTAND` and prints a warning. Prefer a
trusted certificate or a VPN instead. The bridge bounds HTTP bodies/responses,
WebSocket messages and queues, decoded WAV duration/shape, connection setup,
socket I/O, and shutdown waits. The HTTP deadline defaults to 60 seconds and
can be lowered with `CICERO_CALL_HTTP_TIMEOUT_S`; WebSocket setup/I/O use
`CICERO_CALL_WS_OPEN_TIMEOUT_S` / `CICERO_CALL_WS_IO_TIMEOUT_S`, and Telegram
startup/call setup uses `CICERO_CALL_SETUP_TIMEOUT_S`. Every value is range
checked at startup.

Transcripts, reply sentences, notification text, Telegram ids/usernames, and
callback reasons are not printed by default. For short-lived diagnostics only,
`CICERO_CALL_LOG_CONTENT=I_UNDERSTAND` re-enables conversation-content logging;
logs made under that override should be treated as sensitive.

## What leaves the machine

A Telegram call is an explicit cloud transport. The caller's microphone audio
and Cicero's rendered reply audio traverse Telegram's WebRTC/Telegram call
infrastructure, and normal Telegram account/call metadata reaches Telegram.
Cicero still performs STT and TTS locally when the configured providers are
local, but the claim that audio stays on the machine does **not** apply to this
optional sidecar.

The bridge also sends caller WAV data to `CICERO_WEB_URL` and receives rendered
audio from it. Keep that URL on the same host or a trusted VPN unless you
deliberately operate a remote daemon. A configured cloud brain receives the
transcribed words according to that provider's policy; it doesn't receive raw
audio from this bridge. Installing the sidecar downloads its Python packages
from their configured package/Git sources. At startup, py-tgcalls 2.x also
performs a best-effort version check against `raw.githubusercontent.com`; it
carries package-version metadata, not call content. Cicero's bridge itself has
no analytics or telemetry endpoint.

## Phone migrations

Login codes are delivered to the account's Telegram service chat — visible to
every logged-in session, including this one. Signing the account into a new
phone therefore never needs the original SIM:

```bash
uv run --python ~/.cicero/tgcalls-venv -- python sidecars/telegram-call/read_login_code.py
```

Trigger the login on the new phone, run that, type the code it prints (plus
your 2FA password). The helper prints a live login credential: run it in a
private terminal and clear the terminal scrollback afterward.

## Tuning & extras

- **Dial-back**: text `call me` (or `ring me`) to the agent account from an
  allowed id and it rings you. Requires a non-empty `CICERO_TG_ALLOWED`.
- **Barge-in tuning** (env vars, e.g. in the repo `.env`): the defaults suit a
  quiet room; raise the RMS values in noisy environments (a car) if Cicero
  gets interrupted by road noise, or lower them if it feels deaf to you.
  - `CICERO_CALL_BARGE_RMS` (default 1400) / `CICERO_CALL_BARGE_MIN_S` (0.25) —
    talking over Cicero while it speaks.
  - `CICERO_CALL_THINK_RMS` (900) / `CICERO_CALL_THINK_MIN_S` (0.35) —
    interrupting while it is still thinking (cancels the in-flight turn).
- **Daemon restarts mid-call** are survived: the bridge re-dials the daemon
  socket with backoff instead of going silent.
