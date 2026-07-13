"""Shared admission, output, cache, and concurrency limits for ML sidecars.

This module intentionally depends only on the Python standard library.  The
model servers live in mutually incompatible virtual environments, so safety
checks must not pull one sidecar's native dependency graph into another.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import math
import os
import re
import stat
import struct
import sys
import tempfile
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, BinaryIO, Callable, Generic, Iterator, Mapping, ParamSpec, TypeVar
from urllib.parse import urlsplit


# These mirror the TypeScript web-voice/provider boundaries.
MAX_AUDIO_UPLOAD_BYTES = 4 * 1024 * 1024
MAX_AUDIO_DURATION_MS = 120_000
MAX_TRANSCRIPT_CHARS = 16_384
MAX_TRANSCRIPT_SEGMENTS = 4_096
MAX_TTS_TEXT_CHARS = 16_384
MAX_TTS_JSON_BYTES = 64 * 1024
# Cicero serializes a Float32Array through ECMAScript JSON.stringify.  A finite
# binary32 value in [-1, 1] needs at most 25 UTF-8 bytes in that canonical JSON
# representation; one extra byte covers its array delimiter.  The 64 KiB fixed
# envelope covers field names plus the bounded model id.  This preserves every
# canonical eight-second/96 kHz request, including subnormal worst cases, while
# retaining an exact finite admission ceiling.
MIN_TURN_SAMPLE_RATE = 8_000
MAX_TURN_SAMPLE_RATE = 96_000
MAX_TURN_WINDOW_SECONDS = 8
MAX_CANONICAL_JSON_FLOAT32_BYTES = 25
MAX_TURN_JSON_ENVELOPE_BYTES = 64 * 1024
MAX_TURN_MODEL_CHARS = 4_096
MAX_TURN_JSON_BYTES = (
    MAX_TURN_SAMPLE_RATE
    * MAX_TURN_WINDOW_SECONDS
    * (MAX_CANONICAL_JSON_FLOAT32_BYTES + 1)
    + MAX_TURN_JSON_ENVELOPE_BYTES
)
MAX_OUTPUT_AUDIO_BYTES = 64 * 1024 * 1024
MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024
MAX_MULTIPART_BODY_BYTES = MAX_AUDIO_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES
MAX_PROMPT_CHARS = 4_096
MAX_VOICE_ID_CHARS = 128
MAX_VOICE_PATH_CHARS = 1_024
MAX_POCKET_VOICE_STATES = 16
MAX_POCKET_REFERENCE_BYTES = 32 * 1024 * 1024
MAX_POCKET_REFERENCE_DURATION_MS = 30_000
MAX_SER_LABELS = 64
MAX_SER_LABEL_CHARS = 128
MAX_ACTIVE_SIDECAR_REQUESTS = 4
BODY_READ_TIMEOUT_SECONDS = 5.0
MIN_SPEECH_SPEED = 0.5
MAX_SPEECH_SPEED = 2.0
READ_CHUNK_BYTES = 64 * 1024
WAV_HEADER_RESERVE_BYTES = 4 * 1024
MAX_WAV_CHUNKS = 1_024
DEFAULT_MODEL_INFERENCE_TIMEOUT_SECONDS = 120.0
STT_MODEL_INFERENCE_TIMEOUT_SECONDS = 85.0
TTS_MODEL_INFERENCE_TIMEOUT_SECONDS = 55.0
TURN_MODEL_INFERENCE_TIMEOUT_SECONDS = 8.0
SER_MODEL_INFERENCE_TIMEOUT_SECONDS = 4.0
MODEL_RESTART_GRACE_SECONDS = 0.5
MODEL_RESTART_EXIT_CODE = 70


class AdmissionError(ValueError):
    """A request is well-formed enough to reject with a stable client error."""

    status_code = 400


class PayloadTooLargeError(AdmissionError):
    status_code = 413


class BodyReadTimeoutError(AdmissionError):
    status_code = 408


class AudioOutputTooLargeError(RuntimeError):
    """Synthesis crossed Cicero's provider response ceiling."""

    status_code = 413


