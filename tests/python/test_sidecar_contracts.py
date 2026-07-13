from __future__ import annotations

import asyncio
import importlib
import io
import json
import os
import struct
import sys
import tempfile
import threading
import types
import unittest
import uuid
import wave
from concurrent.futures import ThreadPoolExecutor
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SERVERS = ROOT / "servers"
sys.path.insert(0, str(SERVERS))

from sidecar_limits import (  # noqa: E402
    AudioOutputTooLargeError,
    AudioSampleBudget,
    MAX_TURN_MODEL_CHARS,
    MAX_SER_LABELS,
    MAX_TRANSCRIPT_CHARS,
    MAX_TRANSCRIPT_SEGMENTS,
    MAX_TTS_JSON_BYTES,
    ModelGate,
    ModelInferenceTimeoutError,
    validate_pcm_wav_bytes,
)


def pcm_wav() -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16_000)
        wav.writeframes(b"\0\0" * 160)
    return output.getvalue()


def riff_wav(chunks: list[tuple[bytes, bytes]]) -> bytes:
    body = bytearray(b"WAVE")
    for chunk_id, chunk in chunks:
        body.extend(struct.pack("<4sI", chunk_id, len(chunk)))
        body.extend(chunk)
        if len(chunk) & 1:
            body.append(0)
    return b"RIFF" + struct.pack("<I", len(body)) + bytes(body)


def fmt_chunk(audio_format: int = 1, bits: int = 16, rate: int = 16_000) -> bytes:
    width = bits // 8
    return struct.pack("<HHIIHH", audio_format, 1, rate, rate * width, width, bits)


def malformed_wavs() -> dict[str, bytes]:
    fmt = fmt_chunk(bits=8, rate=8_000)
    valid = [(b"fmt ", fmt), (b"data", b"\x80")]
    trailing = bytearray(riff_wav(valid))
    trailing.extend(b"abc")
    trailing[4:8] = struct.pack("<I", len(trailing) - 8)
    return {
        "hidden-second-data": riff_wav(valid + [(b"data", b"\x80" * 8_000)]),
        "duplicate-fmt": riff_wav([(b"fmt ", fmt), (b"fmt ", fmt), (b"data", b"\x80")]),
        "data-before-fmt": riff_wav([(b"data", b"\x80"), (b"fmt ", fmt)]),
        "trailing-partial": bytes(trailing),
        "float-nan": riff_wav([(b"fmt ", fmt_chunk(3, 32)), (b"data", struct.pack("<f", float("nan")))]),
        "float-inf": riff_wav([(b"fmt ", fmt_chunk(3, 32)), (b"data", struct.pack("<f", float("inf")))]),
        "float-out-of-range": riff_wav(
            [(b"fmt ", fmt_chunk(3, 32)), (b"data", struct.pack("<f", 3.402823466e38))]
        ),
    }


def _module(name: str, **attributes):
    module = types.ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    return module


