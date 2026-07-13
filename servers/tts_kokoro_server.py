"""Kokoro-82M server for Cicero (hexgrad/Kokoro-82M, Apache-2.0).

The cross-platform voice for Cicero: real-time on CUDA (~33-83ms/sentence warm,
38-141x realtime on a 3090 in the local bench), CPU, and Apple MPS, with ~50
preset voices. This server runs the PyTorch `KPipeline` path that the bench
measured, so production latency matches the benchmark rather than an unrelated
kokoro server's config.

Runs from a dedicated `.venv-kokoro` (Python 3.11, torch+cuXXX) — kokoro pins its
own torch, kept isolated from the main `.venv` MLX stack (same pattern as
`.venv-pocket`).

Exposes the OpenAI-style surface the other Cicero TTS backends use, so the
TypeScript provider (src/backends/tts/kokoro.ts) is a drop-in sibling of
pocket / mlx-audio:
    POST /v1/audio/speech  {input, voice, response_format} -> audio/wav bytes
    GET  /v1/models                                        -> {data: [...]}

CRITICAL — pre-warm: on GPU, kokoro's first inference pays a large one-time
CUDA autotune/JIT cost (~670ms cold vs ~33ms warm on the 3090 bench). This
server fires a throwaway generation at startup BEFORE reporting ready, so the
model is primed and health only goes green once warm. Holding weights alone is
not enough on the GPU path.
"""

from __future__ import annotations

import argparse
import io
import sys

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, field_validator

from kokoro import KPipeline

from sidecar_limits import (
    AdmissionError,
    AudioOutputTooLargeError,
    AudioSampleBudget,
    MAX_TTS_JSON_BYTES,
    ModelGate,
    ModelGateError,
    RequestBodyLimitMiddleware,
    TTS_MODEL_INFERENCE_TIMEOUT_SECONDS,
    ensure_audio_output_limited,
    model_gate_pair,
    validate_speed,
    validate_text,
    validate_voice_id,
)

app = FastAPI(title="Cicero Kokoro-TTS")
app.add_middleware(
    RequestBodyLimitMiddleware,
    limits={"/v1/audio/speech": MAX_TTS_JSON_BYTES},
)

# Set at startup.
_pipe: KPipeline | None = None
_default_voice: str = "am_echo"  # Cicero persona voice
_sample_rate: int = 24000  # Kokoro fixed output rate
_model_gate = ModelGate(timeout_seconds=TTS_MODEL_INFERENCE_TIMEOUT_SECONDS)

# Kokoro single-letter language codes.
LANG_CODE = {
    "en": "a",  # American English
    "en-gb": "b",
    "es": "e",
    "fr": "f",
    "hi": "h",
    "it": "i",
    "ja": "j",
    "pt": "p",
    "zh": "z",
}


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


def _synthesize_wav(text: str, voice: str, speed: float) -> bytes:
    """Run KPipeline and encode chunks under Cicero's 64 MiB audio ceiling."""
    if _pipe is None:
        raise RuntimeError("model not loaded")
    budget = AudioSampleBudget()
    output = io.BytesIO()
    with sf.SoundFile(
        output,
        mode="w",
        samplerate=_sample_rate,
        channels=1,
        format="WAV",
        subtype="PCM_16",
    ) as wav:
        for result in _pipe(text, voice=voice, speed=speed):
            audio = result.audio
            if audio is None:
                continue
            arr = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
            arr = np.asarray(arr, dtype="float32").reshape(-1)
            budget.consume(int(arr.size))
            if arr.size and not np.isfinite(arr).all():
                raise RuntimeError("Kokoro produced non-finite audio")
            wav.write(arr)
    return ensure_audio_output_limited(output.getvalue())


@app.get("/")
async def root():
    if _pipe is None or not _model_gate.healthy:
        return JSONResponse(
            {"status": "unhealthy", "error": _model_gate.unhealthy_reason or "model not loaded"},
            status_code=503,
        )
    return {"status": "ok"}