class ModelGateError(RuntimeError):
    """A model request could not safely enter or finish native inference."""

    status_code = 503


class ModelBusyError(ModelGateError):
    """The single native runtime is already serving its bounded capacity."""

    status_code = 429


class ModelUnavailableError(ModelGateError):
    """A previous native timeout made this process unsafe to reuse."""


class ModelInferenceTimeoutError(ModelUnavailableError):
    """Native inference crossed its deadline and requires a process restart."""


@dataclass(frozen=True)
class WavMetadata:
    duration_ms: float
    sample_rate: int
    channels: int
    bits_per_sample: int
    data_bytes: int


def _declared_content_length(headers: Any) -> int | None:
    raw = headers.get("content-length") if hasattr(headers, "get") else None
    if raw is None and hasattr(headers, "get"):
        raw = headers.get(b"content-length")
    if raw is None:
        return None
    try:
        text = raw.decode("ascii") if isinstance(raw, bytes) else str(raw)
    except (UnicodeDecodeError, ValueError):
        return None
    if not text.isdigit():
        return None
    value = int(text)
    return value if value >= 0 else None


async def read_request_body_limited(request: Any, max_bytes: int) -> bytes:
    """Incrementally read a Starlette-like Request under an absolute byte cap."""
    if max_bytes < 0:
        raise ValueError("max_bytes must be non-negative")
    declared = _declared_content_length(request.headers)
    if declared is not None and declared > max_bytes:
        raise PayloadTooLargeError(f"request body exceeds {max_bytes} bytes")

    output = bytearray()
    async for chunk in request.stream():
        if not chunk:
            continue
        if len(output) + len(chunk) > max_bytes:
            raise PayloadTooLargeError(f"request body exceeds {max_bytes} bytes")
        output.extend(chunk)
    return bytes(output)


async def read_json_body_limited(request: Any, max_bytes: int) -> Any:
    body = await read_request_body_limited(request, max_bytes)

    def decode() -> Any:
        return json.loads(body.decode("utf-8"))

    try:
        return await asyncio.to_thread(decode)
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise AdmissionError("invalid JSON body") from err


async def copy_upload_to_file_limited(upload: Any, output: BinaryIO, max_bytes: int) -> int:
    """Copy an async UploadFile-like object without an unbounded read()."""
    if max_bytes < 0:
        raise ValueError("max_bytes must be non-negative")
    total = 0
    while True:
        chunk = await upload.read(READ_CHUNK_BYTES)
        if not chunk:
            return total
        total += len(chunk)
        if total > max_bytes:
            raise PayloadTooLargeError(f"audio upload exceeds {max_bytes} bytes")
        output.write(chunk)


def read_file_limited(source: BinaryIO, max_bytes: int) -> bytes:
    """Read a sync file object incrementally, rejecting the first excess chunk."""
    if max_bytes < 0:
        raise ValueError("max_bytes must be non-negative")
    output = bytearray()
    while True:
        chunk = source.read(READ_CHUNK_BYTES)
        if not chunk:
            return bytes(output)
        if len(output) + len(chunk) > max_bytes:
            raise PayloadTooLargeError(f"audio upload exceeds {max_bytes} bytes")
        output.extend(chunk)


