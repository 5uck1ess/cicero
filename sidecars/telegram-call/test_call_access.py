import unittest

from call_access import (
    ALLOW_ANY_CALLER_SENTINEL,
    incoming_call_allowed,
    parse_allow_any_caller,
    parse_allowed_callers,
    validate_listener_access,
)


class CallAccessTest(unittest.TestCase):
    def test_empty_allowlist_parses_as_empty(self) -> None:
        self.assertEqual(parse_allowed_callers(None), frozenset())
        self.assertEqual(parse_allowed_callers(" ,  "), frozenset())

    def test_allowlist_parses_integer_ids_and_deduplicates(self) -> None:
        self.assertEqual(
            parse_allowed_callers("123, 456,123"),
            frozenset({123, 456}),
        )

    def test_invalid_allowlist_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "comma-separated integer user ids"):
            parse_allowed_callers("123,not-a-user")

    def test_listener_rejects_an_empty_allowlist(self) -> None:
        with self.assertRaisesRegex(ValueError, "--listen requires"):
            validate_listener_access(True, frozenset(), False)

    def test_outgoing_only_mode_does_not_require_an_allowlist(self) -> None:
        validate_listener_access(False, frozenset(), False)

    def test_listener_accepts_an_explicit_allowlist(self) -> None:
        validate_listener_access(True, frozenset({123}), False)
        self.assertTrue(incoming_call_allowed(123, frozenset({123}), False))
        self.assertFalse(incoming_call_allowed(456, frozenset({123}), False))

    def test_exact_allow_any_acknowledgement_opens_incoming_calls(self) -> None:
        allow_any = parse_allow_any_caller(ALLOW_ANY_CALLER_SENTINEL)
        validate_listener_access(True, frozenset(), allow_any)
        self.assertTrue(incoming_call_allowed(456, frozenset(), allow_any))

    def test_missing_or_inexact_allow_any_value_does_not_opt_in(self) -> None:
        self.assertFalse(parse_allow_any_caller(None))
        for value in ("1", "true", "i_understand"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "must be unset or exactly"):
                    parse_allow_any_caller(value)

    def test_empty_policy_rejects_every_incoming_caller(self) -> None:
        self.assertFalse(incoming_call_allowed(123, frozenset(), False))


if __name__ == "__main__":
    unittest.main()
