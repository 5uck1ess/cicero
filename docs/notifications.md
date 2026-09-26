# Notifications — Cicero speaks up unprompted

Anything on the box can make Cicero talk to every connected browser — kanban hooks, cron, CI, a finishing background job:

```bash
cicero notify "PR one forty two is up and CI is green."
# or from any script:
curl -sk -X POST https://127.0.0.1:8090/api/notify \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"The overnight batch finished."}'
```

The text renders through the same (cloned) TTS voice as replies and plays in the browser immediately — or, if you're mid-conversation, right after the current turn so it never talks over you. If no browser is connected, the notification is parked (up to 10, for 4 hours) and spoken to the next client that connects. Requires a fixed `web_voice.token` in config.

Every notification that is delivered (or parked) is also handed to the brain as one-shot context for your next turn — so a follow-up that doesn't name its topic, like *"take care of it"* or *"call me about that"*, refers to the most recent notification without any re-explaining. Notifications deferred by quiet hours (queued for the morning briefing, not parked) don't inject context at send time; when the briefing delivers them as a spoken call, the briefing passes its context the same way.

## Kanban watch

Cicero announces the agent's task board on its own. The daemon polls a harness CLI you configure (`command` — required; hermes shown as the example) and speaks up when a task finishes, blocks, or lands in review — "The coder finished the task: fix the flaky test." No hooks needed on the agent side; a built-in preset normalizes the board CLI JSON:

```yaml
notify:
  kanban:
    enabled: true
    preset: hermes                         # default when omitted
    command: [hermes, kanban, list, --json]   # required when enabled
    # task_command: [hermes, kanban, show]    # optional — `<task_command> <id> --json` prints one task; enables the deliverable-link card
    interval_seconds: 20            # poll cadence
    call_back: true                 # ring the phone for done/review — never for blocked
    # escalation: priority          # optional: route Multica/Paperclip by board priority instead
    nudge_after_minutes: 60         # remind about tasks nobody picked up; 0 = off
```

Announcements fire on `done`/`blocked`/`review`, and an `assignee` matching a lane name speaks in that employee's voice.

`notify.kanban.escalation: priority` opts Multica or Paperclip into priority-based delivery for those transitions. With the key unset, the status-based behavior below is unchanged. The priority mode uses this table regardless of `call_back`:

| Priority | Day | Quiet hours (`notify.quiet_hours` in `notify.timezone`) |
| --- | --- | --- |
| P0 | Call and text | Text |
| P1 | Text | Text |
| P2 | Next scheduled briefing | Next scheduled briefing |

Multica `urgent` and Paperclip `critical` map to P0; `high` maps to P1 for either preset. All other values, including missing or unknown priority, map to P2. P0 also calls for a `blocked` transition by day. Text bypasses quiet-hour deferral in this mode; P2 news is placed in the existing briefing store, so configure `notify.briefing.at` to receive it. Hermes has no priority field, so the key is ignored for that preset with one startup warning. Manual requests such as “have ada call me” still work.

Two deliberate policies ride along:

- **With the default status routing, blocked tasks never auto-ring.** Even with `call_back: true`, a blocked transition only sends the text — and the text names the fix: *"Text 'have ada call me' to talk it through."* Priority mode follows the table above.
- **Unstarted tasks nag until someone owns them.** A task in canonical `todo` with no
  `started_at` past the threshold gets a "nobody's picked this up" reminder,
  repeating with a doubling gap (1h → 2h → 4h cap) until the task starts,
  resolves, or leaves the board.

### Board presets

Keep the config key `notify.kanban`. `preset` accepts `hermes` (the default),
`multica`, or `paperclip`; an unknown preset is a config error. Enabling the
watch always requires an explicit `command`. Cicero supplies no default CLI.
`escalation` accepts only `priority`; omit it for status routing.