def validate_pcm_wav(source: BinaryIO) -> WavMetadata:
    """Validate one canonical, bounded, uncompressed WAV without decoding it.

    The complete declared RIFF is walked even after the required chunks are
    found.  That is important when the validated bytes are later handed to a
    different decoder: accepting a tiny first ``data`` chunk and ignoring a
    hidden second one would let the decoder observe far more audio than this
    admission boundary measured.
    """
    original = source.tell()
    try:
        source.seek(0, io.SEEK_END)
        total_bytes = source.tell()
        source.seek(0)
        header = source.read(12)
        if len(header) != 12 or header[:4] != b"RIFF" or header[8:] != b"WAVE":
            raise AdmissionError("audio must be an uncompressed PCM WAV")
        if struct.unpack_from("<I", header, 4)[0] + 8 != total_bytes:
            raise AdmissionError("WAV length header does not match the upload")
        fmt: tuple[int, int, int, int, int, int] | None = None
        data_bytes: int | None = None
        data_offset: int | None = None
        chunk_count = 0
        offset = 12
        while offset < total_bytes:
            if offset + 8 > total_bytes:
                raise AdmissionError("WAV ends inside a trailing chunk header")
            chunk_count += 1
            if chunk_count > MAX_WAV_CHUNKS:
                raise AdmissionError(f"WAV contains more than {MAX_WAV_CHUNKS} chunks")
            source.seek(offset)
            chunk_header = source.read(8)
            if len(chunk_header) != 8:
                raise AdmissionError("truncated WAV chunk header")
            chunk_id, chunk_size = struct.unpack("<4sI", chunk_header)
            data_start = offset + 8
            data_end = data_start + chunk_size
            padded_end = data_end + (chunk_size & 1)
            if data_end > total_bytes or padded_end > total_bytes:
                raise AdmissionError("truncated WAV chunk")
            if chunk_id == b"fmt ":
                if fmt is not None:
                    raise AdmissionError("WAV contains duplicate format chunks")
                if data_bytes is not None:
                    raise AdmissionError("WAV format chunk must precede audio data")
                if chunk_size < 16:
                    raise AdmissionError("invalid WAV format chunk")
                source.seek(data_start)
                raw_fmt = source.read(16)
                if len(raw_fmt) != 16:
                    raise AdmissionError("truncated WAV format chunk")
                fmt = struct.unpack("<HHIIHH", raw_fmt)
            elif chunk_id == b"data":
                if fmt is None:
                    raise AdmissionError("WAV format chunk must precede audio data")
                if data_bytes is not None:
                    raise AdmissionError("WAV contains duplicate audio data chunks")
                data_bytes = chunk_size
                data_offset = data_start
            offset = padded_end

        if fmt is None or data_bytes is None or data_offset is None:
            raise AdmissionError("WAV is missing format or audio data")
        audio_format, channels, sample_rate, byte_rate, block_align, bits_per_sample = fmt
        if audio_format not in (1, 3) or (audio_format == 3 and bits_per_sample != 32):
            raise AdmissionError("audio must be uncompressed PCM or float WAV")
        if channels < 1 or channels > 2:
            raise AdmissionError("WAV must contain one or two channels")
        if sample_rate < 8_000 or sample_rate > 96_000:
            raise AdmissionError("WAV sample rate must be between 8000 and 96000 Hz")
        if bits_per_sample not in (8, 16, 24, 32):
            raise AdmissionError("unsupported WAV sample width")
        expected_align = channels * (bits_per_sample // 8)
        if block_align != expected_align or byte_rate != sample_rate * expected_align:
            raise AdmissionError("invalid WAV byte rate or block alignment")
        if data_bytes <= 0 or data_bytes % block_align != 0:
            raise AdmissionError("WAV contains no complete audio frames")
        duration_ms = data_bytes / byte_rate * 1_000
        if not math.isfinite(duration_ms) or duration_ms <= 0 or duration_ms > MAX_AUDIO_DURATION_MS:
            raise AdmissionError(f"WAV must be no longer than {MAX_AUDIO_DURATION_MS // 1_000} seconds")
        if audio_format == 3:
            _validate_finite_float32_samples(source, data_offset, data_bytes)
        return WavMetadata(duration_ms, sample_rate, channels, bits_per_sample, data_bytes)
    finally:
        source.seek(original)


def _validate_finite_float32_samples(source: BinaryIO, offset: int, length: int) -> None:
    """Require normalized finite audio in bounded blocks, never a decoded array."""
    source.seek(offset)
    remaining = length
    while remaining:
        block = source.read(min(READ_CHUNK_BYTES, remaining))
        if not block or len(block) % 4 != 0:
            raise AdmissionError("truncated WAV float audio data")
        for (sample,) in struct.iter_unpack("<f", block):
            if not math.isfinite(sample) or sample < -1.0 or sample > 1.0:
                raise AdmissionError(
                    "WAV float samples must be finite values between -1 and 1"
                )
        remaining -= len(block)


def validate_pcm_wav_bytes(data: bytes) -> WavMetadata:
    return validate_pcm_wav(io.BytesIO(data))


def validate_text(text: str) -> str:
    if not text.strip():
        raise AdmissionError("empty input")
    if len(text) > MAX_TTS_TEXT_CHARS:
        raise PayloadTooLargeError(f"input exceeds {MAX_TTS_TEXT_CHARS} characters")
    return text


def validate_prompt(prompt: str) -> str:
    if len(prompt) > MAX_PROMPT_CHARS:
        raise PayloadTooLargeError(f"prompt exceeds {MAX_PROMPT_CHARS} characters")
    return prompt


_VOICE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}$")
_WINDOWS_ABSOLUTE_PATH = re.compile(r"^[A-Za-z]:[\\/]")


