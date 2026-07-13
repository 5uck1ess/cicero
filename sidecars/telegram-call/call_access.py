"""Fail-closed access policy for the Telegram call sidecar.

This module deliberately has no Telegram or Cicero dependencies so the policy
can be tested without credentials, a daemon, or network access.
"""

ALLOW_ANY_CALLER_SENTINEL = "I_UNDERSTAND"


def parse_allowed_callers(raw: str | None) -> frozenset[int]:
    """Parse CICERO_TG_ALLOWED as a set of Telegram user ids."""
    values = [value.strip() for value in (raw or "").split(",") if value.strip()]
    try:
        return frozenset(int(value) for value in values)
    except ValueError as exc:
        raise ValueError("CICERO_TG_ALLOWED must contain comma-separated integer user ids") from exc


def parse_allow_any_caller(raw: str | None) -> bool:
    """Require an exact, conspicuous acknowledgement for open inbound calls."""
    value = (raw or "").strip()
    if not value:
        return False
    if value != ALLOW_ANY_CALLER_SENTINEL:
        raise ValueError(
            "CICERO_TG_ALLOW_ANY_CALLER must be unset or exactly "
            f"{ALLOW_ANY_CALLER_SENTINEL!r}"
        )
    return True


def validate_listener_access(
    listen: bool,
    allowed: frozenset[int],
    allow_any_caller: bool,
) -> None:
    """Refuse open listener mode unless the operator explicitly opted in."""
    if listen and not allowed and not allow_any_caller:
        raise ValueError(
            "--listen requires a non-empty CICERO_TG_ALLOWED; to intentionally "
            "accept calls from any Telegram user, set "
            f"CICERO_TG_ALLOW_ANY_CALLER={ALLOW_ANY_CALLER_SENTINEL}"
        )


def incoming_call_allowed(
    caller_id: int,
    allowed: frozenset[int],
    allow_any_caller: bool,
) -> bool:
    """Return whether an incoming caller may be answered."""
    return allow_any_caller or caller_id in allowed
