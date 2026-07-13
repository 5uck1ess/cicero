"""
Pocket-TTS server for Cicero (Kyutai pocket-tts, Apache-2.0).

Fastest low-latency TTS on Apple Silicon in the local bench (~30-50ms TTFA,
~9x realtime on an M4). CPU-only; streaming-native; predefined voices need no
auth, and a wav path enables zero-shot cloning.

Exposes the same OpenAI-style surface the other Cicero TTS backends use, so the
TypeScript provider is a drop-in sibling of mlx-audio / kokoro:
    POST /v1/audio/speech  {input, voice, response_format} -> audio/wav bytes
    GET  /v1/models                                         -> {data: [...]}

Runs from the dedicated .venv-pocket (Python 3.11) — pocket-tts pins torch and
must stay isolated from the main .venv's MLX stack.
"""

from __future__ import annotations

import argparse
import io
from pathlib import Path

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, field_validator

from pocket_tts import TTSModel

from sidecar_limits import (
    AdmissionError,
    AudioOutputTooLargeError,
    AudioSampleBudget,
    BoundedLRUCache,
    MAX_POCKET_VOICE_STATES,
    MAX_TTS_JSON_BYTES,
    ModelGate,
    ModelGateError,
    RequestBodyLimitMiddleware,
    TTS_MODEL_INFERENCE_TIMEOUT_SECONDS,
    ensure_audio_output_limited,
    model_gate_pair,
    prepare_pocket_voice,
    validate_pocket_voice,
    validate_speed,
    validate_text,
)

app = FastAPI(title="Cicero Pocket-TTS")
app.add_middleware(
    RequestBodyLimitMiddleware,
    limits={"/v1/audio/speech": MAX_TTS_JSON_BYTES},
)

# Set at startup.
_model: TTSModel | None = None
_default_voice: str = "anna"
_voice_root = (Path.home() / ".cicero" / "voices").resolve(strict=False)
_allowed_voice_references: frozenset[Path] = frozenset()
# Building a voice state is non-trivial; cache one per voice/clip so repeat
# utterances skip straight to generation. The cap prevents arbitrary voice
# values from retaining an unbounded number of model states.
_state_cache: BoundedLRUCache[tuple[object, ...], object] = BoundedLRUCache(MAX_POCKET_VOICE_STATES)
_model_gate = ModelGate(timeout_seconds=TTS_MODEL_INFERENCE_TIMEOUT_SECONDS)


class SpeechRequest(BaseModel):
    input: str
    voice: str | None = None
    model: str | None = None
    response_format: str = "wav"
    speed: float = 1.0

    @field_validator("speed", mode="before")
    @classmethod
    def reject_boolean_speed(cls, value: object) -> object:
        if isinstance(value, bool):
            raise ValueError("speed must be a number, not a boolean")
        return value


def _get_state(voice: str) -> object:
    """Resolve (and cache) the generation state for a predefined voice name or
    a reference-wav path. Pocket-TTS accepts either."""
    if _model is None:
        raise RuntimeError("model not loaded")
    with prepare_pocket_voice(voice, _voice_root, _allowed_voice_references) as prepared:
        return _state_cache.get_or_create(
            prepared.cache_key,
            lambda: _model.get_state_for_audio_prompt(prepared.conditioning, truncate=True),
        )


def _synthesize_wav(text: str, voice: str) -> bytes:
    if _model is None:
        raise RuntimeError("model not loaded")
    sample_rate = int(_model.sample_rate)
    if sample_rate < 8_000 or sample_rate > 96_000:
        raise RuntimeError(f"invalid Pocket-TTS sample rate: {sample_rate}")
    state = _get_state(voice)
    budget = AudioSampleBudget()
    output = io.BytesIO()
    with sf.SoundFile(
        output,
        mode="w",
        samplerate=sample_rate,
        channels=1,
        format="WAV",
        subtype="PCM_16",
    ) as wav:
        for chunk in _model.generate_audio_stream(state, text):
            arr = chunk.numpy() if hasattr(chunk, "numpy") else np.asarray(chunk)
            arr = np.asarray(arr, dtype="float32").reshape(-1)
            budget.consume(int(arr.size))
            if arr.size and not np.isfinite(arr).all():
                raise RuntimeError("Pocket-TTS produced non-finite audio")
            wav.write(arr)
    return ensure_audio_output_limited(output.getvalue())


