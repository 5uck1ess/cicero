"""Security and resource-bound helpers for the Telegram call sidecar.

This module is deliberately standard-library-only so its fail-closed policy can
be exercised in CI without Telegram credentials or the native call runtime.
"""

from __future__ import annotations

import inspect
import ipaddress
import io
import json
import os
import ssl
import stat
import time
import wave
from collections.abc import Callable, Mapping, MutableMapping
from pathlib import Path
from typing import BinaryIO
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener


EXPLICIT_INSECURE_ACK = "I_UNDERSTAND"
MAX_PRIVATE_CONFIG_BYTES = 1024 * 1024
MAX_CALLBACK_BYTES = 16 * 1024
MAX_HTTP_REQUEST_BYTES = 64 * 1024
MAX_WAV_BYTES = 8 * 1024 * 1024
MAX_HTTP_RESPONSE_BYTES = MAX_WAV_BYTES
MAX_AUDIO_DURATION_S = 180.0


def parse_exact_ack(raw: str | None, variable: str) -> bool:
    """Accept an unsafe override only with an exact conspicuous value."""
    value = (raw or "").strip()
    if not value:
        return False
    if value != EXPLICIT_INSECURE_ACK:
        raise ValueError(
            f"{variable} must be unset or exactly {EXPLICIT_INSECURE_ACK!r}"
        )
    return True


def validate_bearer_token(raw: object) -> str:
    """Return a header-safe bearer token or fail before any network request."""
    if not isinstance(raw, str):
        raise ValueError("Cicero web token must be a string")
    token = raw.strip()
    if not token or any(ord(char) < 0x21 or ord(char) > 0x7E for char in token):
        raise ValueError("Cicero web token must be a non-empty printable ASCII token")
    return token


def _owned_by_current_user(path: Path, uid: int) -> None:
    getuid = getattr(os, "getuid", None)
    if getuid is not None and uid != getuid():
        raise PermissionError(f"refusing path not owned by the current user: {path}")


def ensure_private_directory(path: Path) -> None:
    """Create/repair a credential directory and refuse symlink traversal."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        path.mkdir(mode=0o700, parents=True, exist_ok=False)
        info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        raise PermissionError(f"refusing symlink credential directory: {path}")
    if not stat.S_ISDIR(info.st_mode):
        raise PermissionError(f"credential path is not a directory: {path}")
    _owned_by_current_user(path, info.st_uid)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        opened = os.fstat(fd)
        if not stat.S_ISDIR(opened.st_mode) or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise PermissionError(f"credential directory changed while securing it: {path}")
        os.fchmod(fd, 0o700)
    finally:
        os.close(fd)


def secure_private_file(path: Path, *, required: bool = True) -> bool:
    """Require an owner-controlled regular file and repair its mode to 0600."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        if required:
            raise
        return False
    if stat.S_ISLNK(info.st_mode):
        raise PermissionError(f"refusing symlink credential file: {path}")
    if not stat.S_ISREG(info.st_mode):
        raise PermissionError(f"credential path is not a regular file: {path}")
    _owned_by_current_user(path, info.st_uid)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise PermissionError(f"credential file changed while securing it: {path}")
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)
    return True


def secure_session_files(workdir: Path) -> None:
    """Lock down Pyrogram's SQLite session, journal, WAL, and SHM files."""
    ensure_private_directory(workdir)
    for candidate in workdir.glob("cicero.session*"):
        secure_private_file(candidate)


