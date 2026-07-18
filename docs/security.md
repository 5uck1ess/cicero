# Security model

Cicero is designed for a **trusted LAN or personal VPN**. It is a voice
remote-control for agents that edit files and run commands — treat the
daemon like you'd treat an SSH key to the box it runs on. This page states
the boundaries explicitly so you can decide what to expose.

## Threat model in one paragraph

Anyone who can reach the web-voice port **and** present the bearer token can
speak turns to your agents — which means they can do anything your agents
can do (edit repos, run tools, ring your phone). The token is the entire
authentication story: there are no accounts, no rate limits, no audit trail
beyond the daemon log. Keep the port on the LAN/VPN, keep the token secret,
and none of the rest of this page bites.

For the complementary question — what data goes where, per surface and
config key — see [What leaves the box](data-flows.md).

## The pieces

- **Bearer token** — every `/api/*` route, `/ws`, and the normal voice-page URL
  require it (`web_voice.token`; a random per-run token is printed to startup
  stdout if unset). Empty tokens never authenticate. Cicero keeps the token out
  of its application logger and dashboard event stream, but a service manager
  may retain stdout; configure a stable token before daemonizing. The token rides
  query strings and `Authorization` headers, and the PWA stores it in
  browser localStorage — anyone with the device unlock can extract it.
  Rotate it by changing the config and restarting. The installed PWA's `/app`
  HTML shell is public so it can recover that stored token after installation;
  the shell has no authority and cannot open the socket or call an API without
  the token.
- **Claude Code hook credential** — the loopback-only sidecar receiver has a
  separate bearer token in `~/.cicero/hook-token` (mode `0600` on POSIX).
  `cicero hook install claude-code` places the matching header in Claude
  Code's user settings and writes that file atomically with the same private
  mode. The receiver also rejects browser-origin requests,
  non-JSON/oversized/slow bodies, and excess queued speech. Rotate it by
  deleting the token file, reinstalling the hook, and restarting the receiver.
- **TLS** — on by default with an auto-generated **self-signed** certificate.
  That encrypts traffic but authenticates nothing; a LAN MITM could present
  its own cert and browsers will let users click through. Fine for a home
  network; put a real reverse proxy with a trusted cert in front for
  anything else. Explicit certificate/key paths must be supplied as a complete
  readable pair and are never overwritten. If automatic generation fails,
  Cicero refuses to expose a non-loopback listener over plaintext unless you
  deliberately set `web_voice.tls.enabled: false`.
- **Do not port-forward** `:8090` to the internet. If you need remote
  access, use a VPN (WireGuard/Tailscale) — the token was never designed to
  survive the public internet.
- **Config is code execution, by design.** Several config keys name commands
  Cicero will spawn: brain binaries (`brain.binary`, lane `binary_args`),
  the kanban watcher (`notify.kanban.command`), terminal adapters, sidecar
  launchers. Whoever writes `~/.cicero/config.yaml` owns the account the
  daemon runs as. Never load a config file you didn't write.
- **Agent tool permissions** — `auto_approve_tools: true` hands your agent
  unattended write access; the `confirm_tools` patterns are the guardrail
  (spoken/tapped approval, fail-closed, one approval = one call). See
  [brains](brains.md) for the semantics. Voice is an unauthenticated-feeling
  interface — configure the gates as if a houseguest might talk to it,
  because one can.
- **Telegram command identity** — set `notify.telegram.sender_user_id` to the
  Telegram account that may chat, log health data, request calls, and approve
  tools. It is mandatory for group chats. A legacy private-chat config is
  accepted only when Telegram marks it `private` and its sender id equals the
  configured `chat_id`; missing or mismatched identity metadata is rejected.
- **Audio egress** — the browser/local-mic STT/TTS path is fully local when its
  configured providers are local. Opt-in Telegram notifications/voice notes
  send rendered clips and message text through Telegram. The optional live-call
  sidecar sends **both directions of call audio** through Telegram's call/WebRTC
  infrastructure; only STT/TTS computation remains local. Any cloud brain/lane
  also receives your transcribed words. Local-only is the default; egress occurs
  only on the surfaces/providers you configure.
