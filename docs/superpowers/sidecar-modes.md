# Cicero Sidecar Modes

Cicero has two modes:

- **Daemon mode** (`cicero start`) — full voice loop: mic in → STT → router → brain dispatch → summarized TTS.
- **Sidecar mode** — Cicero listens for responses from a coding agent you're already using, summarizes them, and speaks them. Input is whatever the agent provides (Claude Code `/voice`, Codex, etc.).

This doc covers sidecar mode. For daemon mode, see the main README.

## Pick an adapter

| Adapter | When to use | Setup |
|---|---|---|
| **native hook receiver** | You use Claude Code or Codex CLI. | Install with `cicero hook install claude-code` and/or `cicero hook install codex`. |
| **`terminal-scrape`** | You use an agent without a native completion hook (Gemini CLI, Ollama, etc.). | Start `cicero scrape <tab>` pointing at the agent's tab. |

## Claude Code hook

```bash
# One-time: install the Stop hook into ~/.claude/settings.json
cicero hook install claude-code

# Each time you want sidecar mode: run the receiver
cicero hook
```

The installer adds a `Stop` hook entry that POSTs the response to `http://localhost:8084/speak`. It also creates a private credential at `~/.cicero/hook-token` and puts the matching bearer header in Claude Code's user settings. The receiver (`cicero hook`) rejects requests without that credential, summarizes accepted responses, and speaks them via TTS. Before changing an existing settings file, the installer writes a private timestamped `.cicero-bak` copy. Re-running it is idempotent — already-current content is not rewritten, so repeat installs do not accumulate backups. Delete `hook-token`, rerun the installer, and restart the receiver to rotate the credential.

## Codex hook

```bash
# One-time: install the Stop hook into ~/.codex/hooks.json
cicero hook install codex

# Review and trust the new command hook inside Codex
/hooks

# Run the same authenticated receiver used by Claude Code
cicero hook
```

Codex supports command hooks rather than HTTP hooks. Cicero installs a five-second `Stop` command that forwards Codex's bounded `last_assistant_message` field to the same authenticated loopback receiver, then exits immediately; synthesis stays in the receiver process. The hook is best-effort, so a stopped receiver never fails the Codex turn. The installer uses the same change-only backup behavior as the Claude Code path, preserves unrelated hooks, and replaces only Cicero's previous entry.

## Terminal scrape

For agents without a native hook system.

```bash
# Start your agent in a known terminal tab/window
kitty @ launch --type=tab --tab-title=codex   # for example
codex

# In another terminal, point Cicero at it
cicero scrape codex
```

Cicero polls the target tab's content, detects when the agent finishes a response (prompt return + quiet period), summarizes, and speaks.

## Config

Override defaults in `~/.cicero/config.yaml`:

```yaml
sidecar:
  backend: claude-code-hook
  port: 8084
```

Or for terminal-scrape:

```yaml
sidecar:
  backend: terminal-scrape
  targetTab: "codex"
  pollIntervalMs: 500
  quietWindowMs: 1500
  promptMarker: "^> $"   # regex for what a fresh prompt looks like
```

If no `sidecar` block is set, `cicero hook` defaults to `claude-code-hook` on port 8084, and `cicero scrape <tab>` defaults to `terminal-scrape` with a 500ms poll and 1500ms quiet window.

## Caveats

- **Sidecar starts only its speech dependencies** (LLM summarizer and TTS). It does not construct, warm, or hold an unused STT engine.
- **Terminal-scrape boundary detection is heuristic.** If responses aren't being detected, tweak `promptMarker` and `quietWindowMs` in your config.
- **Claude Code uses its native HTTP hook** (`type: "http"`). Codex uses its native command hook and the `last_assistant_message` Stop field. The receiver accepts either path without parsing agent transcript files.
- **The receiver is loopback-only and authenticated.** It rejects browser-origin requests, non-JSON bodies, oversized or slow uploads, and bursts beyond its bounded serial speech queue. Do not replace its URL with a LAN address; sidecar mode is intentionally same-machine only.
- **Sidecar runs on the same machine as the agent today.** Multi-device ("speak the response on a different device than the agent runs on") requires a future transport — not in v1.
