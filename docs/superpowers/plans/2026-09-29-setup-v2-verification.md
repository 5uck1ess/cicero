# Setup v2 part 1: implementation-time verification

These are the live checks run on the reference Linux box (ryzen-ai) on 2026-09-29, for every spec item marked "verified during implementation". Credential values were never printed. Anything not verified here renders as "unknown" or "unverified" in the wizard.

## Agent login detection

| Provider | Status command | Result | Verdict |
|---|---|---|---|
| Claude | `claude auth status` (Claude Code 2.1.284) | JSON: `loggedIn`, `authMethod` (`claude.ai` / `api_key` / `none`), `apiKeySource` (`ANTHROPIC_API_KEY` when the env key is set). rc=0 in every case, including "not logged in". With a synthetic `ANTHROPIC_API_KEY` it reports `authMethod: "api_key"`, `apiKeySource: "ANTHROPIC_API_KEY"`. With an empty `CLAUDE_CONFIG_DIR` it reports `loggedIn: false`. | **Verified.** Parse only `loggedIn`, `authMethod` and `apiKeySource`. Never read or return the `email` field. The CLI itself reports key-over-login. This also covers the macOS Keychain case, because the command asks the CLI rather than reading files. |
| Codex | `codex login status` (codex-cli 0.158.0) | "Logged in using ChatGPT" / "Not logged in". rc=0 for both. With a synthetic `OPENAI_API_KEY` it still reports "Logged in using ChatGPT". `~/.codex/auth.json` `auth_mode` = `chatgpt`. No `cli_auth_credentials_store`/keyring setting in `config.toml`. | **Partly verified.** Login presence: verified from the status text (known caveat: it reports "logged in" on a dead refresh token, so the label is "login found (not validated)"). Whether `OPENAI_API_KEY` overrides the ChatGPT login at run time: **unknown**, because the status command does not reflect the env key. The Accounts step shows "unknown" for Codex's likely credential when both are present, and does not offer "Use my subscription" for Codex. Keyring storage: **unknown** when `auth.json` is absent but the status says logged in (show "login found via CLI"). |
| Grok | none (grok 1.0.41 has `login`/`logout`, no status subcommand) | `~/.grok/auth.json` present. `~/.grok/README.md:111`: "The API key takes precedence over browser credentials." | **File presence + documented precedence.** Login = `auth.json` present, validity unknown. `XAI_API_KEY` overrides it (documented). |

## ACP adapters for escalation

Each adapter was checked with a JSON-RPC `initialize` only: no session, no model call.

| Entry | Command | initialize | Notes |
|---|---|---|---|
| Hermes | `hermes acp` | ok, protocol 1, hermes-agent 0.21.5 | local harness; cloud use depends on its model |
| Codex | `bunx @agentclientprotocol/codex-acp@2.0.0` | ok, protocol 1 | `@zed-industries/codex-acp` is deprecated in favor of this |
| Claude | `bunx @agentclientprotocol/claude-agent-acp@0.84.0` | ok, protocol 1 | `@zed-industries/claude-code-acp` (the version pinned in today's docs, 0.16.2) is deprecated/renamed but still initializes. The wizard lists the maintained package |
| Grok | `grok agent stdio` | ok, protocol 1 | documented in `~/.grok/README.md` "Agent Mode" |

Session start and prompts stay "unverified until first call", as the spec says.

## Model tags (all HTTP 200 on 2026-09-29)

| Model | Hugging Face (spec pin) | Ollama (QAT tag) | LM Studio |
|---|---|---|---|
| E2B | `google/gemma-4-E2B-it-qat-q4_0-gguf` | `gemma4:e2b-it-qat` | `lmstudio-community/gemma-4-E2B-it-QAT-GGUF` |
| E4B | `google/gemma-4-E4B-it-qat-q4_0-gguf` | `gemma4:e4b-it-qat` | `lmstudio-community/gemma-4-E4B-it-QAT-GGUF` |
| 12B | `google/gemma-4-12B-it-qat-q4_0-gguf` | `gemma4:12b-it-qat` | `lmstudio-community/gemma-4-12B-it-QAT-GGUF` |
| 26B-A4B | `google/gemma-4-26B-A4B-it-qat-q4_0-gguf` | `gemma4:26b-a4b-it-qat` | `lmstudio-community/gemma-4-26B-A4B-it-QAT-GGUF` |
| 31B | `google/gemma-4-31B-it-qat-q4_0-gguf` | `gemma4:31b-it-qat` | `lmstudio-community/gemma-4-31B-it-QAT-GGUF` |

`gemma4:26b-a4b` (without `-it-qat`) is 404. `gemma4:26b` is the A4B MoE at Q4_K_M. The wizard uses the QAT tags so the fit table's artifacts match. Ollama/LM Studio fits stay "estimate" (their default context and cache differ).

## Mermaid on the docs site

`vitepress-plugin-mermaid@2.0.17` (peer `mermaid` 10 || 11, `vitepress` ^1) with `mermaid@11.17.2`, on VitePress 1.6.4. The config is wrapped as `withMermaid(defineConfig(...))`. `bun run docs:build` passes, and `dist/index.html` contains a `class="mermaid"` block for the README diagram. **Verified.**

## GPU per-process attribution (CUDA Test → Memory)

`nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits` returned `1427169, 2892` / `1427385, 3472` / `2594254, 4020` (MiB).
`ss -ltnpH 'sport = :8092'` → `audiocpp_server,pid=1427385`: a direct match, 3.47 GB for Nemotron + Pocket.
`ss -ltnpH 'sport = :8080'` → `llama-swap,pid=2594193`. The GPU PID 2594254 is `llama-server`, whose parent (`/proc/2594254/stat` field 4) is 2594193. That is a match via the parent PID, 3.93 GB for the E4B helper.
PID 1427169 (`python`, 2.8 GB) matches no configured port, so it shows as "other GPU use".
`ss -p` shows PIDs for the user's own processes without root. **Verified** on Linux: match a GPU PID to a listener PID directly or through its parent. Any other case is "other GPU use".