- **Computer-use egress** — `cicero do` feeds tool observations back to its
  configured LLM. Local and private-LAN models are allowed by default; public
  or cloud models require `--allow-cloud-data` or `compute.allow_cloud: true`.
  That opt-in means goals, selected file contents, and command output may leave
  the machine. File tools remain bounded by `--root` / `compute.root`, resolve
  symlinks before credential policy, and cap individual reads even after cloud
  egress is enabled. The optional browser permits public HTTP(S) only: loopback,
  private, link-local, and known metadata destinations are blocked for direct
  requests, redirects, frames, popups, and subrequests. These hard boundaries
  remain in force when confirmation prompts are auto-approved.
- **Secrets on disk** — tokens live in `~/.cicero/config.yaml`, `.env`, the
  generated `~/.cicero/hook-token`, and its copy in `~/.claude/settings.json`
  (Telegram bot token, TG API credentials), plus the Telegram userbot
  session file under `~/.cicero/telegram-call/`. That session file **is**
  the account — anyone who copies it can be that Telegram account. The call
  helpers enforce owner-only directories/files and reject symlink session/config
  paths; nothing is encrypted at rest.
- **Private local storage** — on POSIX, startup creates or tightens
  Cicero-owned private directories to mode `0700` and existing private files to
  `0600`. Security-sensitive paths are inspected without following symlinks;
  a symlink or wrong file type is refused instead of chmodded or overwritten.
  Windows keeps these paths under the user's profile but relies on Windows ACLs
  rather than POSIX mode bits. Conversation history is optional: if its path
  cannot be secured, persistence disables itself with a warning, and later
  read/write failures are skipped instead of crashing the daemon.
- **Local daemon control** — `~/.cicero/cicero.pid` is created exclusively at
  mode `0600` and includes the process-start identity. Duplicate starts fail,
  cleanup removes only the marker lease owned by that daemon, and `stop` never
  trusts a PID without matching its recorded identity. Symlinked, non-regular,
  permissive, and legacy integer markers fail closed.
- **Incoming Telegram calls** — the optional call sidecar is fail-closed:
  `--listen` requires a non-empty `CICERO_TG_ALLOWED` user-id allowlist. The
  conspicuous `CICERO_TG_ALLOW_ANY_CALLER=I_UNDERSTAND` escape hatch opens the
  voice line to every Telegram user who can reach the account; do not use it
  with a brain that has unattended tool permissions.
- **Inbound stream bounds** — agent JSONL records, OpenAI-compatible SSE event
  lines, and Wyoming headers/data/payloads have explicit byte caps. Wyoming also
  bounds events queued before a receiver is ready and applies one absolute
  receive deadline even when a server keeps sending irrelevant events. A peer
  that exceeds a cap, sends invalid UTF-8, or violates strict Wyoming framing
  fails the turn instead of growing daemon memory indefinitely. ACP additionally
  caps tolerated malformed records and ties inbound request credits to completed
  response writes, so a peer cannot turn a blocked stdio response pipe into an
  unbounded internal request queue.
- **Health and install endpoints** — `/health`, `/ready`, `/app`, the PWA
  manifest, and the icon are deliberately unauthenticated (orchestration and
  install flows). They expose only liveness/readiness and static client assets;
  all turn and control surfaces remain authenticated.
- **Telegram call → daemon transport** — the call bridge uses bearer headers,
  verifies TLS/hostnames, trusts Cicero's generated local certificate, bounds
  HTTP/WebSocket/audio data and deadlines, and suppresses conversation-content
  logs by default. Remote private CAs use `CICERO_WEB_CA_FILE`. The exact
  `CICERO_WEB_INSECURE_TLS=I_UNDERSTAND` and
  `CICERO_WEB_ALLOW_PLAINTEXT=I_UNDERSTAND` overrides are migration escape
  hatches, not recommended configuration.

## Reporting

It's a personal-scale project — open a GitHub issue for anything
non-sensitive; for something exploitable, use GitHub's private security
advisory on the repo.