@dataclass(frozen=True)
class PreparedPocketVoice:
    """A preset or immutable validated copy ready for Pocket-TTS to consume."""

    name: str
    conditioning: str | Path
    cache_key: tuple[object, ...]


def validate_voice_id(voice: str) -> str:
    if len(voice) > MAX_VOICE_ID_CHARS or _VOICE_ID.fullmatch(voice) is None:
        raise AdmissionError("voice must be a valid preset id of at most 128 characters")
    return voice


def _resolve_pocket_reference(
    voice: str,
    voice_root: str | Path,
    allowed_references: tuple[Path, ...] | frozenset[Path] = (),
) -> Path:
    if not voice or len(voice) > MAX_VOICE_PATH_CHARS:
        raise AdmissionError("voice reference path is empty or too long")
    if any(ord(char) < 32 or ord(char) == 127 for char in voice):
        raise AdmissionError("voice reference path contains control characters")
    scheme = urlsplit(voice).scheme
    if scheme and not (os.name == "nt" and _WINDOWS_ABSOLUTE_PATH.match(voice)):
        raise AdmissionError("Pocket voice references must not use URI schemes")

    candidate = Path(voice).expanduser()
    if not candidate.is_absolute():
        raise AdmissionError("Pocket voice reference must be an absolute local path")
    if candidate.suffix.lower() != ".wav":
        raise AdmissionError("Pocket voice reference must be a WAV file")
    try:
        candidate_info = candidate.lstat()
        if stat.S_ISLNK(candidate_info.st_mode):
            raise AdmissionError("Pocket voice reference must not be a symlink")
        if not stat.S_ISREG(candidate_info.st_mode):
            raise AdmissionError("Pocket voice reference must be a regular file")
        canonical = candidate.resolve(strict=True)
    except AdmissionError:
        raise
    except (OSError, RuntimeError) as err:
        raise AdmissionError("Pocket voice reference does not exist") from err

    root = Path(voice_root).expanduser().resolve(strict=False)
    try:
        canonical.relative_to(root)
    except ValueError as err:
        if canonical not in allowed_references:
            raise AdmissionError(
                "Pocket voice reference must stay inside the trusted voice root"
            ) from err
    return canonical