def load_server(filename: str, ready: bool = True):
    """Import a real server module with only heavyweight model imports stubbed."""
    scipy_signal = _module("scipy.signal", resample_poly=lambda audio, *_args, **_kwargs: audio)
    stubs = {
        "mlx_whisper": _module("mlx_whisper", transcribe=lambda *_args, **_kwargs: {"text": "stub"}),
        "numpy": _module("numpy"),
        "soundfile": _module("soundfile"),
        "faster_whisper": _module("faster_whisper", WhisperModel=object),
        "onnxruntime": _module("onnxruntime"),
        "huggingface_hub": _module("huggingface_hub", hf_hub_download=lambda *_args: "/stub/model"),
        "scipy": _module("scipy", signal=scipy_signal),
        "scipy.signal": scipy_signal,
        "transformers": _module("transformers", WhisperFeatureExtractor=object),
        "pocket_tts": _module("pocket_tts", TTSModel=object),
        "kokoro": _module("kokoro", KPipeline=object),
    }
    saved = {name: sys.modules.get(name) for name in stubs}
    sys.modules.update(stubs)
    name = f"cicero_contract_{Path(filename).stem}_{uuid.uuid4().hex}"
    spec = spec_from_file_location(name, SERVERS / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {filename}")
    module = module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
        if ready and hasattr(module, "_ready"):
            module._ready = True
        return module
    finally:
        for stub_name, previous in saved.items():
            if previous is None:
                sys.modules.pop(stub_name, None)
            else:
                sys.modules[stub_name] = previous


async def asgi_request(
    app,
    method: str,
    path: str,
    body: bytes = b"",
    content_type: str | None = None,
    declared_length: int | None = None,
    omit_content_length: bool = False,
    split_at: int | None = None,
):
    headers: list[tuple[bytes, bytes]] = []
    if content_type is not None:
        headers.append((b"content-type", content_type.encode("ascii")))
    if not omit_content_length:
        length = len(body) if declared_length is None else declared_length
        headers.append((b"content-length", str(length).encode("ascii")))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 12345),
        "server": ("127.0.0.1", 80),
        "root_path": "",
    }
    chunks = [body] if split_at is None else [body[:split_at], body[split_at:]]
    next_chunk = 0
    messages: list[dict[str, object]] = []

    async def receive():
        nonlocal next_chunk
        if next_chunk < len(chunks):
            chunk = chunks[next_chunk]
            next_chunk += 1
            return {
                "type": "http.request",
                "body": chunk,
                "more_body": next_chunk < len(chunks),
            }
        return {"type": "http.disconnect"}

    async def send(message):
        messages.append(message)

    await app(scope, receive, send)
    start = next(message for message in messages if message["type"] == "http.response.start")
    response_body = b"".join(
        message.get("body", b"")
        for message in messages
        if message["type"] == "http.response.body"
    )
    return int(start["status"]), response_body, start.get("headers", [])


def multipart(file_bytes: bytes, path: str, fields: dict[str, str]) -> tuple[bytes, str]:
    boundary = f"cicero-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
        )
    chunks.append(
        (
            f"--{boundary}\r\n"
            f"Content-Disposition: form-data; name=\"file\"; filename=\"{path}\"\r\n"
            "Content-Type: audio/wav\r\n\r\n"
        ).encode()
    )
    chunks.append(file_bytes)
    chunks.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