| Preset | List command | Optional `task_command` | Verification |
| --- | --- | --- | --- |
| `hermes` | `[hermes, kanban, list, --json]` | `[hermes, kanban, show]` | Live-tested board integration |
| `multica` | `[multica, issue, list, --output, json]` | `[multica, issue, get]` | CLI list normalization live-tested; realtime pending |
| `paperclip` | `[paperclipai, issue, list, --json]` (or `[paperclipai, issue, list, -C, <company-id>, --json]` when an ID is entered) | `[paperclipai, issue, get]` (append `-C, <company-id>` when an ID is entered) | Built from upstream source, not live-tested |

The Paperclip CLI installs as `paperclipai` and needs a company: pass
`-C <company-id>`, or drop it when `PAPERCLIP_COMPANY_ID` or a
`paperclipai context set` profile already supplies one.

Hermes and Paperclip return bare arrays; Multica returns an `issues` array in
an object. Cicero reads the returned list only; it does not fetch additional
pages. Configure a complete board list where the CLI permits it. A parent
omitted by pagination or filtering is treated as satisfied, so a filtered list
can produce a premature reminder.

All presets normalize to `todo | in_progress | review | blocked | done | cancelled`:
Hermes `triage/todo/scheduled/ready` become `todo`, `running` becomes
`in_progress`, and `archived` becomes `cancelled`. Multica/Paperclip `backlog`
becomes `todo` and `in_review` becomes `review`. Multica custom statuses map by
their `status_category`: `unstarted` → `todo`, `started` → `in_progress`,
`done` → `done`, `closed` → `cancelled` (a custom review or blocked status is
indistinguishable from other started work, so it neither announces nor
nudges). Unknown statuses retain
their bounded raw label but never announce or nudge; warnings are deduplicated
with a bounded budget of 128 distinct statuses per process. All task timestamps
are unix seconds internally; ISO timestamps are converted at the list boundary.
A task is unstarted only while `todo` and without a start timestamp, so an
in-progress Multica issue does not get reminders despite lacking `started_at`.