@contextmanager
def _open_validated_pocket_reference(
    canonical: Path,
) -> Iterator[tuple[BinaryIO, os.stat_result, WavMetadata]]:
    """Hold the no-follow descriptor whose bytes were actually validated."""

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(canonical, flags)
    except OSError as err:
        raise AdmissionError("Pocket voice reference could not be opened safely") from err
    try:
        reference = os.fdopen(descriptor, "rb")
    except OSError as err:
        os.close(descriptor)
        raise AdmissionError("Pocket voice reference could not be opened safely") from err
    try:
        with reference:
            info = os.fstat(reference.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise AdmissionError("Pocket voice reference must be a regular file")
            if info.st_size > MAX_POCKET_REFERENCE_BYTES:
                raise PayloadTooLargeError(
                    f"Pocket voice reference exceeds {MAX_POCKET_REFERENCE_BYTES} bytes"
                )
            metadata = validate_pcm_wav(reference)
            if metadata.duration_ms > MAX_POCKET_REFERENCE_DURATION_MS:
                raise AdmissionError(
                    f"Pocket voice reference must be no longer than "
                    f"{MAX_POCKET_REFERENCE_DURATION_MS // 1_000} seconds"
                )
            yield reference, info, metadata
    except AdmissionError:
        raise
    except OSError as err:
        raise AdmissionError("Pocket voice reference could not be validated") from err


def validate_pocket_voice(
    voice: str,
    voice_root: str | Path,
    allowed_references: tuple[Path, ...] | frozenset[Path] = (),
) -> str:
    """Return a preset id or a canonical, trusted, bounded local WAV path."""
    if _VOICE_ID.fullmatch(voice) is not None:
        return voice
    canonical = _resolve_pocket_reference(voice, voice_root, allowed_references)
    with _open_validated_pocket_reference(canonical):
        pass
    return str(canonical)


def _stable_file_identity(info: os.stat_result) -> tuple[int, int, int, int, int, int]:
    return (
        info.st_dev,
        info.st_ino,
        info.st_mode,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


@contextmanager
def prepare_pocket_voice(
    voice: str,
    voice_root: str | Path,
    allowed_references: tuple[Path, ...] | frozenset[Path] = (),
) -> Iterator[PreparedPocketVoice]:
    """Yield a stable Pocket conditioning source and content-bound cache key.

    Pocket's API consumes a path rather than an already-open descriptor.  A
    private temporary copy made from the validated no-follow descriptor closes
    the path-swap window; the source identity and SHA-256 bind cached model
    state to the exact bytes that produced it.
    """
    if _VOICE_ID.fullmatch(voice) is not None:
        yield PreparedPocketVoice(voice, voice, ("preset", voice))
        return

    canonical = _resolve_pocket_reference(voice, voice_root, allowed_references)
    temp_path: str | None = None
    try:
        with _open_validated_pocket_reference(canonical) as (source, before, _metadata):
            source.seek(0)
            descriptor, temp_path = tempfile.mkstemp(prefix="cicero-pocket-ref-", suffix=".wav")
            digest = hashlib.sha256()
            copied = 0
            try:
                with os.fdopen(descriptor, "wb") as output:
                    while True:
                        block = source.read(READ_CHUNK_BYTES)
                        if not block:
                            break
                        copied += len(block)
                        if copied > MAX_POCKET_REFERENCE_BYTES:
                            raise PayloadTooLargeError(
                                f"Pocket voice reference exceeds {MAX_POCKET_REFERENCE_BYTES} bytes"
                            )
                        digest.update(block)
                        output.write(block)
                    output.flush()
                    os.fsync(output.fileno())
            except BaseException:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
                raise

            after = os.fstat(source.fileno())
            if copied != before.st_size or _stable_file_identity(after) != _stable_file_identity(before):
                raise AdmissionError("Pocket voice reference changed while it was being validated")

        # Validate the exact immutable copy passed to the model, not merely the
        # path that existed before the copy was made.
        with open(temp_path, "rb") as copied_reference:
            copied_metadata = validate_pcm_wav(copied_reference)
        if copied_metadata.duration_ms > MAX_POCKET_REFERENCE_DURATION_MS:
            raise AdmissionError(
                f"Pocket voice reference must be no longer than "
                f"{MAX_POCKET_REFERENCE_DURATION_MS // 1_000} seconds"
            )
        os.chmod(temp_path, stat.S_IRUSR)
        identity = _stable_file_identity(before)
        yield PreparedPocketVoice(
            str(canonical),
            Path(temp_path),
            ("file", str(canonical), *identity, digest.hexdigest()),
        )
    finally:
        if temp_path is not None:
            try:
                os.chmod(temp_path, stat.S_IRUSR | stat.S_IWUSR)
            except OSError:
                pass
            try:
                os.unlink(temp_path)
            except OSError:
                pass


def validate_speed(speed: float) -> float:
    if isinstance(speed, bool) or not math.isfinite(speed):
        raise AdmissionError("speed must be a finite number")
    if speed < MIN_SPEECH_SPEED or speed > MAX_SPEECH_SPEED:
        raise AdmissionError(f"speed must be between {MIN_SPEECH_SPEED} and {MAX_SPEECH_SPEED}")
    return speed


def validate_turn_samples(audio: Any, sample_rate: Any, window_seconds: int) -> tuple[list[int | float], int]:
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, int):
        raise AdmissionError("sample_rate must be an integer")
    if sample_rate < MIN_TURN_SAMPLE_RATE or sample_rate > MAX_TURN_SAMPLE_RATE:
        raise AdmissionError(
            f"sample_rate must be between {MIN_TURN_SAMPLE_RATE} and {MAX_TURN_SAMPLE_RATE} Hz"
        )
    if not isinstance(audio, list) or not audio:
        raise AdmissionError("missing 'audio'")
    max_samples = sample_rate * window_seconds
    if len(audio) > max_samples:
        raise PayloadTooLargeError(f"audio exceeds the {window_seconds}-second model window")
    for value in audio:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise AdmissionError("audio samples must be numbers")
        sample = float(value)
        if not math.isfinite(sample) or sample < -1.0 or sample > 1.0:
            raise AdmissionError("audio samples must be finite values between -1 and 1")
    # Keep the already-bounded decoded list instead of duplicating hundreds of
    # thousands of Python float objects before NumPy converts it in the worker.
    return audio, sample_rate


class AudioSampleBudget:
    """Track PCM16 mono samples before the WAV encoder can exceed 64 MiB."""

    def __init__(self, max_bytes: int = MAX_OUTPUT_AUDIO_BYTES) -> None:
        if max_bytes <= WAV_HEADER_RESERVE_BYTES:
            raise ValueError("audio byte limit is too small")
        self.max_bytes = max_bytes
        self.max_samples = (max_bytes - WAV_HEADER_RESERVE_BYTES) // 2
        self.samples = 0

    def consume(self, sample_count: int) -> None:
        if isinstance(sample_count, bool) or not isinstance(sample_count, int) or sample_count < 0:
            raise ValueError("sample_count must be a non-negative integer")
        if self.samples + sample_count > self.max_samples:
            raise AudioOutputTooLargeError(f"synthesized audio exceeds {self.max_bytes} bytes")
        self.samples += sample_count


def ensure_audio_output_limited(data: bytes, max_bytes: int = MAX_OUTPUT_AUDIO_BYTES) -> bytes:
    if len(data) > max_bytes:
        raise AudioOutputTooLargeError(f"synthesized audio exceeds {max_bytes} bytes")
    return data


K = TypeVar("K")
V = TypeVar("V")


class BoundedLRUCache(Generic[K, V]):
    """Small thread-safe LRU whose failed factories never poison the cache."""

    def __init__(self, capacity: int) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self.capacity = capacity
        self._items: OrderedDict[K, V] = OrderedDict()
        self._lock = threading.RLock()

    def get_or_create(self, key: K, factory: Callable[[], V]) -> V:
        with self._lock:
            if key in self._items:
                value = self._items.pop(key)
                self._items[key] = value
                return value
            value = factory()
            self._items[key] = value
            while len(self._items) > self.capacity:
                self._items.popitem(last=False)
            return value

    def keys(self) -> tuple[K, ...]:
        with self._lock:
            return tuple(self._items.keys())

    def clear(self) -> None:
        with self._lock:
            self._items.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)


