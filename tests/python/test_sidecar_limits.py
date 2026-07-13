from __future__ import annotations

import asyncio
import io
import math
import os
import struct
import sys
import tempfile
import threading
import time
import unittest
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "servers"))

from sidecar_limits import (  # noqa: E402
    AdmissionError,
    AudioOutputTooLargeError,
    AudioSampleBudget,
    BoundedLRUCache,
    MAX_CANONICAL_JSON_FLOAT32_BYTES,
    MAX_POCKET_REFERENCE_BYTES,
    MAX_POCKET_VOICE_STATES,
    MAX_TURN_JSON_BYTES,
    MAX_TURN_JSON_ENVELOPE_BYTES,
    MAX_TURN_SAMPLE_RATE,
    MAX_TURN_WINDOW_SECONDS,
    MAX_WAV_CHUNKS,
    ModelBusyError,
    ModelGate,
    ModelInferenceTimeoutError,
    ModelUnavailableError,
    PayloadTooLargeError,
    RequestBodyLimitMiddleware,
    copy_upload_to_file_limited,
    model_gate_pair,
    read_request_body_limited,
    validate_pcm_wav_bytes,
    validate_pocket_voice,
    validate_speed,
    validate_text,
    validate_turn_samples,
    validate_voice_id,
)


def pcm_wav(seconds: float = 0.01, sample_rate: int = 16_000) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"\0\0" * max(1, int(seconds * sample_rate)))
    return output.getvalue()


def riff_wav(chunks: list[tuple[bytes, bytes]]) -> bytes:
    body = bytearray(b"WAVE")
    for chunk_id, chunk in chunks:
        body.extend(struct.pack("<4sI", chunk_id, len(chunk)))
        body.extend(chunk)
        if len(chunk) & 1:
            body.append(0)
    return b"RIFF" + struct.pack("<I", len(body)) + bytes(body)


def fmt_chunk(
    audio_format: int = 1,
    sample_rate: int = 16_000,
    channels: int = 1,
    bits_per_sample: int = 16,
) -> bytes:
    block_align = channels * (bits_per_sample // 8)
    return struct.pack(
        "<HHIIHH",
        audio_format,
        channels,
        sample_rate,
        sample_rate * block_align,
        block_align,
        bits_per_sample,
    )


class FakeRequest:
    def __init__(self, chunks: list[bytes], declared: int | None = None) -> None:
        self._chunks = chunks
        self.headers = {} if declared is None else {"content-length": str(declared)}

    async def stream(self):
        for chunk in self._chunks:
            yield chunk


class FakeUpload:
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = iter(chunks)

    async def read(self, size: int) -> bytes:
        self.last_size = size
        return next(self._chunks, b"")


async def call_asgi(app, chunks: list[bytes], declared: int | None = None):
    messages = [
        {
            "type": "http.request",
            "body": chunk,
            "more_body": index < len(chunks) - 1,
        }
        for index, chunk in enumerate(chunks)
    ]
    if not messages:
        messages.append({"type": "http.request", "body": b"", "more_body": False})
    sent: list[dict[str, object]] = []

    async def receive():
        return messages.pop(0)

    async def send(message):
        sent.append(message)

    headers = [] if declared is None else [(b"content-length", str(declared).encode("ascii"))]
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/limited",
        "headers": headers,
    }
    await app(scope, receive, send)
    return sent