Multica and Paperclip supply assignee ids rather than names. Map these ids to
spoken names (use the exact lane name to get that employee's voice):

```yaml
notify:
  kanban:
    enabled: true
    preset: multica
    command: [multica, issue, list, --output, json]
    task_command: [multica, issue, get]
    assignees:
      board-agent-id: coder
      board-user-id: ada
```

### Optional realtime feeds

Multica and Paperclip can refresh on push events instead of the normal 20-second
poll. Add `realtime` to the existing board config; Hermes remains polling-only:

```yaml
notify:
  kanban:
    preset: multica
    command: [multica, issue, list, --output, json]
    realtime:
      server_url: https://your-multica-server.example
      scope_id: your-workspace-uuid
      token_env: CICERO_BOARD_TOKEN
```

Set the named environment variable to a Multica PAT/JWT. For Paperclip, use
`preset: paperclip`, its list command, the company UUID as `scope_id`, and an
agent API key for that company. The CLI and socket must address the **same board
scope**. Existing CLI credentials are not read or exported by Cicero. The server
URL must be an HTTP(S) origin without credentials, query, or path; use HTTPS for
remote servers. Missing credentials leave polling active and are retried.

Multica connects to `/ws?workspace_id=…`, sends a first-message auth frame,
and waits for `auth_ack`; Paperclip connects to
`/api/companies/{id}/events/ws` with a bearer header. Issue events (Multica) and
company activity events (Paperclip) invalidate the board. Their bodies never
supply task state: a bounded CLI read feeds the existing normalizer and escalation
path. Events are coalesced over 100 ms, including a follow-up read when one
arrives during a read. Duplicate events do not re-announce unchanged statuses.

Every connection, including reconnects, triggers a catch-up read. While connected,
quiet boards reconcile at least every five minutes (or `interval_seconds` if
longer); age-based reminders can consequently be up to that cadence late.
Sockets renew after five minutes to bound silent connections. A failed connection,
auth timeout (10 seconds), or disconnect restores the configured polling cadence
while reconnects back off from 1 to 30 seconds. Shutdown cancels the socket,
retry/deadline timers, pending refreshes and the active CLI read. This is snapshot
reconciliation, not durable event replay: intermediate transitions between CLI
reads can still be missed, just as with polling.

Verification: fake-socket lifecycle tests, a local Bun WebSocket handshake, and
real Multica CLI list normalization (four project issues, including the current
issue in progress).
Real Multica/Paperclip feed verification remains outstanding; the Multica runtime
used for this change permits platform access only through its CLI, which has no
realtime subscription command.

Unmapped ids become an unassigned task; Cicero never speaks the raw id.
Paperclip prefers `assigneeAgentId`, falling back to `assigneeUserId` when no
agent is assigned. Hermes keeps its raw lane-name assignee unless mapped.
Mappings allow at most 256 entries, with non-empty ids and names of at most
128 characters each.

Multica's `parent_issue_id` and Paperclip's `parentId` gate reminders directly
from the list, without a detail command. Hermes falls back to detail `parents`
when `task_command` is configured. Parent ids are capped at 32, each 128
characters. A present unfinished parent suppresses the child's reminder;
`done` and `cancelled` parents satisfy the gate. Detail commands append the id,
then `--output json` for Multica or `--json` for Hermes/Paperclip.

**Deliverable-link lookup is Hermes-only:** it reads `latest_summary` and
`comments[].body` from task detail. Multica and Paperclip detail payloads do not
embed these, so Cicero skips the link lookup without spawning a command.
Announcements still work without a deliverable link.

## Telegram text and voice notes

The same clip can also reach your phone when no browser is open. Make a bot with [@BotFather](https://t.me/botfather), grab your chat id, and add:

```yaml
notify:
  telegram:
    token_env: CICERO_TELEGRAM_TOKEN   # or token: "123:abc" directly
    chat_id: 123456789
    sender_user_id: 123456789          # the only account allowed to issue commands
    voice_note: false                  # default text; true sends OGG/Opus voice notes
```

Every `/api/notify` then also lands as a Telegram text message. Set
`voice_note: true` to send the rendered clip as an OGG/Opus voice note with the
text as its caption. Delivery is fire-and-forget: browsers never wait on
Telegram, and failures only log.

`sender_user_id` protects the two-way command surface independently from the
destination chat. It is **required for a group or supergroup**: matching only a
group's `chat_id` would let every member drive the brain and approve tools. For
an existing one-to-one bot chat, omitting it remains safe and compatible —
Cicero accepts the update only when Telegram marks the chat `private` and the
sender id equals `chat_id`. Add the explicit value when convenient; updates
with missing or mismatched sender metadata always fail closed. On every daemon
start, Cicero also discards updates queued while it was offline so an old
command or approval cannot replay after a restart.

## The bot is a full text surface

The same bot is two-way — texting it is a first-class way to use the office. Messages are matched in priority order:

1. **`log <metric> [value] [unit] [note…]`** — instant append to the local health record (`~/.cicero/health/metrics.jsonl`), no agent turn: `log calories 650 chicken bowl`, `log weight 82.4`. Read it back with the `cicero health recent|trend` CLI, or wire an agent to. The record also takes `POST /api/health` (single row or batch) for phone-automation bridges.
2. **"call me" — or "have ada call me"** — rings your phone via the Telegram-call sidecar. Naming an employee pins that lane first, so *they* answer the call in their own voice, briefed on any of their parked tasks. Phrasings the pattern misses ("get ada on the horn") fall through to a small local intent classifier, so it's the sentiment that counts, not the wording. The same intent works **spoken** on any voice surface (web voice, an ongoing call), with the same classifier fallback — "I want you to call me" rings just like the canonical phrasing. Trailing clauses ("call me when it's done") stay ordinary sentences, and questions about calls ("did you call me?") are answered, never dialed.
3. **Typed `yes`/`no`** while a confirmation gate is pending resolves it (same as the inline ✅/🚫 buttons).
4. **Anything else is a chat turn** against the same brain the voice surfaces reach — reply comes back as text, recorded in the shared history so a later voice session resumes the thread.

## Telegram calls

The fully hands-free tier, verified live: Cicero *rings you* on Telegram (or answers when you ring it), and you talk to the same brain in the same cloned voice on a real call — screen locked, phone in your pocket, **~0.8s per spoken turn** measured end-to-end. Runs as a Python sidecar built on pytgcalls/ntgcalls riding the daemon's streaming WebSocket — replies stream into the call sentence-by-sentence, you can talk over Cicero to interrupt (mid-speech or mid-think) and pivot to a new instruction, and proactive notifications speak into the call between turns.

This is an explicit cloud surface: caller and reply audio traverse Telegram's
call/WebRTC infrastructure. STT/TTS remain local when configured locally, but
the live-call transport does not satisfy the local-audio-only guarantee. The
bridge authenticates to Cicero with a bearer header, verifies TLS by default,
and keeps conversation content out of its logs; transport and escape-hatch
details are in the setup guide.

No extra pipeline — which means the whole office works on a call too: say *"let me talk to the coder"* mid-call and the transfer happens with the voice change, same as in the browser.

Full setup guide (second account, API credentials, login, account hardening, phone migrations): [`sidecars/telegram-call/README.md`](https://github.com/5uck1ess/cicero/blob/main/sidecars/telegram-call/README.md).

## The chief of staff: quiet hours, morning briefing, call minutes

Four `notify:` options turn the office into something that manages the flow of information like a good assistant would:

```yaml
notify:
  timezone: America/New_York                   # IANA zone — quiet_hours and briefing.at are read in THIS zone
  quiet_hours: { from: "23:00", to: "08:00" }  # no pings overnight — news queues up
  briefing:                                      # daily digest: deferred news + board state
    at: "08:00"
    call: true
    catch_up_minutes: 180                        # restart catch-up window; 0 = exact-minute only
  call_minutes: { min_minutes: 3 }             # notes texted after calls longer than 3 minutes
```

- **Timezone** — set it if the box's clock isn't your local time (a UTC server will otherwise happily ring you at 4am). Bad zone names fail loudly at startup.
- **Quiet hours** — notifications inside the window don't ping anything; they queue (persisted across restarts) for the briefing.
- **Morning briefing** — at the set time, the queued news plus the board's blocked/review items arrive as one Telegram text. If Cicero starts late, it catches up within `catch_up_minutes` (default 180); `0` preserves exact-minute-only behavior. A durable daily claim in `~/.cicero/briefing-status.json` prevents restart loops from sending twice. Quiet hours delay the attempt only while the catch-up window remains open. With `call: true`, Cicero also *rings your phone* and reads it to you. Deferred items stay queued unless at least one delivery channel accepts the briefing.
- **Call minutes** — a couple of minutes after a voice conversation goes quiet, the summarizer writes 2-4 lines of notes (what was asked, decided, done) and texts them to your phone. Like leaving a meeting and finding the minutes in your inbox.

## Scheduled prompts: daily briefs the brain writes

The briefing formats data Cicero already has. Scheduled prompts go further: at a set time each day, Cicero runs a prompt you wrote as a real brain turn and texts you the answer.

```yaml
notify:
  schedules:
    - name: content ideas
      at: "09:00"          # HH:MM in notify.timezone
      lane: conductor      # optional — run on a named brain lane instead of the front desk
      prompt: |
        Search the web for what's new in our field today and draft the top 3
        content ideas: title, angle, why now, and source links. Plain text.
```

- The turn runs unattended: no control plane, no lane pinning — a scheduled prompt never moves an ongoing conversation. `lane` targets one of your `brain.lanes` employees (cold-starting it, persona and all); pick one whose agent has web access if the prompt needs research. A misspelled lane fails at startup, not at 9am.
- Replies land as a plain Telegram text (long answers are split; extremes are truncated). Quiet hours hold **delivery**, not the work — the turn still runs on time and the text arrives when the window ends.
- One firing per day per schedule; a failed turn (brain down, timeout after 10 minutes) is logged and waits for tomorrow rather than retrying in a loop.
