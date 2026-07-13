# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories —
"Report a vulnerability" under this repository's **Security** tab — rather
than a public issue. Expect an acknowledgement within a week.

## Scope

Cicero is a self-hosted, single-operator voice layer. The threat model,
trust boundaries, and hardening guidance live in
[docs/security.md](../docs/security.md); reports probing the boundaries
documented there (control-surface authentication, token handling, sidecar
transports, prompt-injection paths into the brain) are especially welcome.

## Supported versions

Fixes land on `main`. There are no maintained release branches.
