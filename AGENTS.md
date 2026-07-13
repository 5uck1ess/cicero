# Agent guidance

This is the canonical project guidance for every coding agent. Provider-specific
instruction files should import this file instead of copying it.

## Product boundary

Cicero is a self-hosted voice layer for coding agents. Keep the voice,
transport, and lifecycle code independent of a specific brain. A brain is
currently pluggable through the internal TypeScript `Brain` contract, ACP, an
OpenAI-compatible endpoint, or a supported CLI adapter; do not describe the
private package as a stable third-party plugin SDK.

The default deployment is single-operator. Do not accidentally turn shared
brain state, lanes, or transports into a multi-tenant contract.

## Toolchain

- Use the Bun version pinned by `packageManager` in `package.json` and CI.
- Use `bun install`, `bun run <script>`, `bun test`, and `bun x`; do not add a
  second JavaScript package manager or lockfile.
- Bun is the runtime, but existing `node:*` standard-library imports are valid.
- Keep dependencies pinned or bounded consistently with the existing lockfile.
- Do not add `dotenv`; Bun loads environment files itself.

## Verification

- Add focused `bun:test` regressions for behavior changes and run them first.
- Before a PR is ready, run `bun run typecheck`, the full `bun test`, and
  `git diff --check`.
- `tests/brain-claude-code-stream.test.ts` is a live smoke test. It runs only
  with `CICERO_LIVE_TESTS=1`; never make normal CI depend on installed or
  authenticated agent CLIs.
- If Python sidecars change, run their matching `unittest`/native-contract
  checks with the Python and requirements files used by CI.
- Hardware, credentials, acoustic behavior, and real remote providers need a
  labeled smoke test; do not present mocked CI as proof of those conditions.

## Reliability and security invariants

- Every spawned process, timer, stream, socket, and signal handler needs one
  owner and a bounded cleanup path. Do not use process-wide kill patterns.
- Put absolute deadlines and size limits around subprocess, HTTP, and streaming
  work. A timeout must release or quarantine the owned resource before reuse.
- Fail closed when release is unconfirmed, but make stored failure latches
  retryable so recovery does not require a daemon restart.
- Preserve cancellation, one-shot context, and optional capabilities through
  every brain wrapper. Late work from an aborted or superseded turn must not
  publish output into a newer turn.
- Treat config, terminal output, provider bodies, model audio, and transport
  frames as untrusted input. Bound before retaining, parsing, or logging them.
- Never expose API keys, authorization headers, URL credentials, or query tokens
  in runtime errors, the application logger, or dashboard events. The ephemeral
  web credential is intentionally written to startup stdout; remember that a
  supervisor may retain it, and require a stable token for service deployments.
  Never commit real credentials, real voice-reference audio, or real user
  transcripts. Clearly synthetic secret markers are expected in redaction regressions.
- Keep local control surfaces authenticated and private storage symlink-safe.

## Adding or changing adapters

- Keep registry, runtime factory, config schema, `doctor`, `status`, example
  config, and operator docs in sync.
- An explicitly configured unsupported backend is an error, not a silent
  fallback. Remote-host and local-managed modes must be tested separately.
- Use injected clocks, spawners, fetchers, or ports in tests; avoid fixed-port
  races and real network/model dependencies.
- Preserve cross-platform behavior. Resolve POSIX and Windows virtualenv and
  executable layouts explicitly; call out unavoidable OS-specific gaps.

## Documentation and review

- Lead with the actual supported behavior and label opt-in, best-effort,
  platform-specific, and unverified paths honestly.
- Keep PRs focused and preserve unrelated changes in a dirty worktree.
- Do not commit `.DS_Store`, local audio, credentials, generated model assets,
  virtualenvs, or benchmark output ignored by `.gitignore`.