P = ParamSpec("P")
R = TypeVar("R")


class ModelGate:
    """Bound, serialize, and deadline native model inference.

    Native accelerator calls cannot be cancelled safely.  Each operation runs
    in a daemon thread so the request can fail at its deadline; a timeout then
    permanently marks this process unhealthy and schedules a deterministic
    process exit.  New work is rejected instead of ever sharing the uncertain
    native runtime.  This in-process watchdog depends on the extension yielding
    the Python GIL; a native hang that retains the GIL requires an external
    parent-process watchdog to guarantee termination.
    """

    def __init__(
        self,
        timeout_seconds: float = DEFAULT_MODEL_INFERENCE_TIMEOUT_SECONDS,
        max_queue: int = 0,
        restart_callback: Callable[[str], None] | None = None,
    ) -> None:
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("model inference timeout must be finite and positive")
        if isinstance(max_queue, bool) or not isinstance(max_queue, int) or max_queue < 0 or max_queue > 1:
            raise ValueError("model inference queue must contain at most one request")
        self.timeout_seconds = timeout_seconds
        self.max_queue = max_queue
        self._slots = threading.BoundedSemaphore(1 + max_queue)
        self._operation_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._healthy = True
        self._unhealthy_reason: str | None = None
        self._restart_requested = False
        self._restart_callback = restart_callback or _schedule_process_restart

    @property
    def healthy(self) -> bool:
        with self._state_lock:
            return self._healthy

    @property
    def unhealthy_reason(self) -> str | None:
        with self._state_lock:
            return self._unhealthy_reason

    def _require_healthy(self) -> None:
        with self._state_lock:
            if not self._healthy:
                reason = self._unhealthy_reason or "native model runtime is unhealthy"
                raise ModelUnavailableError(reason)

    def _mark_unhealthy(self, reason: str) -> None:
        callback: Callable[[str], None] | None = None
        with self._state_lock:
            if self._healthy:
                self._healthy = False
                self._unhealthy_reason = reason
            if not self._restart_requested:
                self._restart_requested = True
                callback = self._restart_callback
        if callback is not None:
            try:
                callback(reason)
            except Exception as err:
                # The process remains fail-closed even if a test hook or an
                # unusual embedder cannot schedule the exit.
                print(f"[sidecar] could not schedule model restart: {err}", file=sys.stderr, flush=True)

    def run(self, operation: Callable[P, R], *args: P.args, **kwargs: P.kwargs) -> R:
        self._require_healthy()
        if not self._slots.acquire(blocking=False):
            raise ModelBusyError("model is busy; retry later")

        deadline = time.monotonic() + self.timeout_seconds
        acquired_operation = False
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not self._operation_lock.acquire(timeout=max(0.0, remaining)):
                self._require_healthy()
                raise ModelBusyError("model queue deadline expired; retry later")
            acquired_operation = True
            self._require_healthy()

            completed = threading.Event()
            values: list[R] = []
            failures: list[BaseException] = []

            def invoke() -> None:
                try:
                    values.append(operation(*args, **kwargs))
                except BaseException as err:
                    failures.append(err)
                finally:
                    completed.set()

            worker = threading.Thread(target=invoke, name="cicero-model-inference", daemon=True)
            worker.start()
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not completed.wait(remaining):
                reason = f"model inference timed out after {self.timeout_seconds:g} seconds"
                self._mark_unhealthy(reason)
                raise ModelInferenceTimeoutError(reason)
            if failures:
                raise failures[0]
            if not values:
                raise RuntimeError("model inference completed without a result")
            return values[0]
        finally:
            if acquired_operation:
                self._operation_lock.release()
            self._slots.release()