@app.get("/v1/models")
async def models():
    """Health/identity endpoint — mirrors the OpenAI /v1/models shape the
    TypeScript providers probe. Only ready once the warmup generation is done."""
    ready = _pipe is not None and _model_gate.healthy
    data = [{"id": "kokoro", "object": "model"}] if ready else []
    payload = {"object": "list", "data": data}
    if not ready:
        return JSONResponse(payload, status_code=503)
    return payload


@app.post("/v1/audio/speech")
def speech(req: SpeechRequest) -> Response:
    # Plain `def` (not async): FastAPI runs it in a threadpool, so the blocking
    # KPipeline inference doesn't stall the event loop (health probes stay live).
    if _pipe is None:
        return JSONResponse({"error": "model not loaded"}, status_code=503)
    try:
        text = validate_text(req.input)
        voice = validate_voice_id(req.voice or _default_voice)
        speed = validate_speed(req.speed)
        if req.response_format.lower() != "wav":
            raise AdmissionError("response_format must be 'wav'")
    except AdmissionError as err:
        return JSONResponse({"error": str(err)}, status_code=err.status_code)

    try:
        audio = _model_gate.run(_synthesize_wav, text, voice, speed)
    except ModelGateError as err:
        headers = {"Retry-After": "1"} if err.status_code == 429 else None
        return JSONResponse({"error": str(err)}, status_code=err.status_code, headers=headers)
    except AudioOutputTooLargeError as err:
        return JSONResponse({"error": str(err)}, status_code=err.status_code)
    except Exception as err:  # unknown voice / generation failure
        # Return the real cause as JSON — a bare raise turns into an opaque 500
        # "Internal Server Error" and the client can't tell a bad voice from a crash.
        return JSONResponse(
            {"error": f"kokoro synthesis failed for voice '{voice}': {err}"},
            status_code=500,
        )

    return Response(content=audio, media_type="audio/wav")


def main() -> None:
    parser = argparse.ArgumentParser(description="Kokoro-TTS server for Cicero")
    parser.add_argument("--port", type=int, default=8082)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--voice", type=str, default="am_echo", help="Default Kokoro voice id")
    parser.add_argument("--language", type=str, default="en", help="Language code (en/en-gb/es/fr/it/ja/pt/zh/hi)")
    parser.add_argument("--device", type=str, default="auto", help="cuda | cpu | mps | auto")
    parser.add_argument(
        "--inference-timeout",
        type=float,
        default=TTS_MODEL_INFERENCE_TIMEOUT_SECONDS,
        help="Native inference watchdog deadline in seconds",
    )
    args = parser.parse_args()

    device = args.device
    if device == "auto":
        try:
            import torch

            device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
        except Exception:
            device = "cpu"

    lang_code = LANG_CODE.get(args.language, "a")

    global _pipe, _default_voice, _model_gate
    warmup_gate, request_gate = model_gate_pair(
        args.inference_timeout,
        TTS_MODEL_INFERENCE_TIMEOUT_SECONDS,
    )
    _model_gate = warmup_gate
    try:
        _default_voice = validate_voice_id(args.voice)
    except AdmissionError as err:
        parser.error(str(err))
    _pipe = KPipeline(lang_code=lang_code, repo_id="hexgrad/Kokoro-82M", device=device)

    # Pre-warm: fire a throwaway generation so the CUDA kernels autotune/JIT and
    # the voice tensor loads BEFORE we start serving. On GPU this is the
    # difference between ~670ms and ~33ms on the first real utterance.
    # A warmup failure means every real request would fail the same way (bad
    # voice, broken CUDA), so die loudly now — the daemon watches for early exit
    # and surfaces this traceback instead of reporting a healthy-but-dead server.
    try:
        _model_gate.run(_synthesize_wav, "Ready.", _default_voice, 1.0)
    except Exception:
        import traceback

        traceback.print_exc()
        print(f"[kokoro] FATAL: warmup synthesis failed (voice '{_default_voice}')", flush=True)
        sys.exit(1)

    _model_gate = request_gate
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
