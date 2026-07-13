import io
import os
import ssl
import tempfile
import threading
import time
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request

from call_security import (
    EXPLICIT_INSECURE_ACK,
    bounded_float,
    build_ssl_context,
    consume_callback_reason,
    decode_pcm16_wav,
    disable_websocket_redirects,
    ensure_private_directory,
    load_env_file,
    normalize_web_url,
    open_url_no_redirect,
    parse_exact_ack,
    read_private_text,
    read_response_limited,
    secure_private_file,
    secure_session_files,
    validate_bearer_token,
    websocket_auth_kwargs,
    websocket_url,
)


class _Response(io.BytesIO):
    def __init__(self, payload: bytes, content_length: str | None = None) -> None:
        super().__init__(payload)
        self.headers = {}
        if content_length is not None:
            self.headers["Content-Length"] = content_length


class CallSecurityTest(unittest.TestCase):
    def test_unsafe_overrides_require_exact_acknowledgement(self) -> None:
        self.assertFalse(parse_exact_ack(None, "CICERO_TEST"))
        self.assertFalse(parse_exact_ack("  ", "CICERO_TEST"))
        self.assertTrue(
            parse_exact_ack(EXPLICIT_INSECURE_ACK, "CICERO_TEST")
        )
        for value in ("1", "true", "i_understand"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "must be unset or exactly"):
                    parse_exact_ack(value, "CICERO_TEST")

    def test_bearer_token_must_be_header_safe(self) -> None:
        self.assertEqual(validate_bearer_token("  abc-123._~  "), "abc-123._~")
        for value in (None, "", "has space", "line\nbreak", "non-ascii-é"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    validate_bearer_token(value)

    def test_web_url_rejects_credentials_query_fragment_and_paths(self) -> None:
        bad = (
            "https://user:pass@localhost:8090",
            "https://localhost:8090?token=secret",
            "https://localhost:8090/#token",
            "https://localhost:8090/proxy",
            "ftp://localhost:8090",
        )
        for url in bad:
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    normalize_web_url(url, allow_plaintext=False)

    def test_plaintext_is_loopback_only_without_explicit_override(self) -> None:
        self.assertEqual(
            normalize_web_url("http://127.0.0.1:8090/", allow_plaintext=False),
            "http://127.0.0.1:8090",
        )
        self.assertEqual(
            normalize_web_url("http://[::1]:8090", allow_plaintext=False),
            "http://[::1]:8090",
        )
        with self.assertRaisesRegex(ValueError, "must use HTTPS"):
            normalize_web_url("http://192.168.1.8:8090", allow_plaintext=False)
        self.assertEqual(
            normalize_web_url("http://192.168.1.8:8090", allow_plaintext=True),
            "http://192.168.1.8:8090",
        )

    def test_websocket_url_never_contains_the_bearer_token(self) -> None:
        self.assertEqual(
            websocket_url("https://127.0.0.1:8090"),
            "wss://127.0.0.1:8090/ws",
        )
        self.assertNotIn("token", websocket_url("http://localhost:8090"))

    def test_websocket_auth_supports_new_and_legacy_header_parameters(self) -> None:
        def modern(uri: str, *, additional_headers: object = None) -> None:
            pass

        def legacy(uri: str, *, extra_headers: object = None) -> None:
            pass

        expected = {"Authorization": "Bearer secret"}
        self.assertEqual(
            websocket_auth_kwargs(modern, "secret"),
            {"additional_headers": expected},
        )
        self.assertEqual(
            websocket_auth_kwargs(legacy, "secret"),
            {"extra_headers": expected},
        )

    def test_websocket_auth_fails_instead_of_falling_back_to_query_auth(self) -> None:
        def unknown(uri: str) -> None:
            pass

        with self.assertRaisesRegex(RuntimeError, "Authorization header"):
            websocket_auth_kwargs(unknown, "secret")
        self.assertEqual(
            websocket_auth_kwargs(unknown, "secret", version="14.2"),
            {"additional_headers": {"Authorization": "Bearer secret"}},
        )

    def test_websocket_redirects_are_disabled_or_fail_closed(self) -> None:
        class LegacyConnect:
            MAX_REDIRECTS_ALLOWED = 10

            def __call__(self, uri: str) -> None:
                pass

        legacy = LegacyConnect()
        disable_websocket_redirects(legacy)
        self.assertEqual(legacy.MAX_REDIRECTS_ALLOWED, 1)

        def unknown(uri: str) -> None:
            pass

        with self.assertRaisesRegex(RuntimeError, "disable bearer-bearing redirects"):
            disable_websocket_redirects(unknown)

    def test_tls_verification_is_default_and_insecure_mode_is_explicit(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            missing = Path(raw) / "missing.pem"
            verified = build_ssl_context(
                "https://127.0.0.1:8090",
                ca_file=None,
                default_local_ca=missing,
                insecure_tls=False,
            )
            self.assertIsNotNone(verified)
            self.assertEqual(verified.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(verified.check_hostname)
            insecure = build_ssl_context(
                "https://127.0.0.1:8090",
                ca_file=None,
                default_local_ca=missing,
                insecure_tls=True,
            )
            self.assertEqual(insecure.verify_mode, ssl.CERT_NONE)
            self.assertFalse(insecure.check_hostname)

    def test_plain_http_uses_no_ssl_context(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            self.assertIsNone(
                build_ssl_context(
                    "http://127.0.0.1:8090",
                    ca_file=None,
                    default_local_ca=Path(raw) / "missing.pem",
                    insecure_tls=False,
                )
            )

    def test_private_paths_are_repaired_and_symlinks_refused(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            private = root / "private"
            ensure_private_directory(private)
            self.assertEqual(private.stat().st_mode & 0o777, 0o700)
            secret = private / "secret"
            secret.write_text("value")
            os.chmod(secret, 0o644)
            secure_private_file(secret)
            self.assertEqual(secret.stat().st_mode & 0o777, 0o600)
            link = private / "linked"
            link.symlink_to(secret)
            with self.assertRaisesRegex(PermissionError, "symlink"):
                secure_private_file(link)

    def test_session_database_sidecars_are_owner_only(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            workdir = Path(raw) / "telegram-call"
            workdir.mkdir()
            for name in ("cicero.session", "cicero.session-wal", "cicero.session-shm"):
                path = workdir / name
                path.write_bytes(b"sqlite")
                os.chmod(path, 0o666)
            secure_session_files(workdir)
            self.assertEqual(workdir.stat().st_mode & 0o777, 0o700)
            for path in workdir.glob("cicero.session*"):
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_private_file_reads_are_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "config"
            path.write_text("abcdef")
            self.assertEqual(read_private_text(path, max_bytes=6), "abcdef")
            with self.assertRaisesRegex(ValueError, "exceeds 5 bytes"):
                read_private_text(path, max_bytes=5)

    def test_env_loader_does_not_overwrite_explicit_environment(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / ".env"
            path.write_text("ONE=file\nTWO='second'\n")
            values = {"ONE": "environment"}
            load_env_file(path, values)
            self.assertEqual(values, {"ONE": "environment", "TWO": "second"})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_http_response_rejects_declared_and_streamed_oversize(self) -> None:
        self.assertEqual(
            read_response_limited(_Response(b"okay", "4"), max_bytes=4),
            b"okay",
        )
        with self.assertRaisesRegex(ValueError, "exceeds 4 bytes"):
            read_response_limited(_Response(b"hello", "5"), max_bytes=4)
        with self.assertRaisesRegex(ValueError, "exceeds 4 bytes"):
            read_response_limited(_Response(b"hello"), max_bytes=4)

    def test_http_response_enforces_a_wall_clock_deadline(self) -> None:
        class SlowResponse(_Response):
            def read(self, size: int = -1) -> bytes:
                time.sleep(0.02)
                return super().read(size)

            def read1(self, size: int = -1) -> bytes:
                return self.read(size)

        with self.assertRaisesRegex(TimeoutError, "exceeded"):
            read_response_limited(
                SlowResponse(b"okay"),
                max_bytes=4,
                deadline_s=0.001,
            )

    def test_http_redirect_does_not_forward_bearer_or_body(self) -> None:
        sink_requests: list[str | None] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                if self.path == "/redirect":
                    self.send_response(307)
                    self.send_header("Location", "/sink")
                    self.end_headers()
                    return
                sink_requests.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.end_headers()

            def log_message(self, format: str, *args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            request = Request(
                f"http://127.0.0.1:{server.server_port}/redirect",
                data=b"private audio",
                headers={"Authorization": "Bearer secret"},
                method="POST",
            )
            with self.assertRaises(HTTPError) as caught:
                open_url_no_redirect(request, context=None, timeout=2)
            self.assertEqual(caught.exception.code, 307)
            caught.exception.close()
            self.assertEqual(sink_requests, [])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_wav_decoder_accepts_bounded_pcm16_and_rejects_bad_shapes(self) -> None:
        def make_wav(*, width: int = 2, rate: int = 16000, frames: int = 4) -> bytes:
            output = io.BytesIO()
            with wave.open(output, "wb") as target:
                target.setnchannels(1)
                target.setsampwidth(width)
                target.setframerate(rate)
                target.writeframes(b"\0" * width * frames)
            return output.getvalue()

        raw, rate, channels = decode_pcm16_wav(make_wav())
        self.assertEqual((len(raw), rate, channels), (8, 16000, 1))
        with self.assertRaisesRegex(ValueError, "16-bit PCM"):
            decode_pcm16_wav(make_wav(width=1))
        with self.assertRaisesRegex(ValueError, "seconds"):
            decode_pcm16_wav(make_wav(rate=8000, frames=16), max_duration_s=0.001)
        with self.assertRaisesRegex(ValueError, "invalid WAV"):
            decode_pcm16_wav(b"not a wave file")

    def test_callback_spool_is_bounded_private_and_consumed_once(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            spool = Path(raw) / "callback.request"
            spool.write_text('{"reason":"task finished"}')
            self.assertEqual(consume_callback_reason(spool), "task finished")
            self.assertFalse(spool.exists())
            self.assertIsNone(consume_callback_reason(spool))

    def test_callback_spool_refuses_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            target = root / "target"
            target.write_text('{"reason":"do not consume"}')
            spool = root / "callback.request"
            spool.symlink_to(target)
            with self.assertRaisesRegex(PermissionError, "symlink"):
                consume_callback_reason(spool)
            self.assertTrue(target.exists())

    def test_timeout_values_are_numeric_finite_and_bounded(self) -> None:
        self.assertEqual(
            bounded_float({}, "TIMEOUT", 30, minimum=1, maximum=60),
            30,
        )
        self.assertEqual(
            bounded_float({"TIMEOUT": "12.5"}, "TIMEOUT", 30, minimum=1, maximum=60),
            12.5,
        )
        for value in ("nope", "0", "61", "nan", "inf"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    bounded_float({"TIMEOUT": value}, "TIMEOUT", 30, minimum=1, maximum=60)


if __name__ == "__main__":
    unittest.main()