def model_gate_pair(
    configured_timeout_seconds: float,
    warmup_timeout_floor_seconds: float,
    restart_callback: Callable[[str], None] | None = None,
) -> tuple[ModelGate, ModelGate]:
    """Build distinct cold-start and steady-state gates.

    Configured provider deadlines describe warm inference.  Model loading,
    kernel autotuning, and first-pass compilation can legitimately take much
    longer, so cold warmup receives at least the sidecar's normal timeout while
    remaining bounded.  Callers publish the steady gate only after warmup has
    succeeded.
    """
    steady_gate = ModelGate(
        timeout_seconds=configured_timeout_seconds,
        restart_callback=restart_callback,
    )
    if not math.isfinite(warmup_timeout_floor_seconds) or warmup_timeout_floor_seconds <= 0:
        raise ValueError("model warmup timeout floor must be finite and positive")
    warmup_gate = ModelGate(
        timeout_seconds=max(configured_timeout_seconds, warmup_timeout_floor_seconds),
        restart_callback=restart_callback,
    )
    return warmup_gate, steady_gate


def _schedule_process_restart(reason: str) -> None:
    """Exit shortly after the timeout response can be flushed to the caller."""
    print(f"[sidecar] FATAL: {reason}; restarting process", file=sys.stderr, flush=True)

    def exit_after_response() -> None:
        time.sleep(MODEL_RESTART_GRACE_SECONDS)
        os._exit(MODEL_RESTART_EXIT_CODE)

    threading.Thread(
        target=exit_after_response,
        name="cicero-model-restart",
        daemon=True,
    ).start()