class SidecarContractTests(unittest.TestCase):
    def test_warmup_dependent_health_routes_fail_closed_until_ready(self) -> None:
        mlx = load_server("stt_server.py", ready=False)
        status, _response, _headers = asyncio.run(asgi_request(mlx.app, "GET", "/"))
        self.assertEqual(status, 503)
        mlx._ready = True
        status, _response, _headers = asyncio.run(asgi_request(mlx.app, "GET", "/"))
        self.assertEqual(status, 200)

        turn = load_server("turn_server.py", ready=False)
        turn._session = object()
        turn._feature_extractor = object()
        status, _response, _headers = asyncio.run(asgi_request(turn.app, "GET", "/health"))
        self.assertEqual(status, 503)
        turn._ready = True
        status, _response, _headers = asyncio.run(asgi_request(turn.app, "GET", "/health"))
        self.assertEqual(status, 200)

        ser = load_server("ser_server.py", ready=False)
        ser._model = object()
        status, _response, _headers = asyncio.run(asgi_request(ser.app, "GET", "/health"))
        self.assertEqual(status, 503)
        ser._ready = True
        status, _response, _headers = asyncio.run(asgi_request(ser.app, "GET", "/health"))
        self.assertEqual(status, 200)

    def test_transcript_collectors_reject_oversized_or_invalid_native_output(self) -> None:
        mlx = load_server("stt_server.py")
        self.assertEqual(mlx.bounded_transcript(" [timestamp] hello "), "hello")
        with self.assertRaisesRegex(RuntimeError, "too long"):
            mlx.bounded_transcript("x" * (MAX_TRANSCRIPT_CHARS + 1))
        with self.assertRaisesRegex(RuntimeError, "invalid text"):
            mlx.bounded_transcript({"not": "text"})

        faster = load_server("stt_faster_whisper_server.py")
        self.assertEqual(
            faster.bounded_transcript(
                [
                    SimpleNamespace(text=""),
                    SimpleNamespace(text=" hello"),
                    SimpleNamespace(text=" world "),
                ]
            ),
            "hello world",
        )
        with self.assertRaisesRegex(RuntimeError, "too long"):
            faster.bounded_transcript(
                [
                    SimpleNamespace(text="x" * MAX_TRANSCRIPT_CHARS),
                    SimpleNamespace(text="y"),
                ]
            )
        with self.assertRaisesRegex(RuntimeError, "invalid segment"):
            faster.bounded_transcript([SimpleNamespace(text=None)])
        with self.assertRaisesRegex(RuntimeError, "too many segments"):
            faster.bounded_transcript(
                SimpleNamespace(text="")
                for _ in range(MAX_TRANSCRIPT_SEGMENTS + 1)
            )

    def test_both_stt_routes_keep_multipart_contracts(self) -> None:
        mlx = load_server("stt_server.py")
        observed_paths: list[str] = []

        def transcribe(path, **_kwargs):
            observed_paths.append(path)
            self.assertTrue(os.path.isfile(path))
            return {"text": " hello mlx "}

        mlx.mlx_whisper.transcribe = transcribe
        body, content_type = multipart(
            pcm_wav(),
            "audio.wav",
            {"prompt": "", "response_format": "json"},
        )
        status, response, _headers = asyncio.run(
            asgi_request(mlx.app, "POST", "/inference", body, content_type)
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(response), {"text": "hello mlx"})
        self.assertEqual(len(observed_paths), 1)
        self.assertFalse(os.path.exists(observed_paths[0]))

        faster = load_server("stt_faster_whisper_server.py")
        faster._model = object()
        faster._transcribe_bytes = lambda data: "hello faster"
        body, content_type = multipart(
            pcm_wav(),
            "audio.wav",
            {"model": "large-v3-turbo", "response_format": "json"},
        )
        status, response, _headers = asyncio.run(
            asgi_request(faster.app, "POST", "/v1/audio/transcriptions", body, content_type)
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(response), {"text": "hello faster"})

    def test_raw_multipart_and_pocket_routes_reject_ambiguous_or_nonfinite_wavs(self) -> None:
        invalid = malformed_wavs()
        mlx = load_server("stt_server.py")
        mlx.mlx_whisper.transcribe = lambda *_args, **_kwargs: self.fail("invalid WAV reached MLX")
        faster = load_server("stt_faster_whisper_server.py")
        faster._model = object()
        faster._transcribe_bytes = lambda _data: self.fail("invalid WAV reached faster-whisper")
        ser = load_server("ser_server.py")
        ser._model = object()

        for name, audio in invalid.items():
            with self.subTest(route="mlx-multipart", case=name):
                body, content_type = multipart(
                    audio,
                    "audio.wav",
                    {"prompt": "", "response_format": "json"},
                )
                status, _response, _headers = asyncio.run(
                    asgi_request(mlx.app, "POST", "/inference", body, content_type)
                )
                self.assertEqual(status, 400)

            with self.subTest(route="faster-multipart", case=name):
                body, content_type = multipart(
                    audio,
                    "audio.wav",
                    {"model": "large-v3-turbo", "response_format": "json"},
                )
                status, _response, _headers = asyncio.run(
                    asgi_request(
                        faster.app,
                        "POST",
                        "/v1/audio/transcriptions",
                        body,
                        content_type,
                    )
                )
                self.assertEqual(status, 400)

            with self.subTest(route="ser-raw", case=name):
                status, _response, _headers = asyncio.run(
                    asgi_request(ser.app, "POST", "/infer", audio, "application/octet-stream")
                )
                self.assertEqual(status, 400)

        pocket = load_server("tts_pocket_server.py")
        pocket._model = SimpleNamespace(
            sample_rate=24_000,
            get_state_for_audio_prompt=lambda *_args, **_kwargs: self.fail(
                "invalid Pocket reference reached the model"
            ),
        )

        def validate_reference_during_synthesis(_text, voice):
            pocket._get_state(voice)
            self.fail("invalid Pocket reference reached synthesis")

        pocket._synthesize_wav = validate_reference_during_synthesis
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "voices"
            root.mkdir()
            pocket._voice_root = root
            for name, audio in invalid.items():
                reference = root / f"{name}.wav"
                reference.write_bytes(audio)
                body = json.dumps({"input": "hello", "voice": str(reference), "speed": 1.0}).encode()
                with self.subTest(route="pocket-reference", case=name):
                    status, _response, _headers = asyncio.run(
                        asgi_request(
                            pocket.app,
                            "POST",
                            "/v1/audio/speech",
                            body,
                            "application/json",
                        )
                    )
                    self.assertEqual(status, 400)

    def test_mlx_temp_upload_is_removed_when_incremental_read_fails(self) -> None:
        mlx = load_server("stt_server.py")

        class FailingUpload:
            calls = 0

            async def read(self, _size):
                self.calls += 1
                if self.calls == 1:
                    return b"RIFF"
                raise OSError("client disconnected")

        original = tempfile.NamedTemporaryFile
        with tempfile.TemporaryDirectory() as directory:
            def in_directory(*args, **kwargs):
                kwargs["dir"] = directory
                return original(*args, **kwargs)

            with patch.object(mlx.tempfile, "NamedTemporaryFile", new=in_directory):
                response = asyncio.run(
                    mlx.inference(FailingUpload(), prompt="", response_format="json")
                )
            self.assertEqual(response.status_code, 400)
            self.assertEqual(os.listdir(directory), [])

    def test_turn_and_ser_routes_offload_stubbed_inference(self) -> None:
        turn = load_server("turn_server.py")
        turn._session = object()
        turn._feature_extractor = object()
        turn._predict_samples = lambda audio, sample_rate: (0.8, 1)
        body = json.dumps({"model": "smart-turn", "sample_rate": 16_000, "audio": [0.0, 0.2]}).encode()
        status, response, _headers = asyncio.run(
            asgi_request(turn.app, "POST", "/predict", body, "application/json")
        )
        self.assertEqual(status, 200)
        self.assertEqual(
            json.loads(response),
            {"prediction": 1, "probability": 0.8, "is_complete": True},
        )
        oversized_model = json.dumps(
            {
                "model": "m" * (MAX_TURN_MODEL_CHARS + 1),
                "sample_rate": 16_000,
                "audio": [0.0],
            }
        ).encode()
        status, _response, _headers = asyncio.run(
            asgi_request(turn.app, "POST", "/predict", oversized_model, "application/json")
        )
        self.assertEqual(status, 400)

        ser = load_server("ser_server.py")
        ser._model = object()
        ser._decode_and_classify = lambda body: ("happy", 0.9, {"happy": 0.9})
        status, response, _headers = asyncio.run(
            asgi_request(ser.app, "POST", "/infer", pcm_wav(), "application/octet-stream")
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(response)["label"], "happy")

    def test_ser_rejects_empty_mismatched_unbounded_or_nonfinite_model_outputs(self) -> None:
        ser = load_server("ser_server.py")
        ser.np.float32 = "float32"

        class FakeAudio:
            ndim = 1

            def astype(self, _dtype):
                return self

        class FakeModel:
            def __init__(self, result):
                self.result = result

            def generate(self, *_args, **_kwargs):
                return self.result

        valid = [{"labels": ["中立/neutral", "开心/happy"], "scores": [0.2, 0.8]}]
        ser._model = FakeModel(valid)
        label, score, all_scores = ser._classify(FakeAudio(), 16_000)
        self.assertEqual((label, score, all_scores), ("happy", 0.8, {"neutral": 0.2, "happy": 0.8}))

        invalid_results = {
            "missing-result": [],
            "empty-arrays": [{"labels": [], "scores": []}],
            "mismatched": [{"labels": ["happy"], "scores": [0.5, 0.5]}],
            "too-many": [{"labels": [f"label-{i}" for i in range(MAX_SER_LABELS + 1)],
                          "scores": [0.1] * (MAX_SER_LABELS + 1)}],
            "long-label": [{"labels": ["x" * 129], "scores": [0.5]}],
            "duplicate": [{"labels": ["中立/neutral", "neutral"], "scores": [0.4, 0.6]}],
            "nan": [{"labels": ["happy"], "scores": [float("nan")]}],
            "infinity": [{"labels": ["happy"], "scores": [float("inf")]}],
            "negative": [{"labels": ["happy"], "scores": [-0.1]}],
            "above-one": [{"labels": ["happy"], "scores": [1.1]}],
        }
        for name, result in invalid_results.items():
            ser._model = FakeModel(result)
            with self.subTest(case=name), self.assertRaises(RuntimeError):
                ser._classify(FakeAudio(), 16_000)

    def test_tts_routes_validate_and_bound_the_existing_json_contract(self) -> None:
        pocket = load_server("tts_pocket_server.py")
        pocket._model = SimpleNamespace(sample_rate=24_000)
        pocket._synthesize_wav = lambda text, voice: b"RIFF-pocket"
        valid = json.dumps({"input": "hello", "voice": "anna", "response_format": "wav", "speed": 1.0}).encode()
        status, response, _headers = asyncio.run(
            asgi_request(pocket.app, "POST", "/v1/audio/speech", valid, "application/json")
        )
        self.assertEqual((status, response), (200, b"RIFF-pocket"))

        invalid_speed = json.dumps({"input": "hello", "voice": "anna", "speed": 1.15}).encode()
        status, response, _headers = asyncio.run(
            asgi_request(pocket.app, "POST", "/v1/audio/speech", invalid_speed, "application/json")
        )
        self.assertEqual(status, 400)
        self.assertIn("speed", json.loads(response)["error"])

        boolean_speed = json.dumps({"input": "hello", "voice": "anna", "speed": True}).encode()
        status, _response, _headers = asyncio.run(
            asgi_request(pocket.app, "POST", "/v1/audio/speech", boolean_speed, "application/json")
        )
        self.assertEqual(status, 422)

        oversized = b"x" * (MAX_TTS_JSON_BYTES + 1)
        status, _response, headers = asyncio.run(
            asgi_request(
                pocket.app,
                "POST",
                "/v1/audio/speech",
                oversized,
                "application/json",
                omit_content_length=True,
                split_at=MAX_TTS_JSON_BYTES,
            )
        )
        self.assertEqual(status, 413)
        self.assertIn((b"connection", b"close"), headers)

        def over_limit(_text, _voice):
            raise AudioOutputTooLargeError("synthesized audio exceeds limit")

        pocket._synthesize_wav = over_limit
        status, _response, _headers = asyncio.run(
            asgi_request(pocket.app, "POST", "/v1/audio/speech", valid, "application/json")
        )
        self.assertEqual(status, 413)

        kokoro = load_server("tts_kokoro_server.py")
        kokoro._pipe = object()
        kokoro._synthesize_wav = lambda text, voice, speed: b"RIFF-kokoro"
        status, response, _headers = asyncio.run(
            asgi_request(kokoro.app, "POST", "/v1/audio/speech", valid, "application/json")
        )
        self.assertEqual((status, response), (200, b"RIFF-kokoro"))

        status, _response, _headers = asyncio.run(
            asgi_request(kokoro.app, "POST", "/v1/audio/speech", boolean_speed, "application/json")
        )
        self.assertEqual(status, 422)

    def test_native_timeout_returns_503_then_all_sidecar_health_routes_fail_closed(self) -> None:
        pocket = load_server("tts_pocket_server.py")
        pocket._model = SimpleNamespace(sample_rate=24_000)
        release = threading.Event()
        restarts: list[str] = []
        pocket._model_gate = ModelGate(timeout_seconds=0.02, restart_callback=restarts.append)

        def hang(_text, _voice):
            release.wait(1)
            return b"too late"

        pocket._synthesize_wav = hang
        body = json.dumps({"input": "hello", "voice": "anna", "speed": 1.0}).encode()
        status, response, _headers = asyncio.run(
            asgi_request(pocket.app, "POST", "/v1/audio/speech", body, "application/json")
        )
        self.assertEqual(status, 503)
        self.assertIn("timed out", json.loads(response)["error"])
        self.assertEqual(len(restarts), 1)
        status, _response, _headers = asyncio.run(asgi_request(pocket.app, "GET", "/v1/models"))
        self.assertEqual(status, 503)
        release.set()

        # Every native-model server exposes the same fail-closed health
        # semantics once its gate has timed out.
        unhealthy_gate = ModelGate(timeout_seconds=0.01, restart_callback=lambda _reason: None)
        blocker = threading.Event()
        with self.assertRaises(ModelInferenceTimeoutError):
            unhealthy_gate.run(lambda: blocker.wait(1))
        blocker.set()

        mlx = load_server("stt_server.py")
        faster = load_server("stt_faster_whisper_server.py")
        faster._model = object()
        kokoro = load_server("tts_kokoro_server.py")
        kokoro._pipe = object()
        turn = load_server("turn_server.py")
        turn._session = object()
        turn._feature_extractor = object()
        ser = load_server("ser_server.py")
        ser._model = object()
        modules_and_paths = [
            (mlx, "/"),
            (faster, "/health"),
            (kokoro, "/v1/models"),
            (turn, "/health"),
            (ser, "/health"),
        ]
        for module, path in modules_and_paths:
            module._model_gate = unhealthy_gate
            with self.subTest(server=Path(module.__file__).name):
                status, _response, _headers = asyncio.run(asgi_request(module.app, "GET", path))
                self.assertEqual(status, 503)

    def test_sidecar_route_rejects_busy_inference_with_retry_after(self) -> None:
        pocket = load_server("tts_pocket_server.py")
        pocket._model = SimpleNamespace(sample_rate=24_000)
        pocket._model_gate = ModelGate(timeout_seconds=1)
        started = threading.Event()
        release = threading.Event()

        def synthesize(_text, _voice):
            started.set()
            release.wait(1)
            return b"RIFF-ready"

        pocket._synthesize_wav = synthesize
        body = json.dumps({"input": "hello", "voice": "anna", "speed": 1.0}).encode()

        with ThreadPoolExecutor(max_workers=2) as pool:
            active = pool.submit(
                lambda: asyncio.run(
                    asgi_request(
                        pocket.app,
                        "POST",
                        "/v1/audio/speech",
                        body,
                        "application/json",
                    )
                )
            )
            self.assertTrue(started.wait(1))
            invalid_reference_body = json.dumps(
                {"input": "hello", "voice": "/outside/not-admitted.wav", "speed": 1.0}
            ).encode()
            status, response, headers = asyncio.run(
                asgi_request(
                    pocket.app,
                    "POST",
                    "/v1/audio/speech",
                    invalid_reference_body,
                    "application/json",
                )
            )
            self.assertEqual(status, 429)
            self.assertIn("busy", json.loads(response)["error"])
            self.assertIn((b"retry-after", b"1"), headers)
            release.set()
            first_status, first_response, _headers = active.result(timeout=1)
        self.assertEqual((first_status, first_response), (200, b"RIFF-ready"))

    def test_pocket_canonicalizes_cache_keys_and_requests_upstream_truncation(self) -> None:
        pocket = load_server("tts_pocket_server.py")

        class FakePocketModel:
            sample_rate = 24_000

            def __init__(self):
                self.calls = []

            def get_state_for_audio_prompt(self, conditioning, truncate=False):
                path = Path(conditioning)
                self.calls.append((path, path.read_bytes(), truncate))
                return object()

        model = FakePocketModel()
        pocket._model = model
        pocket._state_cache.clear()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "voices"
            voice_dir = root / "person"
            voice_dir.mkdir(parents=True)
            reference = voice_dir / "reference.wav"
            reference.write_bytes(pcm_wav())
            pocket._voice_root = root.resolve()
            canonical = str(reference.resolve())
            alias = str(voice_dir / ".." / "person" / "reference.wav")

            first = pocket._get_state(alias)
            second = pocket._get_state(canonical)

        self.assertIs(first, second)
        key = pocket._state_cache.keys()[0]
        self.assertEqual(key[:2], ("file", canonical))
        self.assertEqual(len(model.calls), 1)
        self.assertNotEqual(model.calls[0][0], Path(canonical))
        self.assertFalse(model.calls[0][0].exists())
        self.assertEqual(model.calls[0][1], pcm_wav())
        self.assertTrue(model.calls[0][2])

    def test_pocket_uses_an_immutable_validated_copy_and_invalidates_stale_state(self) -> None:
        pocket = load_server("tts_pocket_server.py")
        original_audio = pcm_wav()
        replacement_audio = bytearray(pcm_wav())
        replacement_audio[-2:] = b"\x01\x00"

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "voices"
            root.mkdir()
            reference = root / "reference.wav"
            reference.write_bytes(original_audio)
            pocket._voice_root = root

            class SwappingPocketModel:
                sample_rate = 24_000

                def __init__(self):
                    self.inputs: list[bytes] = []

                def get_state_for_audio_prompt(self, conditioning, truncate=False):
                    if not self.inputs:
                        # Swap the attacker-controlled source after validation
                        # but before Pocket reads its conditioning path.
                        reference.write_bytes(bytes(replacement_audio))
                    self.inputs.append(Path(conditioning).read_bytes())
                    return object()

            model = SwappingPocketModel()
            pocket._model = model
            pocket._state_cache.clear()
            first = pocket._get_state(str(reference))
            second = pocket._get_state(str(reference))

        self.assertEqual(model.inputs, [original_audio, bytes(replacement_audio)])
        self.assertIsNot(first, second)
        self.assertEqual(len(pocket._state_cache), 2)

    def test_real_numpy_soundfile_encoders_are_bounded_without_loading_models(self) -> None:
        np = importlib.import_module("numpy")
        sf = importlib.import_module("soundfile")

        pocket = load_server("tts_pocket_server.py")
        pocket.np = np
        pocket.sf = sf

        class FakePocketModel:
            sample_rate = 24_000
            samples = 240

            def get_state_for_audio_prompt(self, conditioning, truncate=False):
                self.conditioning = conditioning
                self.truncate = truncate
                return object()

            def generate_audio_stream(self, state, text):
                yield np.zeros(self.samples, dtype="float32")

        pocket_model = FakePocketModel()
        pocket._model = pocket_model
        pocket._state_cache.clear()
        pocket_wav = pocket._synthesize_wav("encoder smoke", "anna")
        self.assertEqual(pocket_wav[:4], b"RIFF")
        self.assertEqual(validate_pcm_wav_bytes(pocket_wav).sample_rate, 24_000)
        self.assertTrue(pocket_model.truncate)

        pocket_model.samples = 3
        with patch.object(pocket, "AudioSampleBudget", new=lambda: AudioSampleBudget(4_100)):
            with self.assertRaises(AudioOutputTooLargeError):
                pocket._synthesize_wav("bounded", "anna")

        kokoro = load_server("tts_kokoro_server.py")
        kokoro.np = np
        kokoro.sf = sf

        class FakeKokoroPipe:
            def __call__(self, text, voice, speed):
                yield SimpleNamespace(audio=np.zeros(240, dtype="float32"))

        kokoro._pipe = FakeKokoroPipe()
        kokoro_wav = kokoro._synthesize_wav("encoder smoke", "am_echo", 1.0)
        self.assertEqual(kokoro_wav[:4], b"RIFF")
        self.assertEqual(validate_pcm_wav_bytes(kokoro_wav).sample_rate, 24_000)


if __name__ == "__main__":
    unittest.main()
