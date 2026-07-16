# Choosing a brain

Cicero's "brain" is the agent that handles complex requests. Seven integration
families are supported, with additional named presets for compatible APIs:

| Backend | What it is | Default binary | Setup |
|---|---|---|---|
| `acp` | **Any [ACP](https://agentclientprotocol.com)-speaking agent harness** — the modular slot. Reference driver: [hermes](https://hermes-agent.nousresearch.com); anything that speaks ACP over stdio drops in via `binary` + `binary_args` (verified matrix below) | configurable | e.g. `brain: { backend: acp, binary: hermes, binary_args: [-p, voice, acp] }` |
| `claude-code` (default) | Claude Code CLI in print mode | `claude` | `npm i -g @anthropic-ai/claude-code` + auth |
| `codex` | OpenAI Codex CLI | `codex` | Install and authenticate the Codex CLI |
| `gemini` | Google Gemini CLI | `gemini` | Install Gemini CLI + auth |
| `qwen` | Qwen CLI (Alibaba) | `qwen` | Install Qwen Code / Qwen Agent CLI |
| `ollama` | Local Ollama model via HTTP | n/a (in-process via fetch) | `ollama serve` + `ollama pull qwen3.5:0.8b` |
| `openai-compatible` | Any OpenAI chat API — OpenRouter, a local server, or a LAN model server | n/a (in-process via fetch) | set `base_url` + `model` (+ key if the server needs one) |

**Agentic vs answer-only:** the CLI brains (`claude-code`, `codex`, `gemini`, `qwen`) are *agents* — they run commands and edit files. `ollama` and `openai-compatible` *answer with a model* — no tool use. Pick a CLI agent when a turn must take actions; pick a model brain for fast local/cloud answers.

## Verified ACP harnesses

Same `AcpBrain`, smoke-tested: handshake → streamed reply.

| Harness | Config | Status |
|---|---|---|
| Hermes | `binary: hermes, binary_args: [-p, voice, acp]` | ✅ production driver (handshake ~1.6s) |
| Claude Code | `binary: bun, binary_args: [x, "@zed-industries/claude-code-acp@0.16.2"]` | ✅ verified via the pinned Zed adapter (Claude Code CLI installed + authed; add `unset_env: [CLAUDECODE]` if the daemon itself runs inside a Claude Code session) |
| Gemini CLI | `binary: gemini, binary_args: [--acp]` | ✅ protocol-compatible — handshake works, needs `GEMINI_API_KEY` in the daemon's env |
| OpenClaw | `binary: openclaw, binary_args: [acp]` | untested here — native ACP mode documented upstream |

Codex CLI has no ACP mode (Cicero drives it via the dedicated `codex` backend instead). NVIDIA NemoClaw is a sandbox/runtime *around* agents — point `binary`/`binary_args` at the harness command it exposes and Cicero neither knows nor cares about the sandbox.

ACP sessions are persistent but bounded. `max_queue_bytes` (default 256 KiB)
limits unread UTF-8 text when a streaming consumer pauses; overflow cancels the
protocol turn and fails it. `max_response_bytes` (default 2 MiB) limits the
non-streaming `send()` convenience path. An actively consumed `sendStream()`
remains incremental and does not accumulate a whole response. The session also
admits at most `max_pending_turns` active plus queued callers (default 32), so a
stalled agent cannot accumulate an unbounded waiter list.
Inbound ACP JSON-RPC is framed before protocol decoding; a newline-free or
single-line frame over 1 MiB closes the owned session instead of growing an
unbounded parser buffer. Invalid UTF-8 and repeated malformed records also close
the session. At most 32 agent-to-client requests may be in flight; each credit
returns only after its response reaches the output transport, which propagates
backpressure when an agent floods requests or stops reading responses.

On POSIX, Cicero launches each ACP harness in an owned process group. Stop and
restart send ACP cancellation, then TERM→KILL the group and wait for both the
leader and descendants to disappear. On Windows, Cicero attempts bounded
`taskkill /T` tree cleanup and reaps the direct ACP child. Without a Windows Job
Object it cannot guarantee ownership of escaped or reparented descendants, so
Windows harnesses must still shut down their own children when the launcher
exits.

## Spoken confirmation gate (acp backend)

`auto_approve_tools: true` plus a voice interface is unguarded power — so guard the sharp edges. Tool-permission requests matching any `confirm_tools` pattern are denied fail-closed; the agent tells you what it wanted, you say *"yes"*, and its retry goes through (one approval authorizes exactly one call, within 60 seconds):

```yaml
brain:
  backend: acp
  auto_approve_tools: true
  confirm_tools: ["git push", "rm -rf", "sudo ", "force", "deploy"]
```

Scope caveat: the gate sees only what the agent *surfaces* as an ACP permission request. Hermes asks for commands its safety layer classifies dangerous (`rm -rf` is gated; a plain `git push` runs without asking); harnesses that request permission for every tool call (e.g. Claude Code's ACP adapter) get the gate on everything. It's a second layer on the agent's own approval flow, not a shell interceptor.

## Model brains — local, LAN, and cloud

`openai-compatible` reuses the same provider as the `llm:` tier (streams, treats a private-LAN host as keyless), so the brain can be OpenRouter, any local server, or a LAN model:

```yaml
# Conversational brain = raw completions from a LAN model server (no agent loop)
llm: { backend: openai-compatible, baseUrl: http://192.168.1.50:8080/v1, model: gemma4 }

# OpenRouter
brain: { backend: openrouter, model: z-ai/glm-4.6, api_key_env: OPENROUTER_API_KEY, timeout_ms: 120000 }

# LAN coding model (fully local, no key)
brain: { backend: openai-compatible, base_url: http://192.168.1.50:8080/v1, model: qwen3-coder, timeout_ms: 120000 }
```

No API key is needed for a private-LAN address (`10.x`, `172.16–31.x`, `192.168.x`, or a `*.local` host) — same as `localhost`. If the server *does* enforce auth, use `llm.apiKey` / `llm.apiKeyEnv` in the LLM block, or `brain.api_key` / `brain.api_key_env` in the brain block. Streaming is supported, so replies start speaking as the first tokens arrive.

For cloud APIs, pick a preset by name; the API key comes from the matching env var:

```yaml
llm: { backend: openai,    model: gpt-4o-mini }     # OPENAI_API_KEY
llm: { backend: openrouter, model: ... }            # OPENROUTER_API_KEY
llm: { backend: deepseek,  model: deepseek-chat }   # DEEPSEEK_API_KEY
llm: { backend: dashscope, model: qwen-max }        # DASHSCOPE_API_KEY  (Qwen / Alibaba)
llm: { backend: moonshot,  model: kimi-k2 }         # MOONSHOT_API_KEY   (Kimi)
llm: { backend: zhipu,     model: glm-4 }           # ZHIPUAI_API_KEY    (GLM)
```

Presets: `openai`, `openrouter`, `groq`, `together`, `deepseek`, `dashscope` / `qwen-api`, `moonshot` / `kimi`, `zhipu` / `glm`, `minimax`. For anything else (another cloud, a local vLLM, …) use `openai-compatible` with an explicit URL:

```yaml
llm: { backend: openai-compatible, baseUrl: https://host/v1, model: ..., apiKeyEnv: MY_KEY }
```

Responses cap at `max_tokens` (default 1024). HTTP brain turns also have an absolute `timeout_ms` deadline (default 120000), which remains active through streamed-body consumption and composes with caller cancellation. The CLI brains and the model brains all stream their output sentence-by-sentence into TTS. Tab-inject mode (`mode: tab-inject`) is **claude-code only** — it needs an interactive Claude Code session in a terminal tab; every other brain runs `subprocess` (a fresh process per turn) or HTTP. The dedicated tab starts Claude in classifier-backed `--permission-mode auto` by default, so routine work remains hands-free while risky actions can stop for approval. Setting `auto_approve_tools: true` explicitly opts into `--dangerously-skip-permissions` instead.

The conversational streaming `local-llm` path adds its own 30-second hard race
around the configured provider, so even a custom in-process adapter that ignores
`AbortSignal` cannot hold the voice floor forever. Ordinary provider completions
use `llm.timeout_ms` (120 seconds by default). Before sentence streaming and
TTS, Cicero removes `<think>…</think>` reasoning blocks, including tags split
across token chunks and an unfinished trailing reasoning block. Managed-server
startup has separate readiness budgets: 30 seconds for Ollama and 60 seconds
for local MLX/llama.cpp servers.

## Context and session contract

Every brain sees the same two context layers:

- `injectContext()` attaches bounded, one-shot operational context to the next real brain turn. Lexical control replies may defer it, but it is never silently replayed on every later turn or copied into an idle lane.
- Stateful adapters (ACP, tab-inject, and resumed Codex lanes) keep their conversation in the underlying agent session. Stateless CLI and HTTP adapters retain a bounded transcript of completed turns and send it with the next request.

`restart()` clears both pending injected context and Cicero-managed transcript memory. Fallback tiers receive the same one-shot context only while retrying that turn, and the escalation/switchboard wrappers deliver it only to the brain that actually receives the request. This is the compatibility contract custom `Brain` adapters should preserve.

Tab-inject's response deadline is a hard failure boundary: if Claude Code does not return to a stable idle prompt within two minutes, Cicero throws a timeout instead of returning terminal text that may be a partial answer. It then sends a bounded Escape and verifies stable idle before accepting another turn; if that verification is uncertain, the tab is quarantined until recovery is confirmed.

Cancellation follows the adapter boundary. Fresh subprocess-mode CLI turns are
spawned as process groups on POSIX; an abort sends `SIGTERM`, waits briefly,
then escalates to `SIGKILL` and reaps the leader. Windows attempts bounded
`taskkill /T` tree cleanup, but without Job Objects it cannot guarantee ownership
of every escaped or reparented descendant. ACP turns receive the caller's signal, issue protocol
cancellation, return the interrupted consumer promptly, and keep the session
lock closed until cancellation settles or the session is restarted fail-closed.

## Progress narration

When an agent can stream structured events — **`codex`** (`exec --json`) and **`claude-code`** (`--output-format stream-json`) — Cicero speaks a running summary of what it's *doing*: its plan, the commands it runs ("Running ls.", "Editing auth.ts."), and the final answer — so you hear it work, not just the end result. On by default; disable with `brain: { narrate_progress: false }`. Brains without event streaming fall back to speaking their answer.

For an agent to actually *run* tools (not just answer), pass its autonomy flag via `binary_args` — e.g. `binary_args: ["-s", "workspace-write"]` (codex) or `binary_args: ["--dangerously-skip-permissions"]` (claude-code).

**claude-code auth:** `claude` prefers `ANTHROPIC_API_KEY` from the environment over your logged-in (OAuth/subscription) session — a stale key there makes it exit 1 with "Invalid API key". Force the OAuth login with `brain: { unset_env: ["ANTHROPIC_API_KEY"] }`.

## Bring your own harness

Your agent isn't in the table above? There are three tiers of "adding support," from zero-code to a small adapter — pick the cheapest one that fits:

1. **No code — OpenAI-compatible endpoint.** If your harness (or just a model server) answers `/v1/chat/completions`, it's one config line: `brain: { backend: openai-compatible, base_url: http://..., model: ... }`. Full voice loop, today.

2. **The recommended path — speak [ACP](https://agentclientprotocol.com).** ACP is an open standard (JSON-RPC over stdio) implementable in any language in an afternoon. The moment your harness speaks it, *everything* in Cicero lights up with zero changes here: lanes and transfers, personas, handoff briefings, voicemail, standups, session resume — they all ride the same two primitives (send a turn, inject context). Point `binary`/`binary_args` at your agent and you're done.

3. **A custom driver — for CLIs that speak neither.** The `Brain` interface in [`src/types.ts`](../src/types.ts) has six required methods (`start`, `stop`, `send`, `injectContext`, `restart`, `health`) plus optional hooks for streaming (`sendStream`), progress, terminal, and lane capabilities. The [Codex driver](../src/brain/codex.ts) is the worked example — it wraps a CLI with no ACP mode, sessions included. Copy the pattern, open a PR.

The periphery is even looser: the kanban watch runs **any command that prints a JSON array** of `{id, title, status, assignee?}`; TTS/STT engines are anything with an OpenAI-style HTTP surface; transfer phrasings and quick intents are pure YAML. Cicero owns the voice — your agent owns the doing.