class SidecarLimitTests(unittest.TestCase):
    def test_request_reader_enforces_declared_and_streamed_limits(self) -> None:
        body = asyncio.run(read_request_body_limited(FakeRequest([b"ab", b"cd"]), 4))
        self.assertEqual(body, b"abcd")
        with self.assertRaises(PayloadTooLargeError):
            asyncio.run(read_request_body_limited(FakeRequest([b"abc"], declared=4), 3))
        with self.assertRaises(PayloadTooLargeError):
            asyncio.run(read_request_body_limited(FakeRequest([b"abc", b"def"]), 5))

    def test_upload_copy_is_incremental_and_bounded(self) -> None:
        upload = FakeUpload([b"ab", b"cd", b""])
        output = io.BytesIO()
        self.assertEqual(asyncio.run(copy_upload_to_file_limited(upload, output, 4)), 4)
        self.assertEqual(output.getvalue(), b"abcd")
        self.assertLessEqual(upload.last_size, 64 * 1024)
        with self.assertRaises(PayloadTooLargeError):
            asyncio.run(copy_upload_to_file_limited(FakeUpload([b"abc", b"def"]), io.BytesIO(), 5))

    def test_asgi_middleware_rejects_declared_and_chunked_excess(self) -> None:
        called = False

        async def inner(scope, receive, send):
            nonlocal called
            called = True
            while True:
                message = await receive()
                if not message.get("more_body"):
                    break
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        app = RequestBodyLimitMiddleware(inner, {"/limited": 5})
        sent = asyncio.run(call_asgi(app, [b"abcdef"], declared=6))
        self.assertFalse(called)
        self.assertEqual(sent[0]["status"], 413)

        called = False
        sent = asyncio.run(call_asgi(app, [b"abc", b"def"]))
        self.assertTrue(called)
        self.assertEqual(sent[0]["status"], 413)

        sent = asyncio.run(call_asgi(app, [b"ab", b"cd"], declared=4))
        self.assertEqual(sent[0]["status"], 204)

    def test_asgi_middleware_has_one_absolute_body_read_deadline(self) -> None:
        async def inner(scope, receive, send):
            await receive()
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        app = RequestBodyLimitMiddleware(inner, {"/limited": 5}, timeout_seconds=0.01)
        sent: list[dict[str, object]] = []

        async def stalled_receive():
            await asyncio.Event().wait()

        async def send(message):
            sent.append(message)

        scope = {"type": "http", "method": "POST", "path": "/limited", "headers": []}
        asyncio.run(app(scope, stalled_receive, send))
        self.assertEqual(sent[0]["status"], 408)
        self.assertIn((b"connection", b"close"), sent[0]["headers"])

    def test_asgi_middleware_bounds_active_admissions_and_releases_capacity(self) -> None:
        async def exercise() -> None:
            entered = 0
            both_entered = asyncio.Event()
            release = asyncio.Event()

            async def inner(scope, receive, send):
                nonlocal entered
                entered += 1
                if entered == 2:
                    both_entered.set()
                await release.wait()
                await send({"type": "http.response.start", "status": 204, "headers": []})
                await send({"type": "http.response.body", "body": b""})

            app = RequestBodyLimitMiddleware(
                inner,
                {"/limited": 5},
                max_active_requests=2,
            )
            first = asyncio.create_task(call_asgi(app, [b""]))
            second = asyncio.create_task(call_asgi(app, [b""]))
            await asyncio.wait_for(both_entered.wait(), timeout=1)

            rejected = await call_asgi(app, [b""])
            self.assertEqual(rejected[0]["status"], 503)
            self.assertIn((b"retry-after", b"1"), rejected[0]["headers"])

            release.set()
            accepted = await asyncio.gather(first, second)
            self.assertEqual([messages[0]["status"] for messages in accepted], [204, 204])
            after_release = await call_asgi(app, [b""])
            self.assertEqual(after_release[0]["status"], 204)

        asyncio.run(exercise())

    def test_turn_wire_limit_admits_canonical_worst_case_float32_payload(self) -> None:
        token = "-1.1754943508222875e-38"
        self.assertLessEqual(len(token), MAX_CANONICAL_JSON_FLOAT32_BYTES)
        sample_count = MAX_TURN_SAMPLE_RATE * MAX_TURN_WINDOW_SECONDS
        body = (
            b'{"model":"smart-turn","sample_rate":96000,"audio":['
            + ((token + ",") * (sample_count - 1) + token).encode("ascii")
            + b"]}"
        )
        self.assertGreater(len(body), 16 * 1024 * 1024)
        self.assertLessEqual(len(body), MAX_TURN_JSON_BYTES)
        self.assertEqual(
            MAX_TURN_JSON_BYTES,
            sample_count * (MAX_CANONICAL_JSON_FLOAT32_BYTES + 1)
            + MAX_TURN_JSON_ENVELOPE_BYTES,
        )

        async def inner(scope, receive, send):
            while True:
                message = await receive()
                if not message.get("more_body"):
                    break
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        app = RequestBodyLimitMiddleware(inner, {"/limited": MAX_TURN_JSON_BYTES})
        sent = asyncio.run(call_asgi(app, [body], declared=len(body)))
        self.assertEqual(sent[0]["status"], 204)

    def test_wav_validation_matches_turn_audio_contract(self) -> None:
        metadata = validate_pcm_wav_bytes(pcm_wav())
        self.assertEqual(metadata.sample_rate, 16_000)
        self.assertEqual(metadata.channels, 1)

        compressed = bytearray(pcm_wav())
        compressed[20:22] = (6).to_bytes(2, "little")
        with self.assertRaisesRegex(AdmissionError, "uncompressed"):
            validate_pcm_wav_bytes(bytes(compressed))

        with self.assertRaisesRegex(AdmissionError, "no longer"):
            validate_pcm_wav_bytes(pcm_wav(seconds=121, sample_rate=8_000))

    def test_wav_validation_walks_the_complete_riff_without_decoder_differentials(self) -> None:
        fmt = fmt_chunk(bits_per_sample=8, sample_rate=8_000)
        valid = riff_wav([(b"fmt ", fmt), (b"data", b"\x80"), (b"JUNK", b"ok")])
        self.assertEqual(validate_pcm_wav_bytes(valid).data_bytes, 1)

        hidden_second_data = riff_wav(
            [(b"fmt ", fmt), (b"data", b"\x80"), (b"data", b"\x80" * 8_000)]
        )
        with self.assertRaisesRegex(AdmissionError, "duplicate audio data"):
            validate_pcm_wav_bytes(hidden_second_data)

        duplicate_fmt = riff_wav([(b"fmt ", fmt), (b"fmt ", fmt), (b"data", b"\x80")])
        with self.assertRaisesRegex(AdmissionError, "duplicate format"):
            validate_pcm_wav_bytes(duplicate_fmt)

        data_first = riff_wav([(b"data", b"\x80"), (b"fmt ", fmt)])
        with self.assertRaisesRegex(AdmissionError, "format chunk must precede"):
            validate_pcm_wav_bytes(data_first)

        trailing_partial = bytearray(riff_wav([(b"fmt ", fmt), (b"data", b"\x80")]))
        trailing_partial.extend(b"abc")
        trailing_partial[4:8] = struct.pack("<I", len(trailing_partial) - 8)
        with self.assertRaisesRegex(AdmissionError, "trailing chunk header"):
            validate_pcm_wav_bytes(bytes(trailing_partial))

        too_many_chunks = riff_wav(
            [(b"fmt ", fmt)]
            + [(b"JUNK", b"")] * (MAX_WAV_CHUNKS - 1)
            + [(b"data", b"\x80")]
        )
        with self.assertRaisesRegex(AdmissionError, "more than"):
            validate_pcm_wav_bytes(too_many_chunks)

    def test_float_wav_validation_requires_normalized_finite_samples_without_decoding(self) -> None:
        fmt = fmt_chunk(audio_format=3, bits_per_sample=32)
        finite = riff_wav(
            [(b"fmt ", fmt), (b"data", struct.pack("<ffff", -1.0, -0.25, 0.5, 1.0))]
        )
        self.assertEqual(validate_pcm_wav_bytes(finite).data_bytes, 16)
        for sample in (math.nan, math.inf, -math.inf, 1.0001, -1.0001, 3.402823466e38):
            invalid = riff_wav([(b"fmt ", fmt), (b"data", struct.pack("<f", sample))])
            with self.subTest(sample=sample), self.assertRaisesRegex(AdmissionError, "between -1 and 1"):
                validate_pcm_wav_bytes(invalid)

    def test_text_voice_speed_and_turn_admission(self) -> None:
        self.assertEqual(validate_text("hello"), "hello")
        with self.assertRaises(AdmissionError):
            validate_text("  ")
        self.assertEqual(validate_voice_id("af_heart+af_bella"), "af_heart+af_bella")
        with self.assertRaises(AdmissionError):
            validate_voice_id("../../voice")
        self.assertEqual(validate_speed(1.15), 1.15)
        for invalid in (0.1, 3.0, math.inf, math.nan):
            with self.assertRaises(AdmissionError):
                validate_speed(invalid)

        audio, rate = validate_turn_samples([0.0, -1.0, 1.0], 16_000, 8)
        self.assertEqual((audio, rate), ([0.0, -1.0, 1.0], 16_000))
        with self.assertRaises(AdmissionError):
            validate_turn_samples([math.nan], 16_000, 8)
        with self.assertRaises(PayloadTooLargeError):
            validate_turn_samples([0.0] * 80_001, 10_000, 8)

    def test_pocket_references_are_canonical_local_bounded_wavs_under_trusted_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "voices"
            voice_dir = root / "person"
            voice_dir.mkdir(parents=True)
            valid = voice_dir / "reference.wav"
            valid.write_bytes(pcm_wav())

            canonical = str(valid.resolve())
            self.assertEqual(validate_pocket_voice(canonical, root), canonical)
            alias = str(voice_dir / ".." / "person" / "reference.wav")
            self.assertEqual(validate_pocket_voice(alias, root), canonical)
            self.assertEqual(validate_pocket_voice("anna", root), "anna")

            for uri in (
                "http://example.com/voice.wav",
                "https://example.com/voice.wav",
                "hf://org/repo/voice.wav",
                "file:///tmp/voice.wav",
                "ftp://example.com/voice.wav",
            ):
                with self.subTest(uri=uri), self.assertRaisesRegex(AdmissionError, "URI"):
                    validate_pocket_voice(uri, root)

            outside = base / "outside.wav"
            outside.write_bytes(pcm_wav())
            allowed = frozenset({outside.resolve()})
            self.assertEqual(
                validate_pocket_voice(str(outside), root, allowed),
                str(outside.resolve()),
            )
            sibling = base / "not-allowed.wav"
            sibling.write_bytes(pcm_wav())
            with self.assertRaisesRegex(AdmissionError, "trusted voice root"):
                validate_pocket_voice(str(sibling), root, allowed)
            traversal = str(root / "person" / ".." / ".." / "outside.wav")
            for unsafe in (str(outside), traversal, "relative/reference.wav"):
                with self.subTest(unsafe=unsafe), self.assertRaises(AdmissionError):
                    validate_pocket_voice(unsafe, root)

            malformed = voice_dir / "malformed.wav"
            malformed.write_bytes(b"not a wav")
            with self.assertRaisesRegex(AdmissionError, "PCM WAV"):
                validate_pocket_voice(str(malformed), root)

            hidden = voice_dir / "hidden-second-data.wav"
            hidden.write_bytes(
                riff_wav(
                    [
                        (b"fmt ", fmt_chunk(bits_per_sample=8, sample_rate=8_000)),
                        (b"data", b"\x80"),
                        (b"data", b"\x80" * 8_000),
                    ]
                )
            )
            with self.assertRaisesRegex(AdmissionError, "duplicate audio data"):
                validate_pocket_voice(str(hidden), root)

            directory_reference = voice_dir / "directory.wav"
            directory_reference.mkdir()
            with self.assertRaisesRegex(AdmissionError, "regular file"):
                validate_pocket_voice(str(directory_reference), root)

            over_duration = voice_dir / "too-long.wav"
            over_duration.write_bytes(pcm_wav(seconds=31, sample_rate=8_000))
            with self.assertRaisesRegex(AdmissionError, "30 seconds"):
                validate_pocket_voice(str(over_duration), root)

            oversized = voice_dir / "oversized.wav"
            with oversized.open("wb") as output:
                output.seek(MAX_POCKET_REFERENCE_BYTES)
                output.write(b"x")
            with self.assertRaises(PayloadTooLargeError):
                validate_pocket_voice(str(oversized), root)

            symlink = voice_dir / "linked.wav"
            try:
                os.symlink(valid, symlink)
            except (NotImplementedError, OSError):
                symlink = None
            if symlink is not None:
                with self.assertRaisesRegex(AdmissionError, "symlink"):
                    validate_pocket_voice(str(symlink), root)

    def test_audio_budget_rejects_before_encoded_output_limit(self) -> None:
        budget = AudioSampleBudget(max_bytes=4_100)
        budget.consume(2)
        with self.assertRaises(AudioOutputTooLargeError):
            budget.consume(1)

    def test_pocket_cache_is_lru_bounded_and_factory_failures_are_not_cached(self) -> None:
        cache: BoundedLRUCache[str, object] = BoundedLRUCache(2)
        first = object()
        cache.get_or_create("a", lambda: first)
        cache.get_or_create("b", object)
        self.assertIs(cache.get_or_create("a", object), first)
        cache.get_or_create("c", object)
        self.assertEqual(cache.keys(), ("a", "c"))
        self.assertEqual(len(cache), 2)

        def fail():
            raise RuntimeError("boom")

        with self.assertRaises(RuntimeError):
            cache.get_or_create("failed", fail)
        self.assertNotIn("failed", cache.keys())
        self.assertEqual(MAX_POCKET_VOICE_STATES, 16)

    def test_model_gate_rejects_overlap_instead_of_building_an_unbounded_queue(self) -> None:
        gate = ModelGate(timeout_seconds=1)
        started = threading.Event()
        release = threading.Event()

        def operation() -> str:
            started.set()
            release.wait(1)
            return "done"

        with ThreadPoolExecutor(max_workers=2) as pool:
            active = pool.submit(gate.run, operation)
            self.assertTrue(started.wait(1))
            with self.assertRaises(ModelBusyError):
                gate.run(lambda: "must not run")
            release.set()
            self.assertEqual(active.result(timeout=1), "done")
        self.assertTrue(gate.healthy)

    def test_model_gate_timeout_is_fail_closed_and_requests_one_restart(self) -> None:
        restarts: list[str] = []
        release = threading.Event()
        gate = ModelGate(
            timeout_seconds=0.02,
            restart_callback=restarts.append,
        )
        started_at = time.monotonic()
        with self.assertRaises(ModelInferenceTimeoutError):
            gate.run(lambda: release.wait(1))
        self.assertLess(time.monotonic() - started_at, 0.5)
        self.assertFalse(gate.healthy)
        self.assertEqual(len(restarts), 1)
        with self.assertRaises(ModelUnavailableError):
            gate.run(lambda: None)
        self.assertEqual(len(restarts), 1)
        release.set()

    def test_cold_warmup_gate_is_distinct_from_configured_steady_state_deadline(self) -> None:
        restarts: list[str] = []
        warmup_gate, steady_gate = model_gate_pair(
            configured_timeout_seconds=0.02,
            warmup_timeout_floor_seconds=0.2,
            restart_callback=restarts.append,
        )
        self.assertIsNot(warmup_gate, steady_gate)
        self.assertEqual(warmup_gate.timeout_seconds, 0.2)
        self.assertEqual(steady_gate.timeout_seconds, 0.02)
        self.assertEqual(warmup_gate.run(lambda: (time.sleep(0.05), "warm")[1]), "warm")
        self.assertEqual(restarts, [])

        release = threading.Event()
        with self.assertRaises(ModelInferenceTimeoutError):
            steady_gate.run(lambda: release.wait(1))
        self.assertFalse(steady_gate.healthy)
        self.assertTrue(warmup_gate.healthy)
        self.assertEqual(len(restarts), 1)
        release.set()


if __name__ == "__main__":
    unittest.main()
