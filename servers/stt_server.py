"""
MLX Whisper STT server for Cicero.

Drop-in replacement for whisper-cpp's whisper-server.
Accepts POST /inference with multipart form data (file + optional prompt),
returns JSON {"text": "transcribed text"}.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile

import mlx_whisper
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
import uvicorn

from sidecar_limits import (
    AdmissionError,
    MAX_AUDIO_UPLOAD_BYTES,
    MAX_MULTIPART_BODY_BYTES,
    MAX_TRANSCRIPT_CHARS,
    ModelGate,
    ModelGateError,
    RequestBodyLimitMiddleware,
    STT_MODEL_INFERENCE_TIMEOUT_SECONDS,
    copy_upload_to_file_limited,
    model_gate_pair,
    validate_pcm_wav,
    validate_prompt,
)

app = FastAPI(title="Cicero MLX Whisper STT")
app.add_middleware(
    RequestBodyLimitMiddleware,
    limits={"/inference": MAX_MULTIPART_BODY_BYTES},
)

# Global state set at startup
_model_path: str = "mlx-community/whisper-large-v3-turbo"
_model_gate = ModelGate(timeout_seconds=STT_MODEL_INFERENCE_TIMEOUT_SECONDS)
_ready = False


def clean_transcript(text: str) -> str:
    """Strip timestamps and annotations from whisper output."""
    text = re.sub(r"\[.*?\]", "", text)   # [00:00.000 --> 00:02.000] etc.
    text = re.sub(r"\(.*?\)", "", text)    # (gentle music) etc.
    return text.strip()


def bounded_transcript(text: object) -> str:
    if not isinstance(text, str):
        raise RuntimeError("transcription returned invalid text")
    if len(text) > MAX_TRANSCRIPT_CHARS:
        raise RuntimeError("transcription text is too long")
    return clean_transcript(text)


def _validate_wav_path(path: str) -> None:
    with open(path, "rb") as uploaded:
        validate_pcm_wav(uploaded)


@app.get("/")
async def health():
    """Health check endpoint — matches whisper-server convention."""
    if not _ready or not _model_gate.healthy:
        return JSONResponse(
            {"status": "unhealthy", "error": _model_gate.unhealthy_reason or "model not warmed"},
            status_code=503,
        )
    return {"status": "ok"}


@app.post("/inference")
async def inference(
    file: UploadFile = File(...),
    prompt: str = Form(default=""),
    response_format: str = Form(default="json"),
):
    """
    Transcribe an audio file using MLX Whisper.

    Compatible with whisper-server's /inference endpoint:
    - Accepts multipart form with 'file' (WAV audio)
    - Returns {"text": "transcribed text"}
    """
    if not _ready:
        return JSONResponse({"error": "model not warmed"}, status_code=503)
    tmp_path: str | None = None
    try:
        try:
            validate_prompt(prompt)
            # The wire contract is WAV. Keeping a fixed suffix also prevents an
            # attacker-controlled filename from becoming an oversized suffix.
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp_path = tmp.name
                size = await copy_upload_to_file_limited(file, tmp, MAX_AUDIO_UPLOAD_BYTES)
            if size == 0:
                raise AdmissionError("empty audio")
            # Float-sample and full-RIFF scans can touch the entire bounded
            # upload; keep them off the event loop with the model work.
            await run_in_threadpool(_validate_wav_path, tmp_path)
        except AdmissionError as err:
            return JSONResponse(
                {"error": str(err)},
                status_code=err.status_code,
                headers={"Connection": "close"} if err.status_code == 413 else None,
            )
        except Exception as err:
            return JSONResponse({"error": f"audio upload failed: {err}"}, status_code=400)

        try:
            result = await run_in_threadpool(
                _model_gate.run,
                mlx_whisper.transcribe,
                tmp_path,
                path_or_hf_repo=_model_path,
                language="en",
                initial_prompt=prompt or None,
            )
        except ModelGateError as err:
            headers = {"Retry-After": "1"} if err.status_code == 429 else None
            return JSONResponse({"error": str(err)}, status_code=err.status_code, headers=headers)
        except Exception as err:
            return JSONResponse({"error": f"transcription failed: {err}"}, status_code=500)

        try:
            text = bounded_transcript(result.get("text", ""))
        except RuntimeError as err:
            return JSONResponse({"error": str(err)}, status_code=500)

        return JSONResponse({"text": text})
    finally:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _warmup() -> bool:
    """Pre-load the model so the first real transcription isn't a cold start.

    mlx_whisper caches the loaded weights, so one throwaway call on silence pays
    the load cost up front instead of on the user's first utterance.
    """
    global _ready
    _ready = False
    try:
        import numpy as np

        silence = np.zeros(16000, dtype=np.float32)  # 1s @ 16kHz
        _model_gate.run(
            mlx_whisper.transcribe,
            silence,
            path_or_hf_repo=_model_path,
            language="en",
        )
        _ready = True
        print(f"[stt] warmed up {_model_path}", flush=True)
        return True
    except Exception as err:
        print(f"[stt] warmup failed: {err}", flush=True)
        return False


def main():
    parser = argparse.ArgumentParser(description="MLX Whisper STT server for Cicero")
    parser.add_argument("--port", type=int, default=8083, help="Port to listen on")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to")
    parser.add_argument(
        "--model",
        type=str,
        default="mlx-community/whisper-large-v3-turbo",
        help="HuggingFace model ID or local path",
    )
    parser.add_argument(
        "--inference-timeout",
        type=float,
        default=STT_MODEL_INFERENCE_TIMEOUT_SECONDS,
        help="Native inference watchdog deadline in seconds",
    )
    args = parser.parse_args()

    global _model_path, _model_gate
    _model_path = args.model
    warmup_gate, request_gate = model_gate_pair(
        args.inference_timeout,
        STT_MODEL_INFERENCE_TIMEOUT_SECONDS,
    )
    _model_gate = warmup_gate

    if not _warmup():
        print("[stt] FATAL: warmup transcription failed", file=sys.stderr, flush=True)
        sys.exit(1)
    _model_gate = request_gate
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