class RequestBodyLimitMiddleware:
    """Bound concurrent admissions, body bytes, and the absolute read time."""

    def __init__(
        self,
        app: Any,
        limits: Mapping[str, int],
        timeout_seconds: float = BODY_READ_TIMEOUT_SECONDS,
        max_active_requests: int = MAX_ACTIVE_SIDECAR_REQUESTS,
    ) -> None:
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be finite and positive")
        if (
            isinstance(max_active_requests, bool)
            or not isinstance(max_active_requests, int)
            or max_active_requests <= 0
        ):
            raise ValueError("max_active_requests must be a positive integer")
        self.app = app
        self.limits = dict(limits)
        self.timeout_seconds = timeout_seconds
        self.max_active_requests = max_active_requests
        self._active_requests = 0
        self._active_lock = threading.Lock()

    async def __call__(self, scope: dict[str, Any], receive: Callable[[], Awaitable[dict[str, Any]]], send: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        if scope.get("type") != "http" or scope.get("method") not in {"POST", "PUT", "PATCH"}:
            await self.app(scope, receive, send)
            return
        limit = self.limits.get(scope.get("path", ""))
        if limit is None:
            await self.app(scope, receive, send)
            return

        with self._active_lock:
            if self._active_requests >= self.max_active_requests:
                admitted = False
            else:
                self._active_requests += 1
                admitted = True
        if not admitted:
            await self._reject(
                send,
                503,
                "sidecar request capacity is full; retry later",
                retry_after=True,
            )
            return

        try:
            await self._call_limited(scope, receive, send, limit)
        finally:
            with self._active_lock:
                self._active_requests -= 1

    async def _call_limited(
        self,
        scope: dict[str, Any],
        receive: Callable[[], Awaitable[dict[str, Any]]],
        send: Callable[[dict[str, Any]], Awaitable[None]],
        limit: int,
    ) -> None:
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        declared = _declared_content_length(headers)
        if declared is not None and declared > limit:
            await self._reject(send, 413, f"request body exceeds {limit} bytes")
            return

        received = 0
        rejection: tuple[int, str] | None = None
        response_started = False
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.timeout_seconds

        async def limited_receive() -> dict[str, Any]:
            nonlocal received, rejection
            remaining = deadline - loop.time()
            if remaining <= 0:
                rejection = (408, "request body read timed out")
                raise BodyReadTimeoutError(rejection[1])
            try:
                message = await asyncio.wait_for(receive(), timeout=remaining)
            except asyncio.TimeoutError as err:
                rejection = (408, "request body read timed out")
                raise BodyReadTimeoutError(rejection[1]) from err
            if message.get("type") == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    rejection = (413, f"request body exceeds {limit} bytes")
                    raise PayloadTooLargeError(rejection[1])
            return message

        async def tracked_send(message: dict[str, Any]) -> None:
            nonlocal response_started
            # FastAPI converts arbitrary receive errors into a generic 400.
            # Suppress that downstream response once our receive wrapper has
            # observed overflow so this outer middleware can emit the correct
            # 413 after request parsing unwinds.
            if rejection is not None:
                return
            if message.get("type") == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracked_send)
        except (PayloadTooLargeError, BodyReadTimeoutError) as err:
            rejection = (err.status_code, str(err))
        if rejection is not None:
            if response_started:
                raise RuntimeError("request admission failed after the response started")
            await self._reject(send, rejection[0], rejection[1])

    @staticmethod
    async def _reject(
        send: Callable[[dict[str, Any]], Awaitable[None]],
        status: int,
        message: str,
        retry_after: bool = False,
    ) -> None:
        body = json.dumps({"error": message}).encode("utf-8")
        headers = [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode("ascii")),
            (b"connection", b"close"),
        ]
        if retry_after:
            headers.append((b"retry-after", b"1"))
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": headers,
            }
        )
        await send({"type": "http.response.body", "body": body})