@app.get("/")
async def root():
    if _model is None or not _model_gate.healthy:
        return JSONResponse(
            {"status": "unhealthy", "error": _model_gate.unhealthy_reason or "model not loaded"},
            status_code=503,
        )
    return {"status": "ok"}


@app.get("/v1/models")
async def models():
    """Health/identity endpoint — mirrors the OpenAI /v1/models shape the
    TypeScript providers probe."""
    ready = _model is not None and _model_gate.healthy
    data = [{"id": "pocket-tts", "object": "model"}] if ready else []
    payload = {"object": "list", "data": data}
    if not ready:
        return JSONResponse(payload, status_code=503)
    return payload


@app.post("/v1/audio/speech")
def speech(req: SpeechRequest) -> Response:
    # Plain `def`: FastAPI runs blocking model work in its worker pool, while
    # ModelGate ensures the single Pocket runtime never sees overlapping calls.
    if _model is None:
        return JSONResponse({"error": "model not loaded"}, status_code=503)
    try:
        text = validate_text(req.input)
        # Reference files are resolved, copied, and fully validated inside the
        # model gate.  Scanning a 32 MiB reference here would let overlapping
        # rejected requests consume disk and CPU before admission.
        voice = req.voice or _default_voice
        speed = validate_speed(req.speed)
        if speed != 1.0:
            raise AdmissionError("Pocket-TTS does not support speed overrides; speed must be 1.0")
        if req.response_format.lower() != "wav":
            raise AdmissionError("response_format must be 'wav'")
    except AdmissionError as err:
        return JSONResponse({"error": str(err)}, status_code=err.status_code)

    try:
        audio = _model_gate.run(_synthesize_wav, text, voice)
    except ModelGateError as err:
        headers = {"Retry-After": "1"} if err.status_code == 429 else None
        return JSONResponse({"error": str(err)}, status_code=err.status_code, headers=headers)
    except AdmissionError as err:
        return JSONResponse({"error": str(err)}, status_code=err.status_code)
    except AudioOutputTooLargeError as err:
        return JSONResponse({"error": str(err)}, status_code=err.status_code)
    except Exception as err:  # unknown voice / bad clip / generation failure
        return JSONResponse(
            {"error": f"Pocket-TTS synthesis failed for voice '{voice}': {err}"},
            status_code=500,
        )
    return Response(content=audio, media_type="audio/wav")


def main() -> None:
    parser = argparse.ArgumentParser(description="Pocket-TTS server for Cicero")
    parser.add_argument("--port", type=int, default=8082)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--voice", type=str, default="anna", help="Default voice name")
    parser.add_argument(
        "--voice-root",
        type=str,
        default=str(Path.home() / ".cicero" / "voices"),
        help="Trusted root containing provisioned local reference WAVs",
    )
    parser.add_argument(
        "--allow-voice-reference",
        action="append",
        default=[],
        help="Additional exact local reference WAV allowed outside --voice-root",
    )
    parser.add_argument(
        "--language",
        type=str,
        default="en",
        help="Language config (en/fr/de/it/pt/es)",
    )
    parser.add_argument(
        "--inference-timeout",
        type=float,
        default=TTS_MODEL_INFERENCE_TIMEOUT_SECONDS,
        help="Native inference watchdog deadline in seconds",
    )
    args = parser.parse_args()

    language_config = {
        "en": "english_2026-04",
        "fr": "french_24l",
        "de": "german_24l",
        "it": "italian_24l",
        "pt": "portuguese_24l",
        "es": "spanish_24l",
    }

    global _model, _default_voice, _voice_root, _allowed_voice_references, _model_gate
    warmup_gate, request_gate = model_gate_pair(
        args.inference_timeout,
        TTS_MODEL_INFERENCE_TIMEOUT_SECONDS,
    )
    _model_gate = warmup_gate
    _voice_root = Path(args.voice_root).expanduser().resolve(strict=False)
    _allowed_voice_references = frozenset(
        Path(reference).expanduser().resolve(strict=False)
        for reference in args.allow_voice_reference
    )
    try:
        _default_voice = validate_pocket_voice(
            args.voice,
            _voice_root,
            _allowed_voice_references,
        )
    except AdmissionError as err:
        parser.error(str(err))
    _state_cache.clear()
    if args.language == "en":
        _model = TTSModel.load_model()
    else:
        _model = TTSModel.load_model(language=language_config.get(args.language, language_config["en"]))

    # Prebuild the default voice state so the first request is warm.
    _model_gate.run(_get_state, _default_voice)

    _model_gate = request_gate
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