def read_private_text(path: Path, *, max_bytes: int = MAX_PRIVATE_CONFIG_BYTES) -> str:
    """Read a bounded credential file without following a final symlink."""
    secure_private_file(path)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise PermissionError(f"credential path is not a regular file: {path}")
        _owned_by_current_user(path, info.st_uid)
        if info.st_size > max_bytes:
            raise ValueError(f"credential file exceeds {max_bytes} bytes: {path}")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(fd, min(64 * 1024, max_bytes + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ValueError(f"credential file exceeds {max_bytes} bytes: {path}")
            chunks.append(chunk)
        return b"".join(chunks).decode("utf-8")
    finally:
        os.close(fd)


def load_env_file(path: Path, environ: MutableMapping[str, str] | None = None) -> None:
    """Load the sidecar's bounded, owner-only .env file if it exists."""
    try:
        text = read_private_text(path)
    except FileNotFoundError:
        return
    target = os.environ if environ is None else environ
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            target.setdefault(key.strip(), value.strip().strip("'\""))


def _is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def normalize_web_url(raw: str, *, allow_plaintext: bool) -> str:
    """Validate the daemon base URL and reject accidental credential egress."""
    parsed = urlsplit(raw.strip())
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("CICERO_WEB_URL must use http:// or https://")
    if not parsed.hostname:
        raise ValueError("CICERO_WEB_URL must include a host")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("CICERO_WEB_URL must not contain credentials")
    if parsed.query or parsed.fragment:
        raise ValueError("CICERO_WEB_URL must not contain a query string or fragment")
    if parsed.path not in {"", "/"}:
        raise ValueError("CICERO_WEB_URL must be an origin without a path")
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError("CICERO_WEB_URL contains an invalid port") from exc
    if parsed.scheme == "http" and not _is_loopback(parsed.hostname) and not allow_plaintext:
        raise ValueError(
            "non-loopback CICERO_WEB_URL must use HTTPS; to accept plaintext bearer/audio "
            f"egress anyway, set CICERO_WEB_ALLOW_PLAINTEXT={EXPLICIT_INSECURE_ACK}"
        )
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def websocket_url(base_url: str) -> str:
    parsed = urlsplit(base_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return urlunsplit((scheme, parsed.netloc, "/ws", "", ""))


def build_ssl_context(
    base_url: str,
    *,
    ca_file: Path | None,
    default_local_ca: Path,
    insecure_tls: bool,
) -> ssl.SSLContext | None:
    """Build a verified TLS context, trusting Cicero's local cert when present."""
    parsed = urlsplit(base_url)
    if parsed.scheme != "https":
        return None
    if insecure_tls:
        return ssl._create_unverified_context()  # explicit legacy escape hatch
    if ca_file is not None:
        if not ca_file.is_file():
            raise ValueError(f"CICERO_WEB_CA_FILE does not exist: {ca_file}")
        return ssl.create_default_context(cafile=str(ca_file))
    if parsed.hostname and _is_loopback(parsed.hostname) and default_local_ca.is_file():
        return ssl.create_default_context(cafile=str(default_local_ca))
    return ssl.create_default_context()


def websocket_auth_kwargs(
    connect: Callable[..., object],
    token: str,
    *,
    version: str = "",
) -> dict[str, object]:
    """Select websockets' version-specific header option without URL secrets."""
    try:
        parameters = inspect.signature(connect).parameters
    except (TypeError, ValueError):
        parameters = {}
    headers = {"Authorization": f"Bearer {token}"}
    if "additional_headers" in parameters:
        return {"additional_headers": headers}
    if "extra_headers" in parameters:
        return {"extra_headers": headers}
    try:
        major = int(version.split(".", 1)[0])
    except (TypeError, ValueError):
        major = 0
    if major >= 14:
        return {"additional_headers": headers}
    if major == 13:
        return {"extra_headers": headers}
    raise RuntimeError(
        "unsupported websockets client: cannot attach Authorization header safely"
    )


def disable_websocket_redirects(connect: Callable[..., object]) -> None:
    """Limit the handshake to one attempt so bearer headers aren't redirected.

    websockets 13 preserves ``extra_headers`` across cross-origin redirects;
    newer releases strip credentials, but rejecting every redirect keeps one
    contract across the supported 13-16 range. Both implementations interpret
    a limit of one as "initial handshake only".
    """
    configured = False
    if hasattr(connect, "MAX_REDIRECTS_ALLOWED"):
        setattr(connect, "MAX_REDIRECTS_ALLOWED", 1)
        configured = True
    module = inspect.getmodule(connect)
    if module is not None and hasattr(module, "MAX_REDIRECTS"):
        setattr(module, "MAX_REDIRECTS", 1)
        configured = True
    if not configured:
        raise RuntimeError(
            "unsupported websockets client: cannot disable bearer-bearing redirects"
        )


def _set_response_socket_timeout(response: object, timeout: float) -> None:
    current = response
    for attribute in ("fp", "raw", "_sock"):
        current = getattr(current, attribute, None)
        if current is None:
            return
        setter = getattr(current, "settimeout", None)
        if callable(setter):
            setter(timeout)
            return


def read_response_limited(
    response: BinaryIO,
    *,
    max_bytes: int,
    deadline_s: float | None = None,
) -> bytes:
    """Read an HTTP response under hard byte and wall-clock caps."""
    headers = getattr(response, "headers", None)
    raw_length = headers.get("Content-Length") if headers is not None else None
    if raw_length:
        try:
            content_length = int(raw_length)
        except ValueError as exc:
            raise ValueError("invalid HTTP Content-Length") from exc
        if content_length < 0 or content_length > max_bytes:
            raise ValueError(f"HTTP response exceeds {max_bytes} bytes")
    chunks: list[bytes] = []
    total = 0
    deadline = time.monotonic() + deadline_s if deadline_s is not None else None
    reader = getattr(response, "read1", response.read)
    while True:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"HTTP response exceeded {deadline_s:g} seconds")
            _set_response_socket_timeout(response, remaining)
        chunk = reader(min(64 * 1024, max_bytes + 1 - total))
        if deadline is not None and time.monotonic() > deadline:
            raise TimeoutError(f"HTTP response exceeded {deadline_s:g} seconds")
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise ValueError(f"HTTP response exceeds {max_bytes} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


class _NoRedirectHandler(HTTPRedirectHandler):
    """Do not forward the bearer/body to a redirect target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def open_url_no_redirect(
    request: Request,
    *,
    context: ssl.SSLContext | None,
    timeout: float,
):
    """Open one HTTP(S) request and surface redirects as HTTPError."""
    handlers: list[object] = [_NoRedirectHandler()]
    if context is not None:
        handlers.append(HTTPSHandler(context=context))
    opener = build_opener(*handlers)
    return opener.open(request, timeout=timeout)


def decode_pcm16_wav(
    data: bytes,
    *,
    max_bytes: int = MAX_WAV_BYTES,
    max_duration_s: float = MAX_AUDIO_DURATION_S,
) -> tuple[bytes, int, int]:
    """Validate a bounded PCM WAV before callers allocate/resample its samples."""
    if len(data) > max_bytes:
        raise ValueError(f"WAV exceeds {max_bytes} bytes")
    try:
        with wave.open(io.BytesIO(data), "rb") as source:
            rate = source.getframerate()
            channels = source.getnchannels()
            width = source.getsampwidth()
            frames = source.getnframes()
            if source.getcomptype() != "NONE":
                raise ValueError("WAV must be uncompressed PCM")
            if width != 2:
                raise ValueError("WAV must contain signed 16-bit PCM")
            if channels not in (1, 2):
                raise ValueError("WAV must contain one or two channels")
            if rate < 8000 or rate > 192000:
                raise ValueError("WAV sample rate is outside 8-192 kHz")
            if frames / rate > max_duration_s:
                raise ValueError(f"WAV exceeds {max_duration_s:g} seconds")
            expected = frames * channels * width
            if expected > max_bytes:
                raise ValueError(f"WAV PCM exceeds {max_bytes} bytes")
            raw = source.readframes(frames)
    except wave.Error as exc:
        raise ValueError(f"invalid WAV: {exc}") from exc
    if len(raw) != expected:
        raise ValueError("WAV payload is truncated")
    return raw, rate, channels


def consume_callback_reason(path: Path) -> str | None:
    """Consume one bounded callback spool without following a symlink."""
    try:
        text = read_private_text(path, max_bytes=MAX_CALLBACK_BYTES)
    except FileNotFoundError:
        return None
    path.unlink(missing_ok=True)
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return ""
    if not isinstance(payload, dict):
        return ""
    reason = payload.get("reason", "")
    return reason[:4096] if isinstance(reason, str) else ""


def bounded_float(
    environ: Mapping[str, str],
    name: str,
    default: float,
    *,
    minimum: float,
    maximum: float,
) -> float:
    """Parse a finite bounded timeout/tuning value from the environment."""
    raw = environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def redact_secrets(message: object, *secrets: str | None) -> str:
    """Keep bearer/API credentials out of exception logs."""
    rendered = str(message)
    for secret in secrets:
        if secret:
            rendered = rendered.replace(secret, "<redacted>")
    return rendered
